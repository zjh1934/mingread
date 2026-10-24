// 划词抓取常驻通道（captureHost）
//
// 为什么需要长驻：Windows 上抓选区现在的做法是"每次热键都 spawn 一个一次性 powershell"，
// 光冷启动就要 200~400ms，还没算 Node 侧 30ms 粒度的轮询。而热键→出声 ≤300ms 是红线，
// 冷启动一个人就吃掉三分之一预算。把 PowerShell 变成**一次启动、长驻复用**的子进程后，
// 热键路径上只剩"发键 + 5ms 粒度读剪贴板"，实测个位数毫秒。
//
// 与 sapiHost 的关系：**完全独立的两个进程**。本通道只依赖 WScript.Shell 与 Get-Clipboard
// 两个 COM/cmdlet，不 Add-Type 任何 .NET 框架程序集（不碰 System.Speech、不碰 System.Windows.Forms），
// 因此 SAPI 引擎崩溃/卡死/被重启都不会牵连抓选区，反之亦然。
// 两者的共同点只是"行协议 + base64 载荷 + 自动重建"这套工程模式，代码不复用（避免一个改动同时踩两条链路）。
//
// 线程模型：PowerShell 必须 -Sta 起（SendKeys 与剪贴板都要求 STA），
// 宿主内部是**同步串行**的：一次 capture 期间不读 stdin，后续请求在内核管道里排队。
'use strict';

const { spawn } = require('child_process');

const FRAME_PREFIX = 'LDNCAP ';
const READY_TIMEOUT_MS = 20000;
const PING_TIMEOUT_MS = 3000;
const REQUEST_MARGIN_MS = 500;
const MAX_STDERR = 4096;
const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_POLL_MS = 5;

/**
 * 长驻 PowerShell 宿主脚本（Windows PowerShell 5.1 / pwsh 7 均可运行）。
 * 注意：本字符串内不得出现反引号（PowerShell 转义符）与反斜杠（String.raw 模板会失效）。
 *
 * 协议：
 *   → {"id":n,"cmd":"ping"}
 *   ← {"id":n,"ok":true,"cmd":"ping"}
 *   → {"id":n,"cmd":"capture","beforeB64":"...","timeoutMs":1200,"pollMs":5}
 *   ← {"id":n,"ok":true,"cmd":"capture","hit":true,"textB64":"...","tookMs":37,"sendMs":2}
 *   ← {"id":n,"ok":false,"cmd":"capture","stage":"send","errorB64":"..."}
 */
const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false) } catch { }
$wsh = New-Object -ComObject WScript.Shell

function New-B64([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
function Get-B64([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}
function Write-Frame($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
  [Console]::Out.WriteLine('LDNCAP ' + $json)
  [Console]::Out.Flush()
}
function Get-ClipText() {
  $t = $null
  try { $t = Get-Clipboard -Raw } catch { return '' }
  if ($null -eq $t) { return '' }
  return [string]$t
}
function Invoke-Capture($req) {
  $rid = $req.id
  $before = Get-B64 $req.beforeB64
  $timeoutMs = 1200
  $pollMs = 5
  try { if ($null -ne $req.timeoutMs) { $timeoutMs = [int]$req.timeoutMs } } catch { }
  try { if ($null -ne $req.pollMs) { $pollMs = [int]$req.pollMs } } catch { }
  if ($timeoutMs -lt 50) { $timeoutMs = 50 }
  if ($pollMs -lt 1) { $pollMs = 1 }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $sendMs = -1
  try {
    $tSend = [System.Diagnostics.Stopwatch]::StartNew()
    $wsh.SendKeys('^c')
    $sendMs = [int]$tSend.ElapsedMilliseconds
  } catch {
    Write-Frame @{ id = $rid; ok = $false; cmd = 'capture'; stage = 'send'; errorB64 = (New-B64 ($_.Exception.Message)); tookMs = [int]$sw.ElapsedMilliseconds; sendMs = $sendMs }
    return
  }
  # 内循环读剪贴板：命中条件 = 非空 且 与发键前不同（与 selectionReader 的语义一致，绝不把旧剪贴板当选区）
  $hit = ''
  while ($true) {
    $cur = Get-ClipText
    if ($cur.Length -gt 0 -and $cur -ne $before) { $hit = $cur; break }
    if ($sw.ElapsedMilliseconds -ge $timeoutMs) { break }
    Start-Sleep -Milliseconds $pollMs
  }
  if ($hit.Length -gt 0) {
    Write-Frame @{ id = $rid; ok = $true; cmd = 'capture'; hit = $true; textB64 = (New-B64 $hit); tookMs = [int]$sw.ElapsedMilliseconds; sendMs = $sendMs }
  } else {
    Write-Frame @{ id = $rid; ok = $true; cmd = 'capture'; hit = $false; textB64 = ''; tookMs = [int]$sw.ElapsedMilliseconds; sendMs = $sendMs }
  }
}

# 预热：Get-Clipboard 首次调用要加载 cmdlet（几十毫秒），把这份开销留在 ready 之前。
# 只读剪贴板，不发键、不修改剪贴板，因此启动时调用是安全的。
try { [void](Get-Clipboard -Raw) } catch { }
# 同理预热 SendKeys 的首次 COM 互操作调用（实测首次 ~70ms，首按热键会白吃一次）。
# SendKeys('') 是空串：不发送任何按键、不触碰任何窗口，仅让互操作桩完成首次绑定。
try { $wsh.SendKeys('') } catch { }

Write-Frame @{ id = 0; ok = $true; cmd = 'ready'; ps = $PSVersionTable.PSVersion.ToString() }
$reader = [Console]::In
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -lt 4) { continue }
  $req = $null
  try { $req = ConvertFrom-Json -InputObject $line } catch { Write-Frame @{ id = 0; ok = $false; cmd = 'badjson'; errorB64 = (New-B64 'bad request') }; continue }
  $rid = $req.id
  $c = $req.cmd
  try {
    if ($c -eq 'ping') { Write-Frame @{ id = $rid; ok = $true; cmd = 'ping' } }
    elseif ($c -eq 'capture') { Invoke-Capture $req }
    else { Write-Frame @{ id = $rid; ok = $false; cmd = $c; errorB64 = (New-B64 ('unknown cmd: ' + $c)) } }
  } catch {
    Write-Frame @{ id = $rid; ok = $false; cmd = $c; errorB64 = (New-B64 ($_.Exception.Message)) }
  }
}
`;

/** 供 -EncodedCommand 使用：UTF-16LE + base64 */
function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function b64(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
}

function unb64(s) {
  if (!s) return '';
  try {
    return Buffer.from(String(s), 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

class CaptureHost {
  /**
   * @param {object} [opts]
   * @param {number} [opts.readyTimeoutMs]
   * @param {(msg:string)=>void} [opts.onDebug]
   * @param {string} [opts.psPath] 覆盖 powershell 可执行文件（默认走 PATH 里的 powershell.exe）
   */
  constructor(opts = {}) {
    this._readyTimeoutMs = opts.readyTimeoutMs || READY_TIMEOUT_MS;
    this._onDebug = opts.onDebug || (() => {});
    this._psPath = opts.psPath || 'powershell.exe';
    this._proc = null;
    this._ready = null;
    this._pending = new Map();
    this._seq = 0;
    this._stderr = '';
    this._buf = '';
    this._lastExit = null;
    this._startReject = null;
    this._waitReady = null;
    // 主进程退出时必须带走长驻 PowerShell：Windows 上子进程不会随父进程自动结束，
    // 否则会留下一个挂着 WScript.Shell 的孤儿 powershell.exe。
    this._exitHandler = () => this._killSync();
    process.once('exit', this._exitHandler);
  }

  /** 抓选区依赖 SendKeys + Get-Clipboard，只有 Windows 有 */
  static get supported() {
    return process.platform === 'win32';
  }

  get isRunning() {
    return !!(this._proc && !this._proc.killed && this._proc.exitCode === null);
  }

  _killSync() {
    const p = this._proc;
    this._proc = null;
    this._ready = null;
    if (p && p.exitCode === null && !p.killed) {
      try {
        p.kill();
      } catch (e) {
        /* 已退出 */
      }
    }
  }

  _kill() {
    this._killSync();
  }

  _stderrTail() {
    const s = this._stderr.trim();
    return s ? ` | ${s.split('\n').slice(-2).join(' / ')}` : '';
  }

  /**
   * 拉起长驻进程（幂等；并发调用共享同一个 readyPromise）。
   * 进程已退出/已杀时再次调用即"自动重建"。
   */
  start() {
    if (this._ready && this.isRunning) return this._ready;
    if (!CaptureHost.supported) {
      return Promise.reject(new Error('当前平台不支持常驻抓取通道（仅 Windows）'));
    }
    this._ready = new Promise((resolve, reject) => {
      let proc;
      this._startReject = reject;
      try {
        proc = spawn(
          this._psPath,
          ['-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand(HOST_SCRIPT)],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
      } catch (e) {
        this._ready = null;
        this._startReject = null;
        const err = new Error(`抓取通道启动失败：${e.message}`);
        err.stage = 'start'; // 连进程都没起来 => 前台窗口没收到过 ^c，允许上层安全回退
        reject(err);
        return;
      }
      this._proc = proc;
      this._buf = '';
      this._stderr = '';

      const timer = setTimeout(() => {
        this._ready = null;
        this._startReject = null;
        this._kill();
        reject(new Error(`抓取通道启动超时（${this._readyTimeoutMs}ms）${this._stderrTail()}`));
      }, this._readyTimeoutMs);

      this._waitReady = (info) => {
        clearTimeout(timer);
        this._startReject = null;
        this._onDebug(`capture host ready: ${JSON.stringify(info || {})}`);
        resolve(info || {});
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this._buf += chunk;
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).replace(/\r$/, '');
          this._buf = this._buf.slice(idx + 1);
          this._onLine(line);
        }
      });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        this._stderr = (this._stderr + chunk).slice(-MAX_STDERR);
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        this._ready = null;
        this._startReject = null;
        const err = new Error(`抓取通道启动失败：${e.message}${this._stderrTail()}`);
        err.stage = 'start';
        this._rejectAll(err);
        reject(err);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        this._lastExit = { code, signal, at: Date.now() };
        this._proc = null;
        this._ready = null;
        const err = new Error(`抓取通道已退出（code=${code} signal=${signal}）${this._stderrTail()}`);
        err.stage = 'exit';
        this._rejectAll(err);
        if (this._startReject) {
          const r = this._startReject;
          this._startReject = null;
          r(err);
        }
      });
    });
    return this._ready;
  }

  _rejectAll(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  _onLine(line) {
    if (line.indexOf(FRAME_PREFIX) !== 0) {
      if (line.trim()) this._onDebug(`capture host: ${line.slice(0, 200)}`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line.slice(FRAME_PREFIX.length));
    } catch (e) {
      this._onDebug('capture host: 无法解析响应帧');
      return;
    }
    if (msg.cmd === 'ready' && this._waitReady) {
      const cb = this._waitReady;
      this._waitReady = null;
      cb(msg);
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    this._pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg);
    else {
      const err = new Error(unb64(msg.errorB64) || msg.error || '抓取通道调用失败');
      err.stage = msg.stage || 'capture';
      err.hostCode = msg.code;
      p.reject(err);
    }
  }

  /**
   * 发起一次调用
   * @param {'ping'|'capture'} cmd
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   */
  async request(cmd, payload = {}, timeoutMs) {
    await this.start();
    if (!this.isRunning) {
      const err = new Error('抓取通道未运行');
      err.stage = 'start';
      throw err;
    }
    const id = ++this._seq;
    const line = JSON.stringify({ id, cmd, ...payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // 超时多半意味着宿主卡死（SendKeys 被前台窗口拖住 / 剪贴板被占用）：杀掉，下次请求自动重建。
        this._kill();
        const err = new Error(`抓取通道调用超时（${cmd}，${timeoutMs || this._readyTimeoutMs}ms）`);
        err.stage = 'timeout';
        err.timedOut = true;
        reject(err);
      }, timeoutMs || this._readyTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(line + '\n');
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        this._kill();
        const err = new Error(`写入抓取通道失败：${e.message}`);
        err.stage = 'write';
        reject(err);
      }
    });
  }

  /**
   * 抓一次选区：发 Ctrl+C → 内循环读剪贴板直到内容变化或超时。
   * @param {object} o
   * @param {string} o.before  发键前的剪贴板文本（用于判断"是否真的复制到了新内容"）
   * @param {number} [o.timeoutMs]
   * @param {number} [o.pollMs]
   * @returns {Promise<{hit:boolean, text:string, tookMs:number, sendMs:number}>}
   */
  async capture(o = {}) {
    const timeoutMs = Number(o.timeoutMs) > 0 ? Math.round(Number(o.timeoutMs)) : DEFAULT_TIMEOUT_MS;
    const pollMs = Number(o.pollMs) > 0 ? Math.round(Number(o.pollMs)) : DEFAULT_POLL_MS;
    const msg = await this.request(
      'capture',
      { beforeB64: b64(o.before || ''), timeoutMs, pollMs },
      timeoutMs + REQUEST_MARGIN_MS
    );
    return {
      hit: !!msg.hit,
      text: unb64(msg.textB64),
      tookMs: Number(msg.tookMs) || 0,
      sendMs: Number(msg.sendMs) >= 0 ? Number(msg.sendMs) : -1,
    };
  }

  /** 活体探针：确认行协议真的通了（不做任何按键/剪贴板动作） */
  async ping() {
    await this.request('ping', {}, PING_TIMEOUT_MS);
    return true;
  }

  dispose() {
    this._rejectAll(new Error('抓取通道已释放'));
    this._kill();
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
  }
}

// ---- 单例 ----

let _singleton = null;

/** 取全局唯一宿主（懒创建；不启动） */
function getCaptureHost() {
  if (!_singleton) _singleton = new CaptureHost();
  return _singleton;
}

let _initPromise = null;

/**
 * 幂等预热：拉起常驻 PowerShell + ping 一次确认协议连通。
 * 失败不抛异常（返回 ok=false），并允许下次再调重试；成功后重复调用直接复用同一个 Promise。
 *
 * @param {object} [opts] 透传给 CaptureHost（readyTimeoutMs / onDebug / psPath）
 * @returns {Promise<{ok:boolean, warmMs:number, error:string}>}
 */
function initCaptureHost(opts) {
  if (_initPromise) return _initPromise;
  const t0 = Date.now();
  _initPromise = (async () => {
    if (!CaptureHost.supported) {
      return { ok: false, warmMs: 0, error: '当前平台不支持常驻抓取通道（仅 Windows）' };
    }
    try {
      if (opts && !_singleton) _singleton = new CaptureHost(opts);
      const host = getCaptureHost();
      await host.start();
      await host.ping();
      return { ok: true, warmMs: Date.now() - t0, error: '' };
    } catch (e) {
      _initPromise = null;
      return { ok: false, warmMs: Date.now() - t0, error: (e && e.message) || String(e) };
    }
  })();
  return _initPromise;
}

/** 仅供测试/探针：销毁单例，下一次调用会重新建进程 */
function resetCaptureHost() {
  if (_singleton) _singleton.dispose();
  _singleton = null;
  _initPromise = null;
}

module.exports = {
  CaptureHost,
  HOST_SCRIPT,
  encodedCommand,
  b64,
  unb64,
  getCaptureHost,
  initCaptureHost,
  resetCaptureHost,
  FRAME_PREFIX,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
};
