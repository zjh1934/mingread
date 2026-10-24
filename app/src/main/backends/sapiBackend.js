// 本地 SAPI 后端（NVSA / NaturalVoiceSAPIAdapter 注册的微软神经语音）。
//
// 链路：文本 → 长驻 PowerShell 通道（sapiHost）→ System.Speech（SAPI5）→ NVSA 适配器 → 晓晓/云希
// 特点：离线、无网络往返，首次合成含一次性加载，之后为百毫秒级。输出 WAV（16bit PCM）。
//
// ⚠️ 本文件在 Linux 沙箱内只能做静态实现与抽象层验证，真实链路需 Windows 实测（见 scripts/register-nvsa.ps1 与交付清单）。
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const { SapiHost, b64 } = require('./sapiHost');
const {
  SAPI_VOICES,
  voiceKeyOf,
  pickSapiVoices,
  registerDynamicVoices,
  clearDynamicVoices,
} = require('./voiceCatalog');
const { ENGINE_ERR, LOCAL_REASON, LOCAL_REASON_TEXT } = require('./engineErrors');
const { splitSentences, proportionalSentenceMarks } = require('../util');

const PROBE_TTL_OK_MS = 5 * 60 * 1000; // 可用时缓存 5 分钟
const PROBE_TTL_FAIL_MS = 30 * 1000; // 不可用时只缓存 30 秒（刚注册完能尽快感知）
const REG_KEY = 'HKCU\\Software\\NaturalVoiceSAPIAdapter\\Enumerator';

/** 我们的 rate（-50~+100 百分比）→ SAPI Rate（-10~+10） */
function toSapiRate(rate) {
  const r = Math.round((Number(rate) || 0) / 10);
  return Math.max(-10, Math.min(10, r));
}

/** 我们的 volume（-50~+50）→ SAPI Volume（0~100） */
function toSapiVolume(volume) {
  const v = 50 + (Number(volume) || 0);
  return Math.max(0, Math.min(100, v));
}

/** 是否已是带 RIFF 头的 WAV（SetOutputToWaveStream 在部分版本会直接写完整 WAV） */
function looksLikeWav(buf) {
  return (
    buf &&
    buf.length > 44 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  );
}

/** 裸 PCM16 → WAV（44 字节标准头） */
function wrapPcmAsWav(pcm, sampleRate, bitsPerSample, numChannels) {
  const bytesPerSample = Math.max(1, Math.floor((bitsPerSample || 16) / 8));
  const dataLen = pcm.length - (pcm.length % (bytesPerSample * numChannels));
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, Math.floor(sampleRate * numChannels * bytesPerSample), true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample || 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  new Uint8Array(buffer).set(pcm.subarray(0, dataLen), 44);
  return new Uint8Array(buffer);
}

/** 读取 HKCU 下 NVSA 配置（仅 Windows；失败返回 null，不影响主流程）
 *  v2.4.0：由 reg.exe 文本解析改为 PowerShell 注册表提供程序（Get-ItemProperty + JSON 输出）：
 *   - reg.exe 的文本输出格式随系统区域设置变化，解析脆弱；
 *   - 部分安全策略环境（开发沙箱/企业管控）禁跑 reg.exe，会让预热探测整体挂掉。
 *  PowerShell 是本项目既有依赖面（sapiHost 长驻通道同款做法），一次性进程 + 8s 超时，
 *  键不存在时输出 {}，Node 侧零格式假设。 */
function readNvsaConfig() {
  if (process.platform !== 'win32') return null;
  try {
    const psPath = REG_KEY.replace(/^HKCU\\/, 'HKCU:\\');
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$p = Get-ItemProperty -Path '${psPath}'`,
      'if ($null -eq $p) { Write-Output "{}" }',
      'else {',
      '  [ordered]@{ NarratorVoicePath = $p.NarratorVoicePath; NoEdgeVoices = $p.NoEdgeVoices; NoAzureVoices = $p.NoAzureVoices } | ConvertTo-Json -Compress -Depth 2',
      '}',
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    const j = JSON.parse(String(out).trim() || '{}');
    const p = j.NarratorVoicePath ? String(j.NarratorVoicePath) : null;
    return {
      narratorVoicePath: p,
      narratorVoicePathExists: !!(p && fs.existsSync(p)),
      noEdgeVoices: j.NoEdgeVoices == null ? null : String(j.NoEdgeVoices),
      noAzureVoices: j.NoAzureVoices == null ? null : String(j.NoAzureVoices),
    };
  } catch (e) {
    return null;
  }
}

class SapiBackend {
  constructor(opts = {}) {
    this._probe = null; // { at, value }
    // 动态音色（音色源注册）状态：启动即后台载入，失败静默不阻塞探测
    this._dyn = { started: false, ready: false, registered: 0, keys: [], error: null, at: null };
    this._dynLoad = null;
    this._dynGen = 0; // 代次：重建时丢弃上一轮在途结果，避免旧清单覆盖新目录
    this._host =
      opts.host ||
      new SapiHost({
        // 保活连续失败（通道卡死/被杀）：失效缓存，并在后台重探 + 预热。
        // 这里绝不 await 到任何朗读路径上——onDead 只由 sapiHost 的 60s 定时器触发。
        onDead: (err) => this._onHostDead(err),
      });
    this._startDynamicVoices();
  }

  /**
   * 载入音色源里的「非内置」音色并注册进 voiceCatalog，让它们能被 listVoices / synthesize 选中。
   * 全程后台进行：任何失败（无 settingsStore、网络坏、清单不合法）只记录在 getInfo().dynamicVoices，
   * 绝不影响 probe / 合成 —— 装不上音色源不该让本地语音整体不可用。
   */
  _startDynamicVoices() {
    if (this._dynLoad) return this._dynLoad;
    this._dyn.started = true;
    const gen = this._dynGen;
    this._dynLoad = (async () => {
      try {
        // 延迟 require：纯 Node 探针/测试里也安全（voiceSources 内部对 settingsStore 缺失已做降级）
        // eslint-disable-next-line global-require
        const voiceSources = require('../voiceSources');
        const res = await voiceSources.loadSources({ noCache: true });
        if (gen !== this._dynGen) return this._dyn; // 期间已重建，本轮结果作废
        const list = (res && Array.isArray(res.voices) ? res.voices : [])
          .filter((v) => v && v.key && !v.builtin) // 只取用户源带来的新音色：内置项已在目录里
          .map((v) => ({
            key: v.key,
            displayName: v.displayName,
            gender: v.gender,
            locale: v.locale,
            keywords: v.keywords, // 清单里的 keywords 直接透传：系统语音名与 key 不一致时靠它匹配
            desc: v.sourceName ? `来自音色源：${v.sourceName}` : '',
          }));
        const reg = registerDynamicVoices(list);
        this._dyn = {
          started: true,
          ready: true,
          registered: reg.added.length,
          keys: reg.added.slice(),
          ignored: reg.ignored.slice(),
          warnings: (reg.warnings || []).map((w) => w.message),
          error: null,
          at: Date.now(),
        };
        // 已经探测过：用缓存里的枚举结果重新挑一遍，让新音色立刻出现在音色表里
        this._refreshProbeVoices();
      } catch (e) {
        this._dyn = {
          ...this._dyn,
          started: true,
          ready: true,
          error: String((e && e.message) || e),
          at: Date.now(),
        };
      }
      return this._dyn;
    })();
    return this._dynLoad;
  }

  /** 源可能变了（增删音色源 / 刚装完新音色）：清空动态音色并重新载入 */
  _rebuildDynamicVoices() {
    this._dynGen += 1;
    clearDynamicVoices();
    this._dynLoad = null;
    this._dyn = { started: true, ready: false, registered: 0, keys: [], error: null, at: null };
    return this._startDynamicVoices();
  }

  /** 已探测过时，用已缓存的枚举结果重挑音色（不重新枚举、不影响 available 判定） */
  _refreshProbeVoices() {
    const p = this._probe;
    // 只刷新「已可用」的探测结果：不可用说明枚举里根本没有可唱的语音，
    // 动态音色注册不能把不可用改成可用（可用性永远以真实枚举结果为准）。
    if (!p || !p.value || !p.value.available) return;
    const names = Array.isArray(p.value.installed) ? p.value.installed : [];
    const picked = pickSapiVoices(names);
    if (!picked.length) return;
    const isFallback = picked.every((v) => v.kind === 'system');
    p.value = {
      ...p.value,
      kind: isFallback ? 'system' : 'nvsa',
      voices: picked,
      notice: isFallback ? '当前用系统内置语音：音质一般，但几乎没有延迟。装好离线语音后会自动换成晓晓/云希。' : null,
    };
  }

  /**
   * 长驻通道被判定死亡后的自愈：置空缓存 → 后台 probe(true)（会重新拉起宿主）→ 预热。
   * 失败也不抛：下一次真实合成会再探一次，最坏情况只是这一次降级到在线语音。
   */
  _onHostDead(err) {
    this.invalidate();
    setImmediate(async () => {
      try {
        const p = await this.probe(true);
        if (p && p.available && typeof this.warmup === 'function') this.warmup();
      } catch (e) {
        /* 自愈失败不影响后续按需重建 */
      }
      if (err && err.message) {
        // 仅用于诊断：不打断朗读，也不弹提示
        this._lastHostDeath = { message: err.message, at: Date.now() };
      }
    });
  }

  get id() {
    return 'sapi';
  }

  get kind() {
    return 'local';
  }

  get label() {
    return '本地离线语音（NVSA）';
  }

  /** 最近一次探测结果（无副作用；未探测过返回 null） */
  lastProbe() {
    return this._probe ? this._probe.value : null;
  }

  /** 同步粗判：只判断平台，不做副作用（真实可用性由 probe() 决定） */
  isAvailable() {
    return SapiHost.supported && (this._probe ? this._probe.value.available : true);
  }

  invalidate() {
    this._probe = null;
    return this;
  }

  /**
   * 重启长驻通道（NVSA 注册完成后必须调用，否则 SAPI 缓存的语音列表不会刷新）。
   * 同时重建动态音色目录：音色源可能刚增删过，刚装好的新音色要靠它才进得了选择列表。
   */
  resetHost() {
    this.invalidate();
    this._host.dispose();
    this._rebuildDynamicVoices();
    return this;
  }

  /**
   * 探测本地引擎可用性（结果带缓存）
   * @param {boolean} [force]
   * @returns {Promise<{available:boolean, reason?:string, message?:string, voices?:Array, installed?:string[], detail?:object}>}
   */
  async probe(force) {
    if (!SapiHost.supported) {
      const value = {
        available: false,
        reason: LOCAL_REASON.NOT_WINDOWS,
        message: `${LOCAL_REASON_TEXT[LOCAL_REASON.NOT_WINDOWS]}（当前：${process.platform}）`,
      };
      this._probe = { at: Date.now(), value }; // 也缓存：状态展示需要给出"为什么本地不可用"
      return value;
    }
    const now = Date.now();
    if (!force && this._probe) {
      const ttl = this._probe.value.available ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
      if (now - this._probe.at < ttl) return this._probe.value;
    }
    const value = await this._probeNow();
    this._probe = { at: Date.now(), value };
    return value;
  }

  async _probeNow() {
    let names = [];
    try {
      names = await this._enumerate();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const reason = /ENOENT/.test(msg) ? LOCAL_REASON.NO_POWERSHELL : LOCAL_REASON.HOST_START_FAILED;
      return {
        available: false,
        reason,
        message: `${LOCAL_REASON_TEXT[reason]}：${msg}`,
      };
    }
    const picked = pickSapiVoices(names);
    if (!picked.length) {
      return {
        available: false,
        reason: LOCAL_REASON.VOICE_NOT_REGISTERED,
        message: `${LOCAL_REASON_TEXT[LOCAL_REASON.VOICE_NOT_REGISTERED]}（系统语音共 ${names.length} 个，既没有晓晓/云希，也没有可用的中文系统语音）。请在设置里点「一键安装离线语音」，或运行 scripts/register-nvsa.ps1。`,
        installed: names,
        detail: { installedCount: names.length, sample: names.slice(0, 8), nvsaConfig: readNvsaConfig() },
      };
    }
    // 只有系统兜底音色时，必须让上层可感知（kind/notice），绝不假装是晓晓/云希
    const isFallback = picked.every((v) => v.kind === 'system');
    return {
      available: true,
      kind: isFallback ? 'system' : 'nvsa',
      voices: picked,
      installed: names,
      notice: isFallback
        ? '当前用系统内置语音：音质一般，但几乎没有延迟。装好离线语音后会自动换成晓晓/云希。'
        : null,
      detail: { installedCount: names.length, nvsaConfig: readNvsaConfig() },
    };
  }

  /** 枚举系统 SAPI 语音名 */
  async _enumerate() {
    const res = await this._host.request('voices', {}, 20000);
    const list = res && res.voices ? res.voices : [];
    const arr = Array.isArray(list) ? list : [list]; // PowerShell 单元素数组可能被序列化成对象
    return arr
      .map((v) => {
        try {
          return Buffer.from((v && v.name) || '', 'base64').toString('utf8');
        } catch (e) {
          return '';
        }
      })
      .filter(Boolean);
  }

  listVoices() {
    const p = this._probe;
    if (!p || !p.value.available) return [];
    const picked = p.value.voices || [];
    // 目录（SAPI_VOICES）里已包含音色源注册的动态音色，因此这里天然会把「新装的音色」列出来；
    // 但必须仍在 picked 里（= 系统枚举真的装了）才展示，绝不给用户一个点了没声的选项。
    return SAPI_VOICES.filter((def) => picked.some((x) => x.key === def.key)).map((def) => {
      const hit = picked.find((x) => x.key === def.key);
      return {
        id: def.id,
        engine: 'sapi',
        displayName: def.name,
        locale: def.locale || 'zh-CN',
        gender: def.gender,
        desc: def.desc,
        source: 'offline',
        nativeId: hit ? hit.name : '',
        available: true,
      };
    });
  }

  /** 后台预热：拉起长驻通道 + 静音合成一次，把冷启动与模型加载挪出热键路径 */
  warmup() {
    if (!SapiHost.supported) return;
    setImmediate(async () => {
      try {
        const p = await this.probe();
        if (!p.available) return;
        await this._host.request('warmup', {}, 30000);
      } catch (e) {
        /* 预热失败不影响后续调用（probe 会重新拉起通道） */
      }
    });
  }

  /**
   * 本地合成
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number}} opts
   */
  async synthesize(text, opts = {}) {
    const o = opts || {};
    if (!SapiHost.supported) {
      const err = new Error(LOCAL_REASON_TEXT[LOCAL_REASON.NOT_WINDOWS]);
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      throw err;
    }
    const p = await this.probe();
    if (!p.available) {
      const err = new Error(p.message || LOCAL_REASON_TEXT[p.reason] || '本地语音不可用');
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      err.reason = p.reason;
      throw err;
    }
    const key = voiceKeyOf(o.voiceId) || 'xiaoxiao';
    const picked = (p.voices || []).find((x) => x.key === key) || (p.voices || [])[0];
    if (!picked) {
      const err = new Error('本地语音未就绪（未找到可用音色）');
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      throw err;
    }
    const timeoutMs = Math.min(60000, 8000 + String(text).length * 60);
    const res = await this._host.request(
      'synth',
      {
        textB64: b64(String(text)),
        voiceB64: b64(picked.name),
        rate: toSapiRate(o.rate),
        volume: toSapiVolume(o.volume),
        pitchHz: Math.round(Number(o.pitch) || 0),
      },
      timeoutMs
    );

    const pcm = Buffer.from((res && res.audioB64) || '', 'base64');
    if (!pcm.length) {
      const err = new Error('本地合成失败：未收到音频数据');
      err.code = ENGINE_ERR.LOCAL_SYNTH_FAIL;
      throw err;
    }
    const sampleRate = Number(res.sampleRate) || 16000;
    const bitsPerSample = Number(res.bitsPerSample) || 16;
    const numChannels = Number(res.channels) || 1;

    let audioData;
    if (looksLikeWav(pcm)) {
      audioData = new Uint8Array(pcm);
    } else {
      audioData = wrapPcmAsWav(pcm, sampleRate, bitsPerSample, numChannels);
    }
    const byteRate = sampleRate * numChannels * Math.max(1, Math.floor(bitsPerSample / 8));
    const pcmBytes = looksLikeWav(pcm) ? Math.max(0, pcm.length - 44) : pcm.length;
    const durationMs = Math.max(1, Math.round((pcmBytes / byteRate) * 1000));
    const sentences = proportionalSentenceMarks(splitSentences(String(text)), durationMs);
    return {
      audioData,
      sampleRate,
      durationMs,
      // 本地引擎未取词级边界（SAPI 事件在长驻通道内不可靠），按句给出可用于高亮的时间点
      markers: sentences.map((s) => ({ name: 'sentence', timeMs: s.startMs })),
      sentences,
      backend: 'sapi',
      format: 'wav',
      voiceId: `sapi:${picked.key}`,
      voiceName: picked.name,
    };
  }

  /** 状态展示用信息（不触发副作用，除读注册表外） */
  getInfo() {
    const p = this._probe;
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      platform: process.platform,
      supported: SapiHost.supported,
      hostRunning: this._host.isRunning,
      nvsaConfig: readNvsaConfig(),
      probedAt: p ? p.at : null,
      available: p ? p.value.available : null,
      reason: p && !p.value.available ? p.value.reason : null,
      message: p && !p.value.available ? p.value.message : null,
      installedCount: p && p.value.installed ? p.value.installed.length : null,
      voices: p && p.value.voices ? p.value.voices : [],
      // 音色源注册的动态音色：ready=false 表示还在后台载入；error 非空表示载入失败（不影响本地语音可用性）
      dynamicVoices: {
        started: this._dyn.started,
        ready: this._dyn.ready,
        registered: this._dyn.registered,
        keys: this._dyn.keys.slice(),
        error: this._dyn.error,
      },
      // 长驻通道被保活判定死亡后自动重建；这里留一条最近记录，便于排查「偶发降级」
      lastHostDeath: this._lastHostDeath || null,
    };
  }

  dispose() {
    this._host.dispose();
  }
}

module.exports = SapiBackend;
// voiceDeploy 复用同一份「读 HKCU 注册表」实现（避免两套解析、两套失败语义）
module.exports.readNvsaConfig = readNvsaConfig;
module.exports.REG_KEY = REG_KEY;
