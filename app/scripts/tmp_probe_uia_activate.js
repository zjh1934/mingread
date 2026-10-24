// 决定性实验：先给 Chromium 发 WM_GETOBJECT 激活无障碍树，再查 UIA。
//
// 背景：上一轮我只调了一次 AutomationElement.FromPoint，拿到 Chrome_RenderWidgetHostHWND
// 就判定「Chromium 上 UIA 不可用」，转头去做 OCR。调研指出**这个结论下早了**：
// Chromium 是懒加载无障碍树的，等一个 WM_GETOBJECT（UiaRootObjectId）消息才构建。
//
// 如果本探针能拿到 TextPattern + 精确文本 + 文本矩形，那么：
//   · 粒度可以做到「字符级」，能精确高亮当前句
//   · 不再依赖 OCR 的识别误差
//   · 这是产品级方案，OCR 只能当兜底
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { app, screen } = require('electron');

process.env.VITE_DEV_SERVER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'index.html')
).href;

const mod = require('../src/main/index.js');

const WM_GETOBJECT = 0x003D;
const UiaRootObjectId = -25;

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runUiaQuery(x, y) {
  const PS = `
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  # System.Windows.Point 定义在 WindowsBase 里。少加载它 → "找不到类型 [System.Windows.Point]"
  # （上一版探针碰巧加载了 System.Windows.Forms，间接带进 WindowsBase 才没暴露）
  Add-Type -AssemblyName WindowsBase
} catch { Write-Output ("ERR|load|" + $_.Exception.Message); exit 1 }

$pt = New-Object System.Windows.Point(${x}, ${y})
try {
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
} catch { Write-Output ("ERR|frompoint|" + $_.Exception.Message); exit 1 }
if ($null -eq $el) { Write-Output "INFO|element|null"; exit 0 }

$nm = $el.Current.Name; if ($null -eq $nm) { $nm = '' }
Write-Output ("INFO|element|type=" + $el.Current.ControlType.ProgrammaticName + "|class=" + $el.Current.ClassName + "|name=" + ($nm -replace "\`r?\`n", " / "))

$tp = $null
$has = $false
try { $has = $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp) } catch { }
Write-Output ("INFO|textpattern|" + $has)

if ($has) {
  try {
    $r = $tp.RangeFromPoint($pt)
    if ($null -ne $r) {
      $txt = $r.GetText(300); if ($null -eq $txt) { $txt = '' }
      Write-Output ("INFO|rawtext|" + ($txt -replace "\`r?\`n", " / "))
      # 句级扩张：UIA 的 TextUnit 没有 Sentence，用 Paragraph 观察结构
      try {
        $para = $r.Clone()
        $para.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Paragraph)
        $ptxt = $para.GetText(500); if ($null -eq $ptxt) { $ptxt = '' }
        Write-Output ("INFO|paragraph|" + ($ptxt -replace "\`r?\`n", " / "))
        $rects = $para.GetBoundingRectangles()
        Write-Output ("INFO|rects|" + (@($rects).Count))
      } catch { Write-Output ("WARN|expand|" + $_.Exception.Message) }
      try {
        $line = $r.Clone()
        $line.ExpandToEnclosingUnit([System.Windows.Automation.Text.TextUnit]::Line)
        $ltxt = $line.GetText(300); if ($null -eq $ltxt) { $ltxt = '' }
        Write-Output ("INFO|line|" + ($ltxt -replace "\`r?\`n", " / "))
      } catch { }
    } else { Write-Output "INFO|range|null" }
  } catch { Write-Output ("ERR|range|" + $_.Exception.Message) }
}
`;
  return new Promise((resolve) => {
    const encoded = Buffer.from(PS, 'utf16le').toString('base64');
    const child = spawn(process.env.MR_PS || 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => resolve('ERR|spawn|' + e.message));
    child.on('close', () => {
      if (err) {
        // CLIXML 里塞的是真正的异常文本，剥掉标签只留可读部分
        const plain = err.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
        out += '\nERR|stderr|' + plain.slice(0, 600);
      }
      resolve(out);
    });
  });
}

app.whenReady().then(async () => {
  // 先分清两件事：UIA 的查法对不对 / Chromium 的 a11y 树有没有被启用。
  // app.setAccessibilitySupportEnabled(true) 是 Electron 给的显式开关，
  // 打开后如果还是查不到文本，那问题就在查法（而不是启用状态）。
  try {
    app.setAccessibilitySupportEnabled(true);
    console.log('[uia] setAccessibilitySupportEnabled(true)');
  } catch (e) {
    console.log('[uia] 启用无障碍失败: ' + e.message);
  }
  await sleep(4200);
  const win = mod.getMainWindow();
  if (!win) { check('A0', '窗口存在', false, 'null'); app.exit(1); return; }

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const FindWindowExW = user32.func('void *FindWindowExW(void *hWndParent, void *hWndChildAfter, str16 lpszClass, str16 lpszWindow)');
  const SendMessageW = user32.func('int64 SendMessageW(void *hWnd, uint32 msg, uint64 wParam, int64 lParam)');

  const buf = win.getNativeWindowHandle();
  const parentHwnd = buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
  console.log(`[uia] 主窗口 hwnd=0x${parentHwnd.toString(16)}`);

  const child = FindWindowExW(parentHwnd, null, 'Chrome_RenderWidgetHostHWND', null);
  const childHwnd = child ? (typeof child === 'bigint' ? child : BigInt(child)) : 0n;
  check('A1', '找到 render widget 子窗口', childHwnd > 0n, `hwnd=0x${childHwnd.toString(16)}`);

  // 取值 1（AHK 社区做法）与 UiaRootObjectId 各发一次，两个都试
  const r1 = SendMessageW(childHwnd, WM_GETOBJECT, 0n, 1n);
  console.log(`[uia] SendMessage(WM_GETOBJECT, lParam=1) -> ${r1}`);
  const r2 = SendMessageW(childHwnd, WM_GETOBJECT, 0n, BigInt(UiaRootObjectId));
  console.log(`[uia] SendMessage(WM_GETOBJECT, lParam=-25) -> ${r2}`);

  // 触发后需要时间构建无障碍树
  await sleep(3000);

  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x + 10, y: b.y + 10 });
  const sf = (d && d.scaleFactor) || 1;

  // 目标点：首屏状态卡标题（「选中文字，按 F1 就朗读」）附近
  const probeDip = { x: Math.round(b.x + b.width * 0.5), y: Math.round(b.y + b.height * 0.22) };
  const px = Math.round(probeDip.x * sf);
  const py = Math.round(probeDip.y * sf);
  console.log(`[uia] 查询点 ${px},${py}（DIP ${probeDip.x},${probeDip.y} sf=${sf}）`);

  for (let i = 1; i <= 5; i += 1) {
    const out = await runUiaQuery(px, py);
    const lines = out.split(/\r?\n/).filter((l) => l.startsWith('INFO|') || l.startsWith('ERR|') || l.startsWith('WARN|'));
    console.log(`[uia] --- 第 ${i} 次 ---`);
    lines.forEach((l) => console.log('[uia] ' + l));
    const hasTp = lines.some((l) => l.includes('textpattern|True'));
    if (hasTp) {
      check('B1', '激活后拿到 TextPattern', true, '命中');
      const raw = lines.find((l) => l.startsWith('INFO|rawtext|'));
      check('B2', '能取到指针处的原始文本', !!raw && raw.replace('INFO|rawtext|', '').trim().length > 0, raw ? raw.slice(0, 80) : '(无)');
      const para = lines.find((l) => l.startsWith('INFO|paragraph|'));
      check('B3', '能按段落扩张（可做句/段粒度）', !!para, para ? para.slice(0, 80) : '(无)');
      const rects = lines.find((l) => l.startsWith('INFO|rects|'));
      check('B4', '能拿到文本矩形（可做精确高亮）', !!rects && !rects.endsWith('|0'), rects || '(无)');
      break;
    }
    if (i === 5) check('B1', '激活后拿到 TextPattern', false, '五次都未命中');
    await sleep(1500);
  }

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(0), 500);
});
