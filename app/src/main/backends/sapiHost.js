// SAPI 长驻通道（sapiHost）
//
// 为什么需要长驻：NVSA 的延迟优势在百毫秒级，而 PowerShell 冷启动就要 200~400ms，
// 若每次合成都 `powershell -Command "..."` 起一个新进程，冷启动开销会把本地引擎的优势全吃掉。
// 因此本模块把 PowerShell 作为**一次性启动、长驻复用**的子进程：
//   · 进程内只创建一次 SpeechSynthesizer（COM 对象与语音数据常驻内存，第二次起无加载开销）
//   · Node 与它之间用 stdin/stdout 行协议通信（纯 ASCII + base64 载荷，规避控制台编码问题）
//   · 冷启动只在应用空闲时（warmup）支付一次，热键路径上不再支付
// 选型取舍：
//   · PowerShell + System.Speech：零原生模块、零编译、Win7/Win10/Win11 自带，符合"不引入需编译模块"约束。
//   · 放弃每次起进程（冷启动）／放弃写临时 .ps1 再 -File（asar 内无法被外部进程读取、且留盘）。
//     -EncodedCommand 直接把脚本以 UTF-16LE base64 传给 powershell，无需落盘、无需执行策略改动。
//   · 放弃命名管道：Node↔子进程的三根匿名管道已是本机最低开销，命名管道只增加复杂度。
'use strict';

const { spawn } = require('child_process');

const FRAME_PREFIX = 'LDNSAPI ';
const READY_TIMEOUT_MS = 20000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_STDERR = 4096;

/**
 * 长驻 PowerShell 宿主脚本（在 Windows PowerShell 5.1 与 pwsh 7 下均可运行）。
 * 注意：本字符串内不得出现反引号（PowerShell 转义符）与反斜杠。
 */
const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { [Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false) } catch { }
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

function New-B64([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
function Get-B64([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}
function Write-Frame($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8
  [Console]::Out.WriteLine('LDNSAPI ' + $json)
  [Console]::Out.Flush()
}
function Get-XmlEscaped([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;').Replace("'",'&apos;')
}
function Get-VoiceList() {
  $list = New-Object System.Collections.ArrayList
  foreach ($v in $synth.GetInstalledVoices()) {
    $info = $v.VoiceInfo
    $item = @{ name = (New-B64 $info.Name); culture = (New-B64 ($info.Culture.ToString())); gender = ($info.Gender.ToString()); id = (New-B64 $info.Id); desc = (New-B64 $info.Description) }
    [void]$list.Add($item)
  }
  return ,$list.ToArray()
}
function Invoke-Warmup() {
  # 预热：静音合成一个字符，强制 NVSA 引擎 DLL 与语音数据完成首次加载，
  # 否则第一次真实合成可能卡在数秒的模型加载上（延迟红线）。
  $oldVol = $synth.Volume
  try {
    $synth.Volume = 0
    $synth.SetOutputToNull()
    $synth.Speak(' ')
  } catch { }
  finally { $synth.Volume = $oldVol }
}
function Invoke-Synth($req) {
  $rid = $req.id
  $text = Get-B64 $req.textB64
  $voiceName = Get-B64 $req.voiceB64
  if ($voiceName.Length -gt 0 -and $synth.Voice.Name -ne $voiceName) { $synth.SelectVoice($voiceName) }
  $synth.Rate = [int]$req.rate
  $synth.Volume = [int]$req.volume
  $pitch = [int]$req.pitchHz
  $stream = New-Object System.IO.MemoryStream
  $synth.SetOutputToWaveStream($stream)
  $spoke = $false
  if ($pitch -ne 0) {
    $sign = ''
    if ($pitch -gt 0) { $sign = '+' }
    $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody pitch="' + $sign + $pitch + 'Hz">' + (Get-XmlEscaped $text) + '</prosody></speak>'
    try { $synth.SpeakSsml($ssml); $spoke = $true }
    catch {
      # SSML 失败（部分 SAPI 语音不支持）：丢弃可能写了一半的流，退回纯文本
      $spoke = $false
      try { $stream.Dispose() } catch { }
      $stream = New-Object System.IO.MemoryStream
      $synth.SetOutputToWaveStream($stream)
    }
  }
  if (-not $spoke) { $synth.Speak($text) }
  $bytes = $stream.ToArray()
  try { $stream.Dispose() } catch { }
  $fmt = $synth.Voice.AudioFormat
  Write-Frame @{ id = $rid; ok = $true; cmd = 'synth'; audioB64 = ([Convert]::ToBase64String($bytes)); sampleRate = [int]$fmt.SamplesPerSecond; bitsPerSample = [int]$fmt.BitsPerSample; channels = [int]$fmt.ChannelCount }
}

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
    elseif ($c -eq 'voices') { Write-Frame @{ id = $rid; ok = $true; cmd = 'voices'; voices = (Get-VoiceList) } }
    elseif ($c -eq 'warmup') { Invoke-Warmup; Write-Frame @{ id = $rid; ok = $true; cmd = 'warmup' } }
    elseif ($c -eq 'synth') { Invoke-Synth $req }
    else { Write-Frame @{ id = $rid; ok = $false; cmd = $c; errorB64 = (New-B64 ('unknown cmd: ' + $c)) } }
  } catch {
    Write-Frame @{ id = $rid; ok = $false; cmd = $c; errorB64 = (New-B64 ($_.Exception.Message)) }
  }
}
try { $synth.Dispose() } catch { }
`;

/** 供 -EncodedCommand 使用：UTF-16LE + base64 */
function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function b64(s) {
  return Buffer.from(String(s == null ? '' : s), 'utf8').toString('base64');
}

class SapiHost {
  /**
   * @param {object} [opts]
   * @param {number} [opts.readyTimeoutMs]
   * @param {number} [opts.requestTimeoutMs]
   * @param {(msg:string)=>void} [opts.onDebug]
   */
  constructor(opts = {}) {
    this._readyTimeoutMs = opts.readyTimeoutMs || READY_TIMEOUT_MS;
    this._requestTimeoutMs = opts.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
    this._onDebug = opts.onDebug || (() => {});
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
    // 否则会留下一个挂着 SAPI 引擎的孤儿 powershell.exe。
    this._exitHandler = () => this._killSync();
    process.once('exit', this._exitHandler);
  }

  /** 同步杀掉子进程（仅供进程退出时使用） */
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

  /**
   * SAPI 只在 Windows 上存在；非 Windows 一律不可用（沙箱/Linux 走在线兜底）。
   * 例外：设置了 LDN_SAPI_HOST（注入宿主进程，仅测试用），允许在任意平台跑通同一套协议，
   * 以便在 Linux 沙箱里验证引擎抽象层的路由与降级逻辑。
   */
  static get supported() {
    return process.platform === 'win32' || !!process.env.LDN_SAPI_HOST;
  }

  /**
   * 宿主进程命令行：
   * · 默认 Windows PowerShell 5.1（Win7/10/11 自带，System.Speech 必然可用）
   * · LDN_SAPI_HOST 可注入任意可执行文件（仅用于测试替身，实现同一行协议）
   * @returns {{file:string, args:string[]}}
   */
  _command() {
    if (process.env.LDN_SAPI_HOST) {
      const rawArgs = process.env.LDN_SAPI_HOST_ARGS;
      let args = [];
      if (rawArgs) {
        try {
          const parsed = JSON.parse(rawArgs);
          if (Array.isArray(parsed)) args = parsed.map(String);
        } catch (e) {
          args = [];
        }
      }
      return { file: process.env.LDN_SAPI_HOST, args };
    }
    const ps = process.env.LDN_SAPI_PS || 'powershell.exe';
    return {
      file: ps,
      args: ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(HOST_SCRIPT)],
    };
  }

  get isRunning() {
    return !!(this._proc && !this._proc.killed && this._proc.exitCode === null);
  }

  /** 拉起长驻进程（幂等；并发调用共享同一个 readyPromise） */
  start() {
    if (this._ready && this.isRunning) return this._ready;
    if (!SapiHost.supported) {
      return Promise.reject(new Error('当前平台不支持 SAPI（仅 Windows）'));
    }
    this._ready = new Promise((resolve, reject) => {
      const { file, args } = this._command();
      let proc;
      this._startReject = reject; // 宿主进程若在 ready 之前退出，用它把 start() 打醒（否则调用方会永久挂起）
      try {
        proc = spawn(file, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        this._ready = null;
        this._startReject = null;
        reject(new Error(`本地语音通道启动失败：${e.message}`));
        return;
      }
      this._proc = proc;
      this._buf = '';
      this._stderr = '';

      const timer = setTimeout(() => {
        this._ready = null;
        this._startReject = null;
        this._kill();
        reject(new Error(`本地语音通道启动超时（${this._readyTimeoutMs}ms）${this._stderrTail()}`));
      }, this._readyTimeoutMs);

      const onReady = (info) => {
        clearTimeout(timer);
        this._startReject = null;
        this._onDebug(`sapi host ready: ${JSON.stringify(info || {})}`);
        resolve(info || {});
      };
      this._waitReady = onReady;

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
        const err = new Error(`本地语音通道启动失败：${e.message}${this._stderrTail()}`);
        this._rejectAll(err);
        reject(err);
      });
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        this._lastExit = { code, signal, at: Date.now() };
        this._proc = null;
        this._ready = null;
        const err = new Error(`本地语音通道已退出（code=${code} signal=${signal}）${this._stderrTail()}`);
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

  _stderrTail() {
    const s = this._stderr.trim();
    return s ? ` | ${s.split('\n').slice(-2).join(' / ')}` : '';
  }

  _kill() {
    if (this._proc && this._proc.exitCode === null) {
      try {
        this._proc.kill();
      } catch (e) {
        /* 已退出 */
      }
    }
    this._proc = null;
    this._ready = null;
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
      if (line.trim()) this._onDebug(`sapi host: ${line.slice(0, 200)}`);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(line.slice(FRAME_PREFIX.length));
    } catch (e) {
      this._onDebug(`sapi host: 无法解析响应帧`);
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
      const err = new Error(msg.errorB64 ? Buffer.from(msg.errorB64, 'base64').toString('utf8') : (msg.error || '本地语音调用失败'));
      err.hostCode = msg.code;
      p.reject(err);
    }
  }

  /**
   * 发起一次调用
   * @param {'ping'|'voices'|'synth'|'warmup'} cmd
   * @param {object} [payload]
   * @param {number} [timeoutMs]
   */
  async request(cmd, payload = {}, timeoutMs) {
    await this.start();
    if (!this.isRunning) throw new Error('本地语音通道未运行');
    const id = ++this._seq;
    const line = JSON.stringify({ id, cmd, ...payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // 超时通常意味着宿主卡死（SAPI 同步 Speak 阻塞）：重启通道，避免后续请求全部堆积
        this._kill();
        reject(new Error(`本地语音调用超时（${cmd}，${timeoutMs || this._requestTimeoutMs}ms）`));
      }, timeoutMs || this._requestTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(line + '\n');
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        this._kill();
        reject(new Error(`写入本地语音通道失败：${e.message}`));
      }
    });
  }

  dispose() {
    this._rejectAll(new Error('本地语音通道已释放'));
    this._kill();
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }
  }
}

module.exports = { SapiHost, HOST_SCRIPT, encodedCommand, b64 };
