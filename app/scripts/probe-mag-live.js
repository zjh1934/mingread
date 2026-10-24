// 放大镜「出画」实证探针 v3（W-MAG2 / 只做验证，不动产品代码）
//
// 目的：用 Windows Magnification API 真跑出放大画面，并用截图证明：
//   (a) 画面来自系统 DWM 合成（不是旧的 getUserMedia + CSS transform 覆盖层）；
//   (b) 屏幕上没有旧方案那种「鼠标周围嵌套的方形线条」。
//
// 实验设计（左原图 / 右放大，同屏对照）：
//   左半屏 = Electron 测试卡（纯 HTML：40px 网格、1px 细线、色块、文字）
//   右半屏 = 放大宿主，源矩形取测试卡中心，2x / 4x 铺满右半屏
//   → 单张桌面截图里同时有「原始像素」与「系统放大像素」；网格 40px→80px/160px 肉眼可判。
//
// 三种宿主方式逐一试：
//   A. Electron 窗口 HWND 直接喂 MagSetWindowSource
//   B. WC_MAGNIFIER 顶层 popup
//   C. WC_MAGNIFIER 作为 Electron 宿主窗口的子窗口（CreateWindowExW 直接指定 parent）
//
// 运行：cd app && node node_modules/electron/cli.js scripts/probe-mag-live.js
// 产物：scripts/probe-mag-live-out/*.png + report.json
//
// 安全：MagInitialize 之后，所有退出路径（process.on('exit') + uncaughtException + 主流程）
// 先复位全屏变换到 1.0 再 MagUninitialize，绝不把系统留在放大态。
'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, screen, desktopCapturer, nativeImage } = require('electron');

const OUT_DIR = path.join(__dirname, 'probe-mag-live-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const LOG = [];
function L(step, data) {
  const rec = { t: Date.now(), step, ...(data || {}) };
  LOG.push(rec);
  console.log(`[${step}] ${JSON.stringify(data || {})}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let koffi = null;
let api = null;
let inited = false;
let hostWin = null;
let cardWin = null;
let magHwnd = null;
let followTimer = null;

const hex = (h) => (typeof h === 'bigint' ? '0x' + h.toString(16).toUpperCase() : String(h));
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}
function rectBuf(x, y, w, h) {
  const b = Buffer.alloc(16);
  [x, y, x + w, y + h].forEach((v, i) => b.writeInt32LE(Math.round(v), i * 4));
  return b;
}
function matrixBuf(s) {
  const b = Buffer.alloc(36);
  [s, 0, 0, 0, s, 0, 0, 0, 1].forEach((v, i) => b.writeFloatLE(v, i * 4));
  return b;
}
const cropRect = (r) => ({ x: r.x, y: r.y, width: r.w, height: r.h });

// ---------------------------------------------------------------- 清理
let cleaned = false;
function cleanup(reason) {
  if (cleaned) return;
  cleaned = true;
  try { if (followTimer) clearInterval(followTimer); } catch (_) {}
  try { if (magHwnd && api && api.DestroyWindow) api.DestroyWindow(magHwnd); } catch (_) {}
  try {
    if (inited && api) {
      const lv = Buffer.alloc(4); const ox = Buffer.alloc(4); const oy = Buffer.alloc(4);
      api.MagGetFullscreenTransform(lv, ox, oy);
      const before = lv.readFloatLE(0);
      if (before !== 1) api.MagSetFullscreenTransform(1.0, 0, 0);
      api.MagGetFullscreenTransform(lv, ox, oy);
      const un = api.MagUninitialize();
      inited = false;
      L('cleanup', { reason: reason || 'normal', fullscreenBefore: before, fullscreenAfter: lv.readFloatLE(0), magUninitialize: !!un });
    }
  } catch (e) { L('cleanup.error', { message: (e && e.message) || String(e) }); }
  try { if (hostWin && !hostWin.isDestroyed()) hostWin.destroy(); } catch (_) {}
  try { if (cardWin && !cardWin.isDestroyed()) cardWin.destroy(); } catch (_) {}
}
process.on('exit', () => { try { cleanup('process.exit'); } catch (_) {} });

// ---------------------------------------------------------------- 图像分析
function stats(img) {
  const { width: w, height: h } = img.getSize();
  if (!w || !h) return { w: 0, h: 0, empty: true };
  const bmp = img.toBitmap(); // BGRA
  let black = 0; let n = 0;
  const colors = new Set();
  for (let y = 0; y < h; y += 5) {
    for (let x = 0; x < w; x += 5) {
      const i = (y * w + x) * 4;
      const r = bmp[i + 2]; const g = bmp[i + 1]; const b = bmp[i];
      if (Math.max(r, g, b) < 12) black += 1;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      n += 1;
    }
  }
  const ci = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  return {
    w, h,
    pctBlack: +(black / n * 100).toFixed(1),
    colors: colors.size,
    center: `rgb(${bmp[ci + 2]},${bmp[ci + 1]},${bmp[ci]})`,
  };
}

function mad(a, b) {
  if (!a || !b) return null;
  const sa = a.getSize(); const sb = b.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) return null;
  const ba = a.toBitmap(); const bb = b.toBitmap();
  let s = 0; let n = 0;
  for (let y = 0; y < sa.height; y += 4) {
    for (let x = 0; x < sa.width; x += 4) {
      const i = (y * sa.width + x) * 4;
      s += Math.abs(ba[i] - bb[i]) + Math.abs(ba[i + 1] - bb[i + 1]) + Math.abs(ba[i + 2] - bb[i + 2]);
      n += 3;
    }
  }
  return +(s / n).toFixed(2);
}

const REC = { startedAt: new Date().toISOString(), shots: {}, analysis: {}, trials: [], diff: {}, follow: {}, verdict: {} };

function saveImg(name, img) {
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, img.toPNG());
  const bytes = fs.statSync(p).size;
  // 写盘后回读自校验：证明报告里的数值与磁盘上的 PNG 是同一张图
  const back = nativeImage.createFromPath(p);
  const s = stats(back);
  REC.shots[name] = { path: p, bytes, size: img.getSize(), verifyBackSize: back.getSize(), verifyBackCenter: s.center, verifyBackColors: s.colors };
  L('shot', { name, path: p, bytes, size: img.getSize(), back: back.getSize(), backCenter: s.center, backColors: s.colors });
  return { path: p, img };
}

async function grabDesktop(tag) {
  try {
    const d = screen.getPrimaryDisplay();
    const w = Math.round(d.size.width * d.scaleFactor);
    const h = Math.round(d.size.height * d.scaleFactor);
    const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h }, fetchWindowIcons: false });
    if (!list.length) return { error: 'desktopCapturer 空列表' };
    const src = list.find((s) => String(s.display_id) === String(d.id)) || list[0];
    const img = src.thumbnail;
    const file = path.join(OUT_DIR, `desktop-${tag}.png`);
    fs.writeFileSync(file, img.toPNG());
    L('desktopShot', { tag, file, size: img.getSize() });
    return { img, file };
  } catch (e) {
    L('desktopShot.error', { tag, message: (e && e.message) || String(e) });
    return { error: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------- Win32
function initUser32() {
  if (api.CreateWindowExW) return;
  const u = koffi.load('user32.dll');
  api.CreateWindowExW = u.func('void *CreateWindowExW(uint32_t exStyle, str16 className, str16 winName, uint32_t style, int32_t x, int32_t y, int32_t cx, int32_t cy, void *parent, void *menu, void *inst, void *param)');
  api.SetWindowPos = u.func('bool SetWindowPos(void *hwnd, void *after, int32_t x, int32_t y, int32_t cx, int32_t cy, uint32_t flags)');
  api.ShowWindow = u.func('bool ShowWindow(void *hwnd, int32_t cmd)');
  api.DestroyWindow = u.func('bool DestroyWindow(void *hwnd)');
  api.SetCursorPos = u.func('bool SetCursorPos(int32_t x, int32_t y)');
  api.GetCursorPos = u.func('bool GetCursorPos(void *pt)');
  api.UpdateWindow = u.func('bool UpdateWindow(void *hwnd)');
  api.InvalidateRect = u.func('bool InvalidateRect(void *hwnd, void *rect, bool erase)');
  api.SetLayeredWindowAttributes = u.func('bool SetLayeredWindowAttributes(void *hwnd, uint32_t key, uint8_t alpha, uint32_t flags)');
  api.GetWindowLongPtrW = u.func('int64_t GetWindowLongPtrW(void *hwnd, int32_t index)');
  const POINT = koffi.struct('POINT', { x: 'int32_t', y: 'int32_t' });
  api.WindowFromPoint = u.func('void *WindowFromPoint(POINT pt)');
}

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPCHILDREN = 0x02000000;
const WS_EX_TOPMOST = 0x8;
const WS_EX_TOOLWINDOW = 0x80;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_TRANSPARENT = 0x20;
const WS_EX_LAYERED = 0x00080000;
const HWND_TOPMOST = 0xffffffffffffffffn;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;

function createMagnifier(area, parentHwnd, opts) {
  initUser32();
  const o = opts || {};
  const style = parentHwnd ? WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN : WS_POPUP | WS_VISIBLE;
  const ex = o.plain
    ? 0
    : parentHwnd
      ? WS_EX_NOACTIVATE | WS_EX_TRANSPARENT
      : WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
  const h = api.CreateWindowExW(
    ex, 'Magnifier', 'magProbe', style,
    parentHwnd ? 0 : Math.round(area.x), parentHwnd ? 0 : Math.round(area.y),
    Math.round(area.w), Math.round(area.h),
    parentHwnd || null, null, null, null
  );
  if (!h || h === 0n) { L('magWindow.fail', { parent: parentHwnd ? hex(parentHwnd) : 'top-level' }); return null; }
  if (!parentHwnd) api.SetWindowPos(h, HWND_TOPMOST, Math.round(area.x), Math.round(area.y), Math.round(area.w), Math.round(area.h), SWP_SHOWWINDOW | SWP_NOACTIVATE);
  api.ShowWindow(h, 4);
  L('magWindow.ok', { hwnd: hex(h), parent: parentHwnd ? hex(parentHwnd) : 'top-level', area });
  return h;
}

function setMag(hwnd, src, scale, label) {
  const okSrc = api.MagSetWindowSource(hwnd, rectBuf(src.x, src.y, src.w, src.h));
  const okTr = api.MagSetWindowTransform(hwnd, matrixBuf(scale));
  const rBack = Buffer.alloc(16); const tBack = Buffer.alloc(36);
  const gSrc = api.MagGetWindowSource(hwnd, rBack);
  const gTr = api.MagGetWindowTransform(hwnd, tBack);
  try { api.InvalidateRect(hwnd, null, true); } catch (_) {}
  const rec = {
    label, okSetSource: !!okSrc, okSetTransform: !!okTr, okGetSource: !!gSrc, okGetTransform: !!gTr,
    src: [src.x, src.y, src.w, src.h], scale,
    readbackSrc: [rBack.readInt32LE(0), rBack.readInt32LE(4), rBack.readInt32LE(8), rBack.readInt32LE(12)],
    readbackScale: [tBack.readFloatLE(0), tBack.readFloatLE(16), tBack.readFloatLE(32)],
  };
  REC.trials.push(rec);
  L('magSet', rec);
  return rec;
}

// ---------------------------------------------------------------- 测试卡
const CARD_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><style>
 html,body{margin:0;height:100%;overflow:hidden;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
 body{background:#0b1526;color:#fff}
 .grid{position:absolute;inset:0;
   background-image:linear-gradient(#2a4a7a 1px,transparent 1px),linear-gradient(90deg,#2a4a7a 1px,transparent 1px);
   background-size:40px 40px}
 .t{position:absolute;left:36px;top:30px;font-size:46px;font-weight:800;text-shadow:0 2px 0 #000}
 .s{position:absolute;left:36px;top:96px;font-size:20px;color:#9fd4ff}
 .row{position:absolute;left:36px;top:150px;display:flex;gap:10px}
 .b{width:110px;height:110px;border-radius:10px;box-shadow:0 0 0 1px #0006}
 .lines{position:absolute;left:36px;top:300px;width:860px}
 .lines div{height:1px;background:#ffe08a;margin-bottom:9px}
 .lines div.b2{height:2px}.lines div.b3{height:3px}
 .txt{position:absolute;left:36px;bottom:40px;font-size:24px;line-height:1.7;color:#eaf6ff}
 .circ{position:absolute;right:70px;bottom:120px;width:210px;height:210px;border-radius:50%;
   background:radial-gradient(circle at 35% 35%,#ff9a7a,#c0392b 70%)}
 .tag{position:absolute;right:40px;top:30px;font-size:18px;background:#000a;border:2px solid #7fffd4;border-radius:8px;padding:10px 14px}
</style></head><body>
 <div class="grid"></div>
 <div class="t">放大镜测试卡 · MAG 2x / 4x</div>
 <div class="s">40px 网格 · 1px 细线 · 放大后网格应变成 80px / 160px</div>
 <div class="row">
  <div class="b" style="background:#e74c3c"></div><div class="b" style="background:#f1c40f"></div>
  <div class="b" style="background:#2ecc71"></div><div class="b" style="background:#3498db"></div>
  <div class="b" style="background:#9b59b6"></div><div class="b" style="background:#ecf0f1"></div>
 </div>
 <div class="lines"><div></div><div></div><div class="b2"></div><div></div><div class="b3"></div><div></div></div>
 <div class="txt">朗读女 Neo · 系统放大接口验证<br>ABCDEFGHIJKLM abcdefghijk 0123456789<br>低视力场景：放大后笔画应连续、无重影</div>
 <div class="circ"></div>
 <div class="tag">PATTERN / 原始像素</div>
</body></html>`)}`;

// ---------------------------------------------------------------- 主流程
async function main() {
  // 1. DLL
  koffi = require('koffi');
  const cands = [
    path.resolve(__dirname, '..', 'resources', 'magnification', 'Magnification.dll'),
    path.resolve(process.cwd(), 'resources', 'magnification', 'Magnification.dll'),
  ];
  let from = null; let err = null;
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    try { api = { lib: koffi.load(p) }; from = p; break; } catch (e) { err = (e && e.message) || String(e); L('dll.loadFail', { p, err }); }
  }
  if (!from) {
    try { api = { lib: koffi.load('Magnification.dll') }; from = 'system search path'; } catch (e) { err = (e && e.message) || String(e); }
  }
  if (!from) throw new Error(`加载 Magnification.dll 失败: ${err}`);
  REC.dll = { path: from, bytes: fs.existsSync(from) ? fs.statSync(from).size : null };
  L('dll.loaded', REC.dll);

  const lib = api.lib;
  api.MagInitialize = lib.func('bool MagInitialize()');
  api.MagUninitialize = lib.func('bool MagUninitialize()');
  api.MagSetWindowSource = lib.func('bool MagSetWindowSource(void *hwnd, void *rect)');
  api.MagGetWindowSource = lib.func('bool MagGetWindowSource(void *hwnd, void *rect)');
  api.MagSetWindowTransform = lib.func('bool MagSetWindowTransform(void *hwnd, void *xform)');
  api.MagGetWindowTransform = lib.func('bool MagGetWindowTransform(void *hwnd, void *xform)');
  api.MagSetFullscreenTransform = lib.func('bool MagSetFullscreenTransform(float lvl, int32_t ox, int32_t oy)');
  api.MagGetFullscreenTransform = lib.func('bool MagGetFullscreenTransform(void *lvl, void *ox, void *oy)');
  api.MagShowSystemCursor = lib.func('bool MagShowSystemCursor(bool show)');

  // 2. Init
  inited = !!api.MagInitialize();
  L('magInitialize', { ok: inited });
  if (!inited) throw new Error('MagInitialize = false');
  const lv0 = Buffer.alloc(4);
  api.MagGetFullscreenTransform(lv0, Buffer.alloc(4), Buffer.alloc(4));
  REC.fullscreenBefore = lv0.readFloatLE(0);

  // 3. 布局
  const d = screen.getPrimaryDisplay();
  const wa = d.workArea;
  const dpr = d.scaleFactor || 1;
  REC.display = { id: d.id, bounds: d.bounds, workArea: wa, size: d.size, scaleFactor: dpr };
  L('display', REC.display);
  const halfW = Math.round(wa.width / 2);
  const CARD = { x: wa.x, y: wa.y, w: halfW, h: wa.height };
  const MAG = { x: wa.x + halfW, y: wa.y, w: wa.width - halfW, h: wa.height };

  // 4. 测试卡（左半屏，置顶，避免被其它窗口遮挡）
  cardWin = new BrowserWindow({
    x: CARD.x, y: CARD.y, width: CARD.w, height: CARD.h,
    frame: false, skipTaskbar: true, resizable: false, movable: false, focusable: false, show: false,
    backgroundColor: '#0b1526', webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  await cardWin.loadURL(CARD_HTML);
  cardWin.setAlwaysOnTop(true, 'screen-saver');
  cardWin.showInactive();
  await sleep(350);

  // 5. 宿主窗口（右半屏）
  hostWin = new BrowserWindow({
    x: MAG.x, y: MAG.y, width: MAG.w, height: MAG.h,
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false,
    show: false, backgroundColor: '#000000',
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });
  hostWin.setBounds(MAG);
  hostWin.setIgnoreMouseEvents(true, { forward: true });
  hostWin.setAlwaysOnTop(true, 'screen-saver');
  await hostWin.loadURL('data:text/html,<body style="margin:0;background:%23000"></body>');
  hostWin.showInactive();
  hostWin.moveTop();
  await sleep(500); // 必须真正 show 出来：否则 capturePage 给 0x0、窗口也不会被 Mag 绘制
  const hostHwnd = hwndOf(hostWin);
  REC.hwnd = { electronHost: hex(hostHwnd), isZero: hostHwnd === 0n };
  L('hwnd', REC.hwnd);
  if (!hostHwnd) throw new Error('getNativeWindowHandle = 0');

  // 6. before
  const beforeCap = await hostWin.webContents.capturePage();
  saveImg('before.png', beforeCap);
  REC.analysis['before.png'] = stats(beforeCap);
  const dBefore = await grabDesktop('before');
  if (dBefore.img) REC.analysis['desktop-before'] = stats(dBefore.img);

  const areaOf = (s) => ({ x: CARD.x + (CARD.w - CARD.w / s) / 2, y: CARD.y + (CARD.h - CARD.h / s) / 2, w: CARD.w / s, h: CARD.h / s });
  const src2 = areaOf(2);
  const src4 = areaOf(4);

  // 7. A：Electron HWND
  setMag(hostHwnd, src2, 2, 'A:electron-hwnd-2x');
  await sleep(400);
  const dA = await grabDesktop('A-electron-hwnd');
  const aCrop = dA.img ? dA.img.crop(cropRect(MAG)) : null;
  REC.analysis.A = aCrop ? stats(aCrop) : null;

  // 8. 通用试验：2x → 截图 → 4x → 截图，两次不同 = Mag 真的在刷新
  let winner = null;
  let cap2 = null; let cap4 = null;
  let keeper = null; // 当前胜出的 { hwnd, destroy }
  const extraHosts = [];

  async function runTrial(key, hwnd, note) {
    if (!hwnd) return false;
    setMag(hwnd, src2, 2, `${key}:2x`);
    await sleep(450);
    const d2 = await grabDesktop(`${key}-2x`);
    const i2 = d2.img ? d2.img.crop(cropRect(MAG)) : null;
    setMag(hwnd, src4, 4, `${key}:4x`);
    await sleep(450);
    const d4 = await grabDesktop(`${key}-4x`);
    const i4 = d4.img ? d4.img.crop(cropRect(MAG)) : null;
    REC.analysis[`${key}-2x`] = i2 ? stats(i2) : null;
    REC.analysis[`${key}-4x`] = i4 ? stats(i4) : null;
    REC.diff[`${key} 2x-vs-4x`] = i2 && i4 ? mad(i2, i4) : null;
    const ok = !!(i2 && REC.diff[`${key} 2x-vs-4x`] > 3);
    L(`trial.${key}`, { note, s2: REC.analysis[`${key}-2x`], s4: REC.analysis[`${key}-4x`], diff: REC.diff[`${key} 2x-vs-4x`], ok });
    if (ok) { winner = key; cap2 = i2; cap4 = i4; }
    return ok;
  }

  // 命中测试：放大窗口是否挡住鼠标（返回该窗口 = 会吃掉点击）
  REC.hitTest = {};
  function hitTest(label) {
    if (!api.WindowFromPoint) return;
    const p = { x: Math.round(MAG.x + MAG.w / 2), y: Math.round(MAG.y + MAG.h / 2) };
    const h = api.WindowFromPoint(p);
    const ex = api.GetWindowLongPtrW(h, -20);
    REC.hitTest[label] = { point: [p.x, p.y], hwndAtPoint: hex(h), exStyle: '0x' + (ex >>> 0).toString(16).toUpperCase() };
    L('hitTest', { label, ...REC.hitTest[label] });
  }

  async function trialSet(key, note, build) {
    const created = build();
    if (!created || !created.hwnd) { L('trial.skip', { key }); return; }
    const ok = await runTrial(key, created.hwnd, note);
    if (ok) {
      if (keeper && keeper.destroy) keeper.destroy();
      keeper = created;
      magHwnd = created.hwnd;
    } else if (created.destroy) {
      created.destroy();
    }
  }

  const popup = (plain) => () => {
    const h = createMagnifier(MAG, 0n, { plain });
    return h ? { hwnd: h, host: null, destroy: () => { try { api.DestroyWindow(h); } catch (_) {} } } : null;
  };
  const childOf = (parent) => () => {
    const h = createMagnifier(MAG, parent);
    return h ? { hwnd: h, host: parent, destroy: () => { try { api.DestroyWindow(h); } catch (_) {} } } : null;
  };
  const nativeHost = (layered) => () => {
    initUser32();
    const ex = WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | (layered ? WS_EX_LAYERED : 0);
    const host = api.CreateWindowExW(ex, 'STATIC', 'magHost', WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
      Math.round(MAG.x), Math.round(MAG.y), Math.round(MAG.w), Math.round(MAG.h), null, null, null, null);
    if (!host || host === 0n) { L('nativeHost.fail', { layered }); return null; }
    api.SetWindowPos(host, HWND_TOPMOST, Math.round(MAG.x), Math.round(MAG.y), Math.round(MAG.w), Math.round(MAG.h), SWP_SHOWWINDOW | SWP_NOACTIVATE);
    api.ShowWindow(host, 4);
    if (layered) api.SetLayeredWindowAttributes(host, 0, 255, 0x00000002); // LWA_ALPHA，保持完全不透明
    extraHosts.push(host);
    L('nativeHost.ok', { hwnd: hex(host), layered });
    const h = createMagnifier(MAG, host);
    if (!h) return null;
    return { hwnd: h, host, destroy: () => { try { api.DestroyWindow(h); } catch (_) {} try { api.DestroyWindow(host); } catch (_) {} } };
  };

  // B: 顶层 popup（带 ex 样式） / F: 顶层 popup（无 ex 样式）
  await trialSet('B-popup', 'top-level popup + ex styles', popup(false));
  await trialSet('F-popup-plain', 'top-level popup, no ex style', popup(true));
  // C: 作为 Electron 宿主窗口的子窗口
  await trialSet('C-child-electron', 'child of Electron HWND', childOf(hostHwnd));
  // D: 原生 STATIC popup 宿主 + 子窗口
  await trialSet('D-child-nativehost', 'child of native popup host', nativeHost(false));
  hitTest('after-D');
  // G: 同上，但宿主加 WS_EX_LAYERED 以便鼠标穿透
  await trialSet('G-child-layered', 'child of layered native popup (click-through)', nativeHost(true));
  hitTest('after-G');

  // E: 兜底诊断 —— 系统级全屏变换（短暂 1.5x 后立刻复位），判断「引擎是否根本不工作」
  REC.fullscreenProbe = {};
  if (!winner) {
    const dE0 = await grabDesktop('E-before');
    const okSet = api.MagSetFullscreenTransform(1.5, 0, 0);
    await sleep(450);
    const dE1 = await grabDesktop('E-fullscreen-1p5x');
    const lvE = Buffer.alloc(4);
    api.MagGetFullscreenTransform(lvE, Buffer.alloc(4), Buffer.alloc(4));
    const back = api.MagSetFullscreenTransform(1.0, 0, 0);
    await sleep(300);
    const lvR = Buffer.alloc(4);
    api.MagGetFullscreenTransform(lvR, Buffer.alloc(4), Buffer.alloc(4));
    REC.fullscreenProbe = {
      okSet: !!okSet, levelAfterSet: lvE.readFloatLE(0), okRestore: !!back, levelAfterRestore: lvR.readFloatLE(0),
      diffFullscreen: dE0.img && dE1.img ? mad(dE0.img, dE1.img) : null,
    };
    L('fullscreenProbe', REC.fullscreenProbe);
    if (dE1.img) {
      saveImg('screen-fullscreen-1p5x.png', dE1.img);
      REC.analysis['screen-fullscreen-1p5x'] = stats(dE1.img);
    }
  }
  REC.extraHosts = extraHosts.map(hex);
  const destroyExtras = () => extraHosts.forEach((h) => { try { api.DestroyWindow(h); } catch (_) {} });

  // 10. 胜出方案：正式 2x / 4x 取证
  if (winner) {
    for (const s of [2, 4]) {
      setMag(magHwnd, areaOf(s), s, `${winner}-${s}x-final`);
      await sleep(450);
      const cap = await hostWin.webContents.capturePage();
      saveImg(`mag-${s}x.png`, cap); // 需求点：capturePage 三连
      REC.analysis[`mag-${s}x.png`] = stats(cap);
      const dk = await grabDesktop(`mag-${s}x`);
      if (dk.img) {
        const c = dk.img.crop(cropRect(MAG));
        saveImg(`screen-mag-${s}x.png`, c);
        REC.analysis[`screen-mag-${s}x.png`] = stats(c);
        if (s === 2) { cap2 = c; }
        if (s === 4) { cap4 = c; saveImg('screen-mag-4x-fullscreen.png', dk.img); }
      }
    }
    if (cap2 && cap4) REC.diff['screen 2x-vs-4x'] = mad(cap2, cap4);
    // 同一帧里的左半屏原图（对照）
    const dk = await grabDesktop('pair');
    if (dk.img) {
      const left = dk.img.crop(cropRect({ x: CARD.x, y: CARD.y, w: MAG.x - CARD.x, h: CARD.h }));
      saveImg('screen-card-original.png', left);
      REC.analysis['screen-card-original'] = stats(left);
    }
  }

  // 10.5 让系统光标显示在放大画面里（旧方案是自绘假光标 + 焦点框，这里不需要）
  if (winner) {
    REC.magShowSystemCursor = !!api.MagShowSystemCursor(true);
    L('magShowSystemCursor', { ok: REC.magShowSystemCursor });
  }

  // 11. 跟随鼠标（SetCursorPos 真移动，读数来自 screen.getCursorScreenPoint）
  if (winner && magHwnd) {
    const sc = 3;
    const sw = CARD.w / sc; const sh = CARD.h / sc;
    const samples = []; let updates = 0; let lastKey = '';
    let sumUs = 0; let cntUs = 0;
    REC.follow = { intervalMs: 16, scale: sc, maxUs: 0 };
    followTimer = setInterval(() => {
      try {
        const p = screen.getCursorScreenPoint();
        const x = Math.max(CARD.x, Math.min(p.x - sw / 2, CARD.x + CARD.w - sw));
        const y = Math.max(CARD.y, Math.min(p.y - sh / 2, CARD.y + CARD.h - sh));
        const key = `${Math.round(x)},${Math.round(y)}`;
        if (key !== lastKey) {
          lastKey = key; updates += 1;
          const t1 = process.hrtime.bigint();
          api.MagSetWindowSource(magHwnd, rectBuf(x, y, sw, sh));
          const dtUs = Number(process.hrtime.bigint() - t1) / 1000;
          if (dtUs > (REC.follow.maxUs || 0)) REC.follow.maxUs = +dtUs.toFixed(1);
          sumUs += dtUs; cntUs += 1;
          if (samples.length < 6) samples.push({ cursor: [p.x, p.y], source: [Math.round(x), Math.round(y), Math.round(sw), Math.round(sh)] });
        }
      } catch (_) {}
    }, 16);

    const pt = Buffer.alloc(8); api.GetCursorPos(pt);
    const orig = [pt.readInt32LE(0), pt.readInt32LE(4)];
    const track = [[CARD.x + 200, CARD.y + 200], [CARD.x + 450, CARD.y + 380], [CARD.x + 700, CARD.y + 500], [CARD.x + 350, CARD.y + 720]];
    for (const [x, y] of track) { api.SetCursorPos(Math.round(x), Math.round(y)); await sleep(240); }
    await sleep(250);
    clearInterval(followTimer); followTimer = null;
    const dF = await grabDesktop('follow');
    if (dF.img) {
      const c = dF.img.crop(cropRect(MAG));
      saveImg('screen-follow-3x.png', c);
      REC.analysis['screen-follow-3x'] = stats(c);
    }
    api.SetCursorPos(orig[0], orig[1]);
    REC.follow = { ...REC.follow, updates, samples, cursorRestored: orig, avgCallUs: cntUs ? +(sumUs / cntUs).toFixed(1) : null };
    L('follow', REC.follow);
  }

  // 12. 收尾
  destroyExtras();
  cleanup('main-end');
  const s2 = REC.analysis['screen-mag-2x.png'];
  const s4 = REC.analysis['screen-mag-4x.png'];
  REC.verdict = {
    dllLoaded: true,
    magInitialized: true,
    electronHwndAccepted: !!(REC.trials[0] && REC.trials[0].okSetSource),
    winningHost: winner,
    screen2x: s2 || null,
    screen4x: s4 || null,
    diff2x4x: REC.diff['screen 2x-vs-4x'] || null,
    followUpdates: REC.follow.updates || 0,
    pass: !!winner && !!s2 && s2.colors > 50 && s2.pctBlack < 60 && (REC.diff['screen 2x-vs-4x'] || 0) > 3,
  };
  REC.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ REC, LOG }, null, 2), 'utf8');

  console.log('\n===== SUMMARY =====');
  console.log(JSON.stringify({ dll: REC.dll, hwnd: REC.hwnd, trials: REC.trials, analysis: REC.analysis, diff: REC.diff, follow: REC.follow, verdict: REC.verdict, cleanup: LOG.find((x) => x.step === 'cleanup') }, null, 2));
  setTimeout(() => app.exit(REC.verdict.pass ? 0 : 2), 200);
}

app.on('window-all-closed', (e) => { if (e && e.preventDefault) e.preventDefault(); });
process.on('uncaughtException', (e) => {
  L('uncaught', { message: (e && e.stack) || String(e) });
  cleanup('uncaughtException');
  try { fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ REC, LOG, crash: String(e && e.stack) }, null, 2), 'utf8'); } catch (_) {}
  process.exit(3);
});
app.whenReady().then(main).catch((e) => {
  L('fatal', { message: (e && e.stack) || String(e) });
  cleanup('fatal');
  try { REC.verdict = { pass: false, error: (e && e.message) || String(e) }; fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ REC, LOG }, null, 2), 'utf8'); } catch (_) {}
  setTimeout(() => app.exit(1), 150);
});
