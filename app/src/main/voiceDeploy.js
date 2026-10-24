// 本地离线语音（NVSA + 晓晓 / 云希）一键部署状态机。
//
// 目标：低视力用户第一次打开软件，点一次「一键安装离线语音」，之后朗读全程离线。
// 设计约束（与项目基线一致，改动前请先读）：
//   1. 最多一次 UAC：NetFx3（仅当 .NET 3.5 缺失时）与 regsvr32 合并进**同一个**提权脚本，
//      用户只会在最开始看到一次「是否允许此应用对你的设备进行更改」。
//   2. 任何 FAILED 都不等于应用不可用：Edge 在线兜底始终完整，失败必须播报「为什么 + 下一步」。
//   3. 幂等 + 可重入：每一步都先看现状再动手（已下载/已解压/已注册/已配置就跳过），
//      中途失败后再次 install() 从断点继续，不重复下载 140MB、不重复弹 UAC。
//   4. 不阻塞热键路径：本模块只被用户显式触发（或首启检测），任何探测都不在朗读链路上。
//
// 状态机（完整分支见交付回执「状态机分支清单」）：
//   IDLE → DETECTING → READY
//                    ├→ INSTALLING_NETFX3（.NET 3.5 缺失：与注册合并为一次授权）
//                    ├→ DOWNLOADING → EXTRACTING → REGISTERING → WRITING_CONFIG → VERIFYING → READY
//                    └→ FAILED_DOWNLOAD / FAILED_NETFX3 / FAILED_ELEVATION /
//                       FAILED_REGISTER / FAILED_EXTRACT / FAILED_VERIFY
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const S = require('./voicePackSources');
const { extractAll } = require('./zipUtils');
const { readNvsaConfig } = require('./backends/sapiBackend');
const { pickSapiVoices } = require('./backends/voiceCatalog');

const STATES = {
  IDLE: 'IDLE',
  DETECTING: 'DETECTING',
  READY: 'READY',
  INSTALLING_NETFX3: 'INSTALLING_NETFX3',
  DOWNLOADING: 'DOWNLOADING',
  EXTRACTING: 'EXTRACTING',
  REGISTERING: 'REGISTERING',
  WRITING_CONFIG: 'WRITING_CONFIG',
  VERIFYING: 'VERIFYING',
  FAILED_DOWNLOAD: 'FAILED_DOWNLOAD',
  FAILED_NETFX3: 'FAILED_NETFX3',
  FAILED_ELEVATION: 'FAILED_ELEVATION',
  FAILED_REGISTER: 'FAILED_REGISTER',
  FAILED_EXTRACT: 'FAILED_EXTRACT',
  FAILED_VERIFY: 'FAILED_VERIFY',
};

const FAILED_STATES = [
  STATES.FAILED_DOWNLOAD,
  STATES.FAILED_NETFX3,
  STATES.FAILED_ELEVATION,
  STATES.FAILED_REGISTER,
  STATES.FAILED_EXTRACT,
  STATES.FAILED_VERIFY,
];

const BUSY_STATES = [
  STATES.DETECTING,
  STATES.INSTALLING_NETFX3,
  STATES.DOWNLOADING,
  STATES.EXTRACTING,
  STATES.REGISTERING,
  STATES.WRITING_CONFIG,
  STATES.VERIFYING,
];

/** 失败码 → 失败态 */
const CODE_TO_STATE = {
  [S.VP_ERRORS.NETWORK]: STATES.FAILED_DOWNLOAD,
  [S.VP_ERRORS.EXTRACT]: STATES.FAILED_EXTRACT,
  [S.VP_ERRORS.ELEVATION_DENIED]: STATES.FAILED_ELEVATION,
  [S.VP_ERRORS.NETFX3]: STATES.FAILED_NETFX3,
  [S.VP_ERRORS.REGISTER]: STATES.FAILED_REGISTER,
  [S.VP_ERRORS.CONFIG]: STATES.FAILED_REGISTER, // 配置写不进注册表 = 注册环节没完成
  [S.VP_ERRORS.VERIFY_FAILED]: STATES.FAILED_VERIFY,
};

const PS = process.env.LDN_SAPI_PS || 'powershell.exe';
const REG_KEY_PS = 'HKCU:\\Software\\NaturalVoiceSAPIAdapter\\Enumerator';
const MARKER = '.registered';
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 历史常量（保留兼容），实际以 stall/total 为准
// 慢网实战修正（本机实测：镜像 102KB/s、语音包源 55KB/s）：
//   原来的实现是「5 分钟总超时 + 每次重试 rmSync 从头下」，于是 56MB 语音包必然超时失败，
//   永远装不上。改为两个正交的超时：① 连续 45s 没有任何字节进来才算断流（stall）；
//   ② 单文件总时限 60 分钟，仅用于防永久挂起。配合断点续传（Range），慢网也能装完。
const DOWNLOAD_STALL_MS = 45 * 1000;
const DOWNLOAD_TOTAL_MS = 60 * 60 * 1000;
const DOWNLOAD_ROUNDS = 2; // 每个 URL 最多试 2 轮（瞬时断流可自愈）
const DEFAULT_NEXT_STEP = '在线语音可以继续使用；稍后点「重试」会从断点继续，已下载的部分不会重下。';

// ---------------------------------------------------------------- 基础工具

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return -1;
  }
}

function dirHasFiles(p) {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
  } catch (e) {
    return false;
  }
}

function isAsciiPath(p) {
  return /^[\x20-\x7E]*$/.test(String(p || ''));
}

/** PowerShell 单引号字符串转义（路径里可能有单引号） */
function psQuote(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;
}

function tail(s, n = 300) {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(-n) : t;
}

function readJsonFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** 等待可写流的 drain（同时把 error 变成拒绝，避免磁盘写满时永久挂起） */
function waitDrain(ws) {
  return new Promise((resolve, reject) => {
    const onDrain = () => {
      ws.removeListener('error', onError);
      resolve();
    };
    const onError = (e) => {
      ws.removeListener('drain', onDrain);
      reject(e);
    };
    ws.once('drain', onDrain);
    ws.once('error', onError);
  });
}

/** 默认 userData：仅在 Electron 主进程里可用；纯 Node（探针脚本）下退回 %APPDATA% */
function defaultUserDataPath() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    /* 非 Electron 环境 */
  }
  return path.join(process.env.APPDATA || os.homedir(), 'langdu-nv-neo');
}

function cliWorkDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'langdu-nv', 'voice-pack');
}

/** 目录里是否已有本状态机（或 register-nvsa.ps1）留下的装配痕迹 */
function hasLayout(dir) {
  try {
    if (fs.existsSync(path.join(dir, 'engine', MARKER))) return true;
    if (fs.existsSync(path.join(dir, 'engine', 'x64', 'NaturalVoiceSAPIAdapter.dll'))) return true;
    const voices = path.join(dir, 'voices');
    if (fs.existsSync(voices)) {
      return fs.readdirSync(voices).some((n) => dirHasFiles(path.join(voices, n)));
    }
  } catch (e) {
    /* 目录不可读 */
  }
  return false;
}

// ---------------------------------------------------------------- 主类

class VoiceDeploy {
  /**
   * @param {object} [opts]
   * @param {string} [opts.workDir] 覆盖落地目录（默认 userData/voice-pack；非 ASCII 时退到 %LOCALAPPDATA%\langdu-nv\voice-pack）
   * @param {string} [opts.userDataPath] 注入 userData（测试用，避免依赖 Electron）
   * @param {(p:{text:string, priority?:'high'|'normal'})=>Promise<any>} [opts.announce] 语音播报（默认走 a11yFeedback）
   * @param {(snapshot:object)=>void} [opts.emit] 状态变化外发（IPC 广播用，默认空实现）
   * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
   */
  constructor(opts = {}) {
    const o = opts || {};
    this._workDirOverride = o.workDir ? path.resolve(o.workDir) : null;
    this._userData = o.userDataPath ? path.resolve(o.userDataPath) : null;
    this._announceImpl = o.announce || null;
    this._emitImpl = o.emit || null;
    this._fetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    const resolved = this._resolveWorkDir();
    this.workDir = resolved.dir;
    this.workDirSource = resolved.source;

    this._busy = false;
    this._children = new Set();
    this._listeners = new Set();
    this._ready = false;
    this._checks = null;
    this._snapshot = {
      state: STATES.IDLE,
      pct: 0,
      label: '尚未检测本地语音环境',
      error: null,
      at: Date.now(),
    };

    // 主进程退出时必须带走所有可能残留的 powershell（UAC 提权那一支是 -Wait，正常会自己结束）
    this._exitHandler = () => this._killChildren();
    process.once('exit', this._exitHandler);
  }

  // ---- 路径 ----

  _resolveWorkDir() {
    if (this._workDirOverride) return { dir: this._workDirOverride, source: 'override' };
    const cli = cliWorkDir();
    // 兼容「先跑 scripts/register-nvsa.ps1 再打开应用」：直接沿用同一落地目录，不重复下载
    if (hasLayout(cli)) return { dir: cli, source: 'cli-layout' };
    const userData = this._userData || defaultUserDataPath();
    const ud = path.join(userData, 'voice-pack');
    // NVSA 对非 ASCII 路径不友好（register-nvsa.ps1 第 22 行同款警告）；
    // 「朗读女 Neo」的 userData 默认含中文，故此时退到纯 ASCII 的 %LOCALAPPDATA%\langdu-nv\voice-pack
    if (isAsciiPath(ud)) return { dir: ud, source: 'userData' };
    return { dir: cli, source: 'ascii-fallback' };
  }

  get engineDir() {
    return path.join(this.workDir, 'engine');
  }

  get voicesDir() {
    return path.join(this.workDir, 'voices');
  }

  get engineDllPath() {
    return path.join(this.engineDir, S.NVSA.engineDllRelPath.replace(/\//g, path.sep));
  }

  get deployTmpDir() {
    return path.join(this.workDir, '.deploy');
  }

  get markerPath() {
    return path.join(this.engineDir, MARKER);
  }

  // ---- 状态 ----

  get state() {
    return this._snapshot.state;
  }

  get busy() {
    return this._busy;
  }

  get ready() {
    return this._ready;
  }

  /** UI / IPC 用快照（只读副本） */
  getSnapshot() {
    return {
      ...this._snapshot,
      busy: this._busy,
      ready: this._ready,
      workDir: this.workDir,
      workDirSource: this.workDirSource,
      checks: this._checks,
      failed: FAILED_STATES.indexOf(this._snapshot.state) >= 0,
    };
  }

  /** 订阅状态变化（IPC 广播用）；返回取消订阅函数 */
  onStateChanged(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _setState(state, pct, label, extra) {
    const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this._snapshot = {
      state,
      pct: p,
      label: String(label || ''),
      error: (extra && extra.error) || null,
      at: Date.now(),
    };
    const snap = this.getSnapshot();
    for (const cb of this._listeners) {
      try {
        cb(snap);
      } catch (e) {
        /* 监听器异常不影响主流程 */
      }
    }
    if (this._emitImpl) {
      try {
        this._emitImpl(snap);
      } catch (e) {
        /* 外发失败不影响主流程 */
      }
    }
    return snap;
  }

  async _announce(text, priority) {
    if (!text) return;
    try {
      if (this._announceImpl) {
        await this._announceImpl({ text: String(text), priority: priority || 'normal' });
        return;
      }
      // 默认播报实现：主进程内可用；纯 Node 环境下 require 会失败，直接跳过（不阻断部署）
      // eslint-disable-next-line global-require
      const a11y = require('./a11yFeedback');
      await a11y.announce({ text: String(text), priority: priority || 'normal' });
    } catch (e) {
      /* 播报失败绝不影响部署本身 */
    }
  }

  /** 注册表里的配置变化后，广播 voice:statusChanged（ipc.js 已订阅 voiceSetup.onStatusChanged） */
  _broadcastVoiceStatus() {
    try {
      // eslint-disable-next-line global-require
      const voiceSetup = require('./voiceSetup');
      if (voiceSetup && typeof voiceSetup.broadcastStatus === 'function') voiceSetup.broadcastStatus();
    } catch (e) {
      /* 非主进程环境 / 模块未就绪 */
    }
  }

  // ---- PowerShell 调用 ----

  _track(child) {
    if (!child) return;
    this._children.add(child);
    const drop = () => this._children.delete(child);
    child.once('exit', drop);
    child.once('error', drop);
  }

  _killChildren() {
    for (const c of Array.from(this._children)) {
      try {
        c.kill();
      } catch (e) {
        /* 已退出 */
      }
    }
    this._children.clear();
  }

  /**
   * 跑一段 PowerShell（-EncodedCommand：不落盘、不受执行策略限制、天然支持非 ASCII）。
   * @returns {Promise<{stdout:string, stderr:string}>}
   */
  _ps(script, timeoutMs) {
    return new Promise((resolve, reject) => {
      const enc = Buffer.from(String(script), 'utf16le').toString('base64');
      let child;
      try {
        child = execFile(
          PS,
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
          { windowsHide: true, timeout: timeoutMs || 20000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              err.stdout = String(stdout || '');
              err.stderr = String(stderr || '');
              reject(err);
            } else {
              resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
            }
          }
        );
      } catch (e) {
        reject(e);
        return;
      }
      this._track(child);
    });
  }

  // ---------------------------------------------------------------- 检测（DETECTING 四项）

  /**
   * 四项检测（只读、无网络、无提权）：
   *   1. System.Speech 可用性（新 PowerShell 进程 Add-Type -AssemblyName System.Speech）
   *   2. NVSA 注册表（复用 sapiBackend.readNvsaConfig）
   *   3. 引擎文件（voice-pack 目录：x64 DLL + 两个语音目录）
   *   4. 发音人枚举（新进程枚举，找 Xiaoxiao / Yunxi）
   */
  async detect(opts) {
    const o = opts || {};
    // 安装进行中不打断状态机（UI 轮询/挂载时的检测不能把进度条打回 0）
    if (this._busy) return this.getSnapshot();
    this._setState(STATES.DETECTING, 0, '正在检测本地语音环境…');
    const checks = await this._detectPass();
    this._checks = checks;
    if (checks.ready) {
      this._ready = true;
      this._setState(STATES.READY, 100, '本地离线语音已就绪');
      if (o.announce) await this._announce('本地离线语音已就绪，晓晓和云希都能离线朗读。');
    } else {
      this._ready = false;
      // 上次失败的原因要留给用户看（不被一次普通检测抹掉），只在非失败态回落 IDLE
      if (FAILED_STATES.indexOf(this._snapshot.state) >= 0) {
        this._setState(this._snapshot.state, this._snapshot.pct, checks.summary, { error: this._snapshot.error });
      } else {
        this._setState(STATES.IDLE, 0, checks.summary);
      }
    }
    return this.getSnapshot();
  }

  async _detectPass() {
    const systemSpeech = await this._probeSystemSpeech();
    const registry = this._probeRegistry();
    const files = this._probeFiles();
    const voices = systemSpeech.ok
      ? await this._probeVoices()
      : { ok: false, names: [], matched: [], message: '系统缺少 .NET Framework 3.5（System.Speech 不可用）' };

    const matchedKeys = (voices.matched || []).map((v) => v.key);
    const ready = systemSpeech.ok && files.ok && matchedKeys.length === 2;
    const missing = [];
    if (!systemSpeech.ok) missing.push('netfx3');
    if (!files.ok) missing.push('files');
    if (matchedKeys.length < 2) missing.push('voices');

    let summary = '尚未安装离线语音';
    if (ready) summary = '本地离线语音已就绪';
    else if (!systemSpeech.ok) summary = '系统缺少语音组件（.NET Framework 3.5），可以一键安装';
    else if (!files.ok) summary = '尚未下载离线语音组件（约 138 MB）';
    else summary = '离线语音组件已就位，但系统还没识别到晓晓 / 云希';

    return { systemSpeech, registry, files, voices, matchedKeys, ready, missing, summary, at: Date.now() };
  }

  async _probeSystemSpeech() {
    const t0 = Date.now();
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'Add-Type -AssemblyName System.Speech',
      'if ($null -eq (New-Object System.Speech.Synthesis.SpeechSynthesizer)) { exit 3 }',
      "[Console]::Out.WriteLine('SYSTEM_SPEECH_OK')",
    ].join('\n');
    try {
      const { stdout } = await this._ps(script, 25000);
      const ok = stdout.indexOf('SYSTEM_SPEECH_OK') >= 0;
      return { ok, ms: Date.now() - t0, message: ok ? 'System.Speech 可用' : 'System.Speech 探测无输出' };
    } catch (e) {
      return {
        ok: false,
        ms: Date.now() - t0,
        message: `System.Speech 不可用：${tail(e.stderr || e.message, 200) || '未知原因'}`,
      };
    }
  }

  _probeRegistry() {
    const cfg = readNvsaConfig();
    if (!cfg) return { status: 'UNKNOWN', config: null, message: '注册表读取失败（可能被安全策略拦截）' };
    const present = !!(cfg.narratorVoicePath || cfg.narratorVoicePathExists);
    return {
      status: present ? 'PRESENT' : 'ABSENT',
      config: cfg,
      message: present
        ? `NVSA 已配置（NarratorVoicePath=${cfg.narratorVoicePath || '(空)'}）`
        : 'NVSA 注册表键不存在（未注册）',
    };
  }

  _probeFiles() {
    const dll = this.engineDllPath;
    const engineOk = fs.existsSync(dll);
    const packs = S.VOICE_PACKS.map((p) => {
      const dir = path.join(this.voicesDir, S.msixDirName(p));
      return { id: p.id, displayName: p.displayName, dir, ok: dirHasFiles(dir) };
    });
    const ok = engineOk && packs.every((p) => p.ok);
    return {
      ok,
      engineDll: dll,
      engineOk,
      packs,
      marker: fs.existsSync(this.markerPath),
      message: ok
        ? '引擎文件与语音包已就位'
        : !engineOk
          ? `缺少引擎 DLL：${dll}`
          : `语音包不完整：${packs.filter((p) => !p.ok).map((p) => p.displayName).join('、')}`,
    };
  }

  async _probeVoices() {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      'try { Add-Type -AssemblyName System.Speech } catch { [Console]::Out.WriteLine(\'{"ok":false,"error":"NO_SYSTEM_SPEECH"}\'); exit 0 }',
      '$list = New-Object System.Collections.ArrayList',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try {',
      '  foreach ($v in $s.GetInstalledVoices()) { [void]$list.Add([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($v.VoiceInfo.Name))) }',
      '} finally { try { $s.Dispose() } catch { } }',
      "[Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; names = $list.ToArray() } -Compress))",
    ].join('\n');
    try {
      const { stdout } = await this._ps(script, 25000);
      const line = String(stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('{'))
        .pop();
      const j = line ? JSON.parse(line) : null;
      if (!j || j.ok === false) {
        return {
          ok: false,
          names: [],
          matched: [],
          message: j && j.error === 'NO_SYSTEM_SPEECH' ? '系统缺少 .NET Framework 3.5' : '语音枚举失败',
        };
      }
      const raw = Array.isArray(j.names) ? j.names : j.names ? [j.names] : [];
      const names = raw
        .map((b) => {
          try {
            return Buffer.from(String(b), 'base64').toString('utf8');
          } catch (e) {
            return '';
          }
        })
        .filter(Boolean);
      const matched = pickSapiVoices(names);
      return {
        ok: matched.length === 2,
        names,
        matched,
        message: matched.length
          ? `已识别：${matched.map((m) => m.name).join('、')}`
          : `系统语音共 ${names.length} 个（${names.slice(0, 4).join('、')}），未见到晓晓 / 云希`,
      };
    } catch (e) {
      return { ok: false, names: [], matched: [], message: `语音枚举失败：${tail(e.message, 200)}` };
    }
  }

  // ---------------------------------------------------------------- 安装主流程

  /**
   * 一键部署（幂等、可重入）。并发调用直接返回 DEPLOY_BUSY。
   * @returns {Promise<{ok:boolean, state:string, error?:{code:string,message:string,nextStep:string}, snapshot:object}>}
   */
  async install() {
    if (this._busy) {
      return {
        ok: false,
        code: 'DEPLOY_BUSY',
        state: this.state,
        message: '离线语音正在安装中，请稍候。',
        snapshot: this.getSnapshot(),
      };
    }
    this._busy = true;
    try {
      const res = await this._installInner();
      return { ...res, snapshot: this.getSnapshot() };
    } catch (e) {
      return { ...this._failFrom(e), snapshot: this.getSnapshot() };
    } finally {
      this._busy = false;
    }
  }

  async _installInner() {
    // 1) DETECTING
    this._setState(STATES.DETECTING, 1, '正在检测本地语音环境…');
    const det = await this._detectPass();
    this._checks = det;
    if (det.ready) {
      await this._markReady({ alreadyReady: true });
      return { ok: true, state: STATES.READY, alreadyReady: true };
    }

    const needNetFx3 = !det.systemSpeech.ok;
    if (needNetFx3) {
      // 这里只是「声明要装 .NET 3.5」；真正的提权与 regsvr32 合并到后面同一次 UAC
      this._setState(
        STATES.INSTALLING_NETFX3,
        3,
        '系统缺少 .NET Framework 3.5 语音组件，将随注册步骤一次授权安装'
      );
      await this._announce(
        '系统缺少语音组件 .NET Framework 3.5，安装时会一并装好，全过程只需要你授权一次。',
        'high'
      );
    }

    // 2) DOWNLOADING（已有且字节数正确的文件直接跳过）
    if (!(det.files.ok && det.files.engineOk && det.files.packs.every((p) => p.ok))) {
      await this._downloadPhase();
    }

    // 3) EXTRACTING
    const filesNow = this._probeFiles();
    if (!filesNow.engineOk || !filesNow.packs.every((p) => p.ok)) {
      await this._extractPhase();
    }

    // 4) REGISTERING（一次 UAC：NetFx3[仅缺失时] + regsvr32）
    const speechNow = needNetFx3 ? await this._probeSystemSpeech() : { ok: true };
    await this._registerPhase({ needNetFx3: !speechNow.ok });

    // 5) WRITING_CONFIG
    await this._configPhase();

    // 6) VERIFYING
    const verified = await this._verifyPhase();

    // 7) READY
    await this._markReady({ checks: verified });
    return { ok: true, state: STATES.READY };
  }

  // ---- 下载 ----

  async _downloadPhase() {
    ensureDir(this.workDir);
    const targets = S.downloadTargets();
    const total = targets.reduce((s, t) => s + t.sizeBytes, 0) || 1;
    let done = 0;

    this._setState(STATES.DOWNLOADING, 5, '正在下载离线语音组件（约 138 MB）…');
    await this._announce('开始下载离线语音组件，约一百三十八兆，请保持网络连接。');

    for (const t of targets) {
      const dest = path.join(this.workDir, t.fileName);
      if (this._sizeMatches(dest, t.sizeBytes)) {
        done += t.sizeBytes;
        this._setState(STATES.DOWNLOADING, 5 + (done / total) * 50, `${t.label} 已存在，跳过下载`);
        continue;
      }
      this._setState(STATES.DOWNLOADING, 5 + (done / total) * 50, `正在下载 ${t.label}…`);
      await this._downloadOne(t, (received) => {
        const pct = 5 + ((done + received) / total) * 50;
        this._setState(STATES.DOWNLOADING, pct, `正在下载 ${t.label}…`);
      });
      done += t.sizeBytes;
      this._setState(STATES.DOWNLOADING, 5 + (done / total) * 50, `${t.label} 下载完成`);
    }
  }

  _sizeMatches(p, expect) {
    if (!expect) return false;
    return fileSize(p) === expect;
  }

  async _downloadOne(target, onBytes) {
    if (!this._fetch) {
      throw this._err(S.VP_ERRORS.NETWORK, '当前运行环境不支持网络下载（缺少 fetch）', DEFAULT_NEXT_STEP);
    }
    const dest = path.join(this.workDir, target.fileName);
    const errors = [];
    for (let round = 1; round <= DOWNLOAD_ROUNDS; round += 1) {
      for (const url of target.urls) {
        try {
          await this._fetchTo(url, target, dest, onBytes);
          return;
        } catch (e) {
          errors.push({ round, url, message: tail(e.message, 160) });
        }
      }
    }
    // 播报文案要短（A11Y 播报上限 200 字），URL 只放进 error.detail 供排查
    const last = errors[errors.length - 1];
    const e = this._err(
      S.VP_ERRORS.NETWORK,
      `下载 ${target.label} 失败：${(last && last.message) || '未知网络错误'}`,
      '请检查网络后点「重试」（已下载完成的文件不会重下）。' + DEFAULT_NEXT_STEP
    );
    e.detail = errors;
    throw e;
  }

  async _fetchTo(url, target, dest, onBytes) {
    const tmp = `${dest}.part`;
    // ---- 断点续传：保留 .part，下次带 Range 接着下（本机慢网下这是「能不能装上」的分水岭）----
    let resumeFrom = 0;
    try {
      const st = fs.statSync(tmp);
      if (target.sizeBytes && st.size === target.sizeBytes) {
        // .part 已是完整文件（上次 rename 前中断）：直接转正，不再下载
        fs.rmSync(dest, { force: true });
        fs.renameSync(tmp, dest);
        if (onBytes) onBytes(target.sizeBytes, target.sizeBytes);
        return;
      }
      if (st.size > 0 && (!target.sizeBytes || st.size < target.sizeBytes)) resumeFrom = st.size;
    } catch (e) {
      resumeFrom = 0;
    }

    const ctrl = new AbortController();
    // 两个正交超时：stall 判「断流」，total 只防永久挂起
    let stallTimer = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => ctrl.abort(), DOWNLOAD_STALL_MS);
    };
    const totalTimer = setTimeout(() => ctrl.abort(), DOWNLOAD_TOTAL_MS);
    armStall();

    let ws = null;
    try {
      const headers = { 'User-Agent': 'langdu-nv-neo/2.4 (+https://github.com/zjh1934/langdu-nv)' };
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
      const res = await this._fetch(url, { signal: ctrl.signal, redirect: 'follow', headers });
      if (!res || !res.ok) throw new Error(`HTTP ${(res && res.status) || '无响应'}`);
      if (!res.body) throw new Error('响应体为空');

      // 206 = 服务器接受续传（追加写）；200 = 不支持续传或首次下载（覆盖写）
      const append = resumeFrom > 0 && res.status === 206;
      if (resumeFrom > 0 && !append) resumeFrom = 0;

      const remain = Number(res.headers.get('content-length') || 0) || 0;
      const total = remain + resumeFrom || target.sizeBytes || 0;

      ws = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
      let received = resumeFrom;
      const overLimit = target.sizeBytes ? target.sizeBytes * 1.05 + 1024 : Number.MAX_SAFE_INTEGER;
      for await (const chunk of res.body) {
        armStall(); // 有字节进来就重置断流计时
        const buf = Buffer.from(chunk);
        received += buf.length;
        if (received > overLimit) throw new Error('服务器返回的数据大于预期大小，已中止');
        if (!ws.write(buf)) await waitDrain(ws);
        if (onBytes) onBytes(received, total || target.sizeBytes);
      }
      await new Promise((resolve, reject) => {
        ws.end(() => resolve());
        ws.once('error', reject);
      });
      ws = null;

      if (target.sizeBytes > 0 && received !== target.sizeBytes) {
        // 保留 .part：下一轮 / 下次点「重试」可以接着下，不必从头
        throw new Error(
          `文件大小不符：期望 ${target.sizeBytes} 字节，实际 ${received} 字节（已保留断点，重试将续传）`
        );
      }
      fs.rmSync(dest, { force: true });
      fs.renameSync(tmp, dest);
    } catch (e) {
      try {
        if (ws) ws.destroy();
      } catch (e2) {
        /* 忽略 */
      }
      // 关键：**不删 .part**。慢网一次下不完是常态，删掉就等于永远从头开始。
      // 只有「服务器返回的数据超预期」这种脏数据才丢弃，避免续传把错误内容拼进来。
      if (/大于预期大小/.test(String(e && e.message))) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch (e2) {
          /* 忽略 */
        }
      }
      throw e;
    } finally {
      clearTimeout(totalTimer);
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  // ---- 解压 ----

  async _extractPhase() {
    ensureDir(this.voicesDir);
    this._setState(STATES.EXTRACTING, 56, '正在解压语音引擎…');
    try {
      const zip = path.join(this.workDir, S.NVSA.asset.fileName);
      if (!fs.existsSync(zip)) throw new Error(`缺少安装包：${zip}`);
      fs.rmSync(this.engineDir, { recursive: true, force: true });
      ensureDir(this.engineDir);
      extractAll(zip, this.engineDir, (doneEntries, totalEntries) => {
        this._setState(STATES.EXTRACTING, 56 + (totalEntries ? (doneEntries / totalEntries) * 8 : 0), '正在解压语音引擎…');
      });
      const dll = this.engineDllPath;
      if (!fs.existsSync(dll)) throw new Error(`解压后未找到 x64 引擎 DLL：${dll}`);

      let i = 0;
      for (const pack of S.VOICE_PACKS) {
        i += 1;
        const base = 64 + ((i - 1) / S.VOICE_PACKS.length) * 10;
        this._setState(STATES.EXTRACTING, base, `正在解压语音包 ${pack.displayName}…`);
        const msix = path.join(this.workDir, pack.fileName);
        if (!fs.existsSync(msix)) throw new Error(`缺少语音包：${msix}`);
        const dir = path.join(this.voicesDir, S.msixDirName(pack));
        fs.rmSync(dir, { recursive: true, force: true });
        extractAll(msix, dir);
        if (!dirHasFiles(dir)) throw new Error(`语音包 ${pack.displayName} 解压结果为空`);
      }
      this._setState(STATES.EXTRACTING, 74, '语音组件解压完成');
    } catch (e) {
      throw this._err(
        S.VP_ERRORS.EXTRACT,
        `解压离线语音组件失败：${tail(e.message, 200)}`,
        '请删除 voice-pack 目录后重试，或重新下载；' + DEFAULT_NEXT_STEP
      );
    }
  }

  // ---- 注册（一次 UAC）----

  /**
   * 合并提权：NetFx3（仅缺失时）+ regsvr32 /s，都在**同一个** elevated 脚本里，
   * 用户最多点一次 UAC。结果通过结果文件回传（不依赖退出码的本地化文本）。
   */
  async _registerPhase(opts) {
    const needNetFx3 = !!(opts && opts.needNetFx3);
    const dll = this.engineDllPath;
    if (!fs.existsSync(dll)) {
      throw this._err(
        S.VP_ERRORS.REGISTER,
        `注册前未找到引擎 DLL：${dll}`,
        '请先完成下载与解压；' + DEFAULT_NEXT_STEP
      );
    }

    const alreadyRegistered = fs.existsSync(this.markerPath) && this._probeRegistry().status === 'PRESENT';
    if (alreadyRegistered && !needNetFx3) {
      this._setState(STATES.REGISTERING, 78, '语音引擎已注册过，跳过授权（不会弹 UAC）');
      return;
    }

    this._setState(
      STATES.REGISTERING,
      78,
      needNetFx3
        ? '正在注册语音引擎并安装 .NET 3.5（需要一次管理员授权，请在弹窗点「是」）…'
        : '正在注册语音引擎（需要一次管理员授权，请在弹窗点「是」）…'
    );
    await this._announce(
      needNetFx3
        ? '现在需要一次管理员授权，用来注册本地语音引擎并安装 .NET 3.5，请在弹窗里点是。'
        : '现在需要一次管理员授权，用来注册本地语音引擎，请在弹窗里点是。',
      'high'
    );

    // 提权脚本目录：每次重建（上一次失败留下的脚本/结果没有复用价值）
    fs.rmSync(this.deployTmpDir, { recursive: true, force: true });
    ensureDir(this.deployTmpDir);
    const stamp = `${Date.now()}`;
    const innerPath = path.join(this.deployTmpDir, `elevated-${stamp}.ps1`);
    const innerResult = path.join(this.deployTmpDir, `elevated-${stamp}.inner.json`);
    const outerResult = path.join(this.deployTmpDir, `elevated-${stamp}.outer.json`);
    fs.rmSync(innerResult, { force: true });
    fs.rmSync(outerResult, { force: true });

    fs.writeFileSync(innerPath, '\ufeff' + this._buildElevatedScript({ dll, needNetFx3, innerResult }), 'utf8');

    const outerScript = [
      "$ErrorActionPreference = 'Stop'",
      `$inner = ${psQuote(innerPath)}`,
      `$outer = ${psQuote(outerResult)}`,
      'try {',
      // -WindowStyle 交给子 powershell.exe 自己（而不是 Start-Process 的窗口参数）：
      // 与 -Verb RunAs 组合时部分 Win10 构建会报「参数不正确」，这样写更稳。
      "  $psArgs = @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File', ('\"' + $inner + '\"'))",
      "  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $psArgs -Verb RunAs -Wait -PassThru",
      '  $code = 0',
      '  if ($null -ne $p) { $code = $p.ExitCode }',
      "  Set-Content -LiteralPath $outer -Value (ConvertTo-Json -InputObject @{ elevated = $true; exitCode = $code } -Compress) -Encoding UTF8",
      '} catch {',
      "  Set-Content -LiteralPath $outer -Value (ConvertTo-Json -InputObject @{ elevated = $false; canceled = $true; error = $_.Exception.Message } -Compress) -Encoding UTF8",
      '}',
      'exit 0',
    ].join('\n');

    try {
      await this._ps(outerScript, 15 * 60 * 1000);
    } catch (e) {
      throw this._err(
        S.VP_ERRORS.ELEVATION_DENIED,
        `无法发起管理员授权：${tail(e.stderr || e.message, 200)}`,
        '可能是安全软件拦下了提权窗口；稍后重试即可。' + DEFAULT_NEXT_STEP
      );
    }

    const outer = readJsonFile(outerResult);
    if (!outer || outer.elevated !== true) {
      const detail = outer && outer.error ? tail(outer.error, 200) : '未拿到提权结果';
      throw this._err(
        S.VP_ERRORS.ELEVATION_DENIED,
        `管理员授权被取消或失败：${detail}`,
        '下次点「重试」会再次询问授权；' + DEFAULT_NEXT_STEP
      );
    }

    const inner = readJsonFile(innerResult);
    if (!inner) {
      throw this._err(
        S.VP_ERRORS.REGISTER,
        `注册脚本没有产出结果（提权进程退出码 ${outer.exitCode}）`,
        '可能是安全软件拦截；重启电脑后再试一次。' + DEFAULT_NEXT_STEP
      );
    }
    if (!inner.ok) {
      const steps = Array.isArray(inner.steps) ? inner.steps.join(' / ') : '';
      if (inner.exitCode === 2) {
        throw this._err(
          S.VP_ERRORS.NETFX3,
          `安装 .NET Framework 3.5 失败：${inner.error || '未知原因'}${steps ? `（${steps}）` : ''}`,
          '可在「控制面板 → 启用或关闭 Windows 功能」手动勾选 .NET Framework 3.5 后重试；' + DEFAULT_NEXT_STEP
        );
      }
      throw this._err(
        S.VP_ERRORS.REGISTER,
        `注册语音引擎失败：${inner.error || '未知原因'}${steps ? `（${steps}）` : ''}`,
        '常见原因是杀毒软件拦截了 DLL 注册；重启电脑后重试。' + DEFAULT_NEXT_STEP
      );
    }

    try {
      ensureDir(this.engineDir);
      fs.writeFileSync(this.markerPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      /* 标记写不进不影响注册本身，后续靠注册表判定 */
    }
    // 成功即清掉提权脚本与结果文件（失败时保留，便于下次排查/覆盖）
    fs.rmSync(this.deployTmpDir, { recursive: true, force: true });
    this._setState(STATES.REGISTERING, 84, '语音引擎注册完成');
  }

  _buildElevatedScript({ dll, needNetFx3, innerResult }) {
    const lines = [
      "$ErrorActionPreference = 'Stop'",
      '$ProgressPreference = \'SilentlyContinue\'',
      `$result = ${psQuote(innerResult)}`,
      '$steps = New-Object System.Collections.ArrayList',
      'function Save-Result($obj) {',
      '  Set-Content -LiteralPath $result -Value (ConvertTo-Json -InputObject $obj -Compress -Depth 4) -Encoding UTF8',
      '}',
      'try {',
    ];
    if (needNetFx3) {
      lines.push(
        "  [void]$steps.Add('netfx3=start')",
        "  $d = Start-Process -FilePath 'dism.exe' -ArgumentList @('/online','/enable-feature','/featurename:NetFx3','/all','/norestart') -Wait -PassThru -WindowStyle Hidden",
        '  [void]$steps.Add(("netfx3=" + $d.ExitCode))',
        '  if ($d.ExitCode -ne 0 -and $d.ExitCode -ne 3010) { Save-Result @{ ok = $false; exitCode = 2; steps = $steps.ToArray(); error = ("dism 退出码 " + $d.ExitCode) }; exit 2 }'
      );
    }
    lines.push(
      `  $dll = ${psQuote(dll)}`,
      '  if (-not (Test-Path -LiteralPath $dll)) { throw "未找到引擎 DLL：$dll" }',
      "  $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList @('/s', ('\"' + $dll + '\"')) -Wait -PassThru -WindowStyle Hidden",
      '  [void]$steps.Add(("regsvr32=" + $p.ExitCode))',
      '  if ($p.ExitCode -ne 0) { Save-Result @{ ok = $false; exitCode = 4; steps = $steps.ToArray(); error = ("regsvr32 退出码 " + $p.ExitCode) }; exit 4 }',
      '  Save-Result @{ ok = $true; exitCode = 0; steps = $steps.ToArray() }',
      '  exit 0',
      '} catch {',
      '  Save-Result @{ ok = $false; exitCode = 1; steps = $steps.ToArray(); error = $_.Exception.Message }',
      '  exit 1',
      '}'
    );
    return lines.join('\r\n');
  }

  // ---- HKCU 配置（免提权）----

  async _configPhase() {
    this._setState(STATES.WRITING_CONFIG, 86, '正在写入本地语音配置…');
    const voicesDir = this.voicesDir;
    // 用 PowerShell 注册表提供程序而不是 reg.exe：本项目已因「reg.exe 在受管环境被禁」迁移过一次
    // （见 sapiBackend.readNvsaConfig 注释），这里保持一致，HKCU 写入同样不需要管理员。
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `New-Item -Path ${psQuote(REG_KEY_PS)} -Force | Out-Null`,
      `New-ItemProperty -Path ${psQuote(REG_KEY_PS)} -Name 'NarratorVoicePath' -PropertyType String -Value ${psQuote(
        voicesDir
      )} -Force | Out-Null`,
      `New-ItemProperty -Path ${psQuote(REG_KEY_PS)} -Name 'NoEdgeVoices' -PropertyType DWord -Value 1 -Force | Out-Null`,
      `New-ItemProperty -Path ${psQuote(REG_KEY_PS)} -Name 'NoAzureVoices' -PropertyType DWord -Value 1 -Force | Out-Null`,
      "[Console]::Out.WriteLine('CONFIG_OK')",
    ].join('\n');
    try {
      const { stdout } = await this._ps(script, 20000);
      if (stdout.indexOf('CONFIG_OK') < 0) throw new Error('配置写入未返回确认');
    } catch (e) {
      throw this._err(
        S.VP_ERRORS.CONFIG,
        `写入本地语音配置失败：${tail(e.stderr || e.message, 200)}`,
        '可稍后重试；' + DEFAULT_NEXT_STEP
      );
    }
    const cfg = this._probeRegistry();
    if (cfg.status !== 'PRESENT') {
      throw this._err(
        S.VP_ERRORS.CONFIG,
        '配置写入后仍读不到 NarratorVoicePath，可能被安全策略拦截',
        '请检查是否使用了受限账户；' + DEFAULT_NEXT_STEP
      );
    }
  }

  // ---- 验证（四级）----

  async _verifyPhase() {
    // 一级：文件层
    this._setState(STATES.VERIFYING, 90, '正在校验引擎文件…');
    const files = this._probeFiles();
    if (!files.ok) {
      throw this._err(
        S.VP_ERRORS.VERIFY_FAILED,
        `验证失败（文件层）：${files.message}`,
        '请重试安装；' + DEFAULT_NEXT_STEP
      );
    }

    // 二级：注册层
    this._setState(STATES.VERIFYING, 92, '正在校验注册表配置…');
    const registry = this._probeRegistry();
    if (registry.status !== 'PRESENT') {
      throw this._err(
        S.VP_ERRORS.VERIFY_FAILED,
        `验证失败（注册层）：${registry.message}`,
        '请重试安装；' + DEFAULT_NEXT_STEP
      );
    }

    // 三级：新进程枚举（regsvr32 之后同进程缓存不会刷新，必须新开进程）
    this._setState(STATES.VERIFYING, 94, '正在重新枚举系统语音（新进程）…');
    const voices = await this._probeVoices();
    if ((voices.matched || []).length < 2) {
      throw this._err(
        S.VP_ERRORS.VERIFY_FAILED,
        `验证失败（枚举层）：${voices.message}`,
        '可能是安全软件拦截了 DLL 注册；重启电脑后再试。' + DEFAULT_NEXT_STEP
      );
    }

    // 四级：试合成「测试」——走 ttsBridge 公共 API（不直接碰后端实现）
    this._setState(STATES.VERIFYING, 96, '正在试合成「测试」…');
    const synth = await this._testSynth();
    if (!synth.ok) {
      throw this._err(
        S.VP_ERRORS.VERIFY_FAILED,
        `验证失败（试合成）：${synth.message}`,
        '已注册但本进程还没刷新语音缓存，重启应用通常即可；' + DEFAULT_NEXT_STEP
      );
    }

    this._setState(STATES.VERIFYING, 99, '验证通过');
    return { files, registry, voices, synth };
  }

  async _testSynth() {
    try {
      // eslint-disable-next-line global-require
      const { getBridge } = require('./ttsBridge');
      const bridge = getBridge();
      // 注册刚完成时，SAPI 对新注册 DLL 的枚举有秒级延迟：本机实测出现过
      // 「voiceDeploy 自己的新进程枚举已能看到晓晓/云希，但紧接着的通道探测仍返回旧列表」
      // —— 于是试合成走了 edge、状态机误判 FAILED_VERIFY（用户会看到「装好了却说失败」）。
      // 因此这里 refreshEngines + 试合成做 3 轮退避重试，容忍这个生效窗口。
      let lastMsg = '试合成未执行';
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        // 关键：注册后必须重探（SAPI 语音列表在进程内缓存），refreshEngines 会重置长驻通道
        if (typeof bridge.refreshEngines === 'function') await bridge.refreshEngines();
        const r = await bridge.synthesize('测试', { voiceId: 'sapi:xiaoxiao' });
        const bytes = r && r.audioData ? r.audioData.length : 0;
        if (r && r.engine === 'sapi' && bytes > 0) {
          return { ok: true, bytes, format: r.format, sampleRate: r.sampleRate, durationMs: r.durationMs, attempt };
        }
        lastMsg =
          r && r.engine !== 'sapi'
            ? `试合成走到了 ${r.engine} 引擎（本地语音仍不可用）`
            : '试合成没有返回音频数据';
        if (attempt < 3) await new Promise((res) => setTimeout(res, 900));
      }
      return { ok: false, message: lastMsg };
    } catch (e) {
      return { ok: false, message: tail(e.message || String(e), 240) };
    }
  }

  // ---- READY ----

  async _markReady(info) {
    this._ready = true;
    this._setState(STATES.READY, 100, '本地离线语音已就绪');
    // 让上层（设置面板 / 播报 / 悬浮球）立刻看到 sapi 可用：refreshEngines + 广播 statusChanged。
    // 刚跑完 VERIFYING 时 _testSynth 已经 refresh 过，这里不重复拉起一次 PowerShell 通道。
    try {
      // eslint-disable-next-line global-require
      const { getBridge } = require('./ttsBridge');
      const bridge = getBridge();
      if (!info || !info.checks) {
        if (typeof bridge.refreshEngines === 'function') await bridge.refreshEngines();
      }
      if (typeof bridge.warmup === 'function') bridge.warmup(); // 后台预热，不 await
    } catch (e) {
      /* 非主进程环境 / 桥未就绪：不影响部署结论 */
    }
    this._broadcastVoiceStatus();
    if (!info || !info.alreadyReady) {
      await this._announce('离线语音安装完成，晓晓和云希现在都能在没网的时候朗读了。');
    }
  }

  // ---- 失败 ----

  _err(code, message, nextStep) {
    const e = new Error(message);
    e.vpCode = code;
    e.nextStep = nextStep || DEFAULT_NEXT_STEP;
    return e;
  }

  _failFrom(e) {
    const code = (e && e.vpCode) || S.VP_ERRORS.VERIFY_FAILED;
    const state = CODE_TO_STATE[code] || STATES.FAILED_VERIFY;
    const message = (e && e.message) || '离线语音安装失败';
    const nextStep = (e && e.nextStep) || DEFAULT_NEXT_STEP;
    const error = { code, message, nextStep };
    this._ready = false;
    this._setState(state, this._snapshot.pct, message, { error });
    this._announce(`${message}。${nextStep}`, 'high');
    return { ok: false, state, error };
  }

  dispose() {
    this._killChildren();
    this._listeners.clear();
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
  }
}

let _instance = null;

/** 单例（主进程用；ipc.js 接线只需三条 handler） */
function getVoiceDeploy(opts) {
  if (!_instance) _instance = new VoiceDeploy(opts);
  return _instance;
}

module.exports = {
  VoiceDeploy,
  getVoiceDeploy,
  STATES,
  FAILED_STATES,
  BUSY_STATES,
  CODE_TO_STATE,
};
