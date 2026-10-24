// 屏幕取词宿主：常驻 PowerShell + Windows 自带 OCR。
//
// 为什么不用 UIA / MSAA：实测两者在 Chromium 上取不到文本——
//   · UIA 的 FromPoint 只返回 Chrome_RenderWidgetHostHWND（Pane），没有 TextPattern；
//   · MSAA 的 AccessibleObjectFromPoint 返回 role=16（客户区）+ accName 为空，
//     因为 Chromium 只在**进程启动时**检测「屏幕阅读器在运行」标志才构建无障碍树，
//     运行中再设 SPI_SETSCREENREADER 不生效（实测 20 个采样点全为空）。
// 而悬停朗读的主要场景恰恰是浏览器里的网页正文，所以必须换一条不依赖目标程序的路：
// **截图 + 系统 OCR**。它对任何窗口都有效（浏览器 / PDF / 图片 / 游戏），也不动用户的选区与剪贴板。
//
// 实测数据（本机 1920x1080 / 中文）：
//   引擎语言 zh-Hans-CN；900x360 区域识别 21 行，OCR 本身约 100~175ms；
//   返回每行的 Y 与高度，用于挑出「指针正落在哪一行」。
//
// 协议：stdin/stdout 每行一条 JSON（与 sapiHost 同一套思路），纯 ASCII 头部 + UTF-8 正文。
// 关键坑（都踩过）：
//   1. 必须显式设 [Console]::OutputEncoding=UTF8，否则中文按 GBK 输出，Node 侧全是乱码；
//   2. WinRT 的 StorageFile 只接受反斜杠路径（正斜杠报 0x800700A1）；
//   3. WinRT 集合（IVectorView）不能直接 foreach / .Count，要先 @() 物化。
'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const FRAME_PREFIX = '__OCR__';
const START_TIMEOUT = 15000;
const CALL_TIMEOUT = 6000;

/** PowerShell 侧脚本：初始化一次，之后循环处理请求 */
function buildScript() {
  const tmpFile = path.join(os.tmpdir(), 'mingread-ocr.png');
  return `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# --- WinRT 类型预加载 ---
try {
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch {
  Write-Output ("${FRAME_PREFIX}{""ready"":false,""error"":""init:" + $_.Exception.Message.Replace('"','') + """}")
  exit 1
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$engine = $null
try {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
} catch { }
if ($null -eq $engine) {
  Write-Output ("${FRAME_PREFIX}{""ready"":false,""error"":""no-engine""}")
  exit 1
}

Write-Output ("${FRAME_PREFIX}{""ready"":true,""lang"":""" + $engine.RecognizerLanguage.LanguageTag + """}")

$tmp = '${tmpFile}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'quit') { break }
  if ($line.Trim().Length -eq 0) { continue }

  $id = 0
  $ok = $false
  $payload = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $x = [int]$req.x; $y = [int]$req.y; $w = [int]$req.w; $h = [int]$req.h
    $t0 = [DateTime]::Now

    # 截图（物理像素坐标，与 UIA/OCR 一致）
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()

    $items = @()
    foreach ($ln in @($res.Lines)) {
      $ws = @($ln.Words)
      if ($ws.Count -eq 0) { continue }
      $top = [int]($ws[0].BoundingRect.Y)
      $bot = $top
      foreach ($wd in $ws) {
        $b = $wd.BoundingRect
        if ([int]$b.Y -lt $top) { $top = [int]$b.Y }
        if (([int]$b.Y + [int]$b.Height) -gt $bot) { $bot = [int]$b.Y + [int]$b.Height }
      }
      $items += ('{"t":' + (ConvertTo-Json -InputObject $ln.Text -Compress) + ',"y":' + $top + ',"h":' + ($bot - $top) + '}')
    }
    $payload = '{"id":' + $id + ',"ok":true,"ms":' + [int]([DateTime]::Now - $t0).TotalMilliseconds + ',"lines":[' + ($items -join ',') + ']}'
    $ok = $true
  } catch {
    $msg = $_.Exception.Message -replace '"', "'"
    $payload = '{"id":' + $id + ',"ok":false,"error":"' + $msg + '"}'
  }
  Write-Output ("${FRAME_PREFIX}" + $payload)
}
`;
}

class OcrHost {
  constructor() {
    this._proc = null;
    this._buf = '';
    this._seq = 0;
    this._pending = new Map();
    this._ready = null;
    this._startPromise = null;
    this._stderr = '';
    this._lang = '';
    this._lastError = '';
  }

  get lastError() {
    return this._lastError;
  }

  get lang() {
    return this._lang;
  }

  /** 启动常驻进程。重复调用复用同一个 Promise。 */
  start() {
    if (this._ready) return Promise.resolve(this._ready);
    if (this._startPromise) return this._startPromise;

    this._startPromise = new Promise((resolve, reject) => {
      const script = buildScript();
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const exe = process.env.MR_PS || 'powershell.exe';
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];

      let proc;
      try {
        proc = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        this._startPromise = null;
        reject(new Error(`OCR 宿主启动失败：${e.message}`));
        return;
      }
      this._proc = proc;

      const timer = setTimeout(() => {
        this._lastError = 'start-timeout';
        try { proc.kill(); } catch (e) { /* noop */ }
        this._startPromise = null;
        reject(new Error('OCR 宿主启动超时'));
      }, START_TIMEOUT);

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this._buf += chunk;
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).replace(/\r$/, '');
          this._buf = this._buf.slice(idx + 1);
          this._onLine(line, timer, resolve, reject);
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (c) => {
        this._stderr = (this._stderr + c).slice(-800);
      });

      proc.on('error', (e) => {
        clearTimeout(timer);
        this._lastError = e.message;
        this._startPromise = null;
        this._rejectAll(new Error(`OCR 宿主错误：${e.message}`));
        reject(e);
      });

      proc.on('exit', (code) => {
        clearTimeout(timer);
        this._proc = null;
        this._ready = null;
        this._startPromise = null;
        this._lastError = `exit(${code})`;
        this._rejectAll(new Error(`OCR 宿主已退出（code=${code}）${this._stderr ? ' ' + this._stderr.slice(0, 200) : ''}`));
      });
    });

    return this._startPromise;
  }

  _onLine(line, timer, resolve, reject) {
    if (line.indexOf(FRAME_PREFIX) !== 0) return; // 忽略杂音（如 CLIXML）
    let msg;
    try {
      msg = JSON.parse(line.slice(FRAME_PREFIX.length));
    } catch (e) {
      return;
    }
    if (msg.ready === true) {
      clearTimeout(timer);
      this._ready = { lang: msg.lang || '' };
      this._lang = msg.lang || '';
      resolve(this._ready);
      return;
    }
    if (msg.ready === false) {
      clearTimeout(timer);
      this._lastError = msg.error || 'init-failed';
      this._startPromise = null;
      reject(new Error(`OCR 初始化失败：${this._lastError}`));
      return;
    }
    const p = this._pending.get(msg.id);
    if (p) {
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ lines: msg.lines || [], ms: msg.ms || 0 });
      else p.reject(new Error(msg.error || 'ocr-failed'));
    }
  }

  _rejectAll(err) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  /**
   * 识别一块屏幕区域（物理像素）
   * @returns {Promise<{lines: Array<{t:string,y:number,h:number}>, ms:number}>}
   */
  async recognize({ x, y, w, h }) {
    await this.start();
    if (!this._proc || !this._ready) throw new Error('OCR 宿主未就绪');
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('OCR 超时'));
      }, CALL_TIMEOUT);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(`${JSON.stringify({ id, x, y, w, h })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  dispose() {
    try {
      if (this._proc && this._proc.stdin.writable) this._proc.stdin.write('quit\n');
    } catch (e) { /* noop */ }
    try {
      if (this._proc) this._proc.kill();
    } catch (e) { /* noop */ }
    this._proc = null;
    this._ready = null;
    this._startPromise = null;
  }
}

module.exports = { OcrHost };
