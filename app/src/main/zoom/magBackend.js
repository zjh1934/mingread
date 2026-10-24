// 系统放大后端（Windows Magnification API）。
//
// 为什么不用 Electron 窗口承载：实测 MagSetWindowSource 对 BrowserWindow 的 HWND 直接返回
// FALSE（见 docs/开发日志.md Round 7）。放大画面只能由原生 Win32 窗口承载：
//   STATIC popup 宿主（分层/透明/置顶/工具栏/不激活）
//     └─ WC_MAGNIFIER 子窗口（WS_CHILD）—— Mag 把屏幕源像素直接画进它的客户区
// 这条路径完全不经过自绘，因此没有旧覆盖层那套焦点框/十字线/描边在 8x 下的网格伪影。
//
// 坐标约定（最容易出错的地方）：
//   · Electron 的 display.bounds / screen.getCursorScreenPoint() 都是 **DIP**；
//   · Magnification API 的源矩形与窗口尺寸是 **物理像素**；
//   · 所以两者都要 × scaleFactor。本机 100% 缩放会掩盖这个坑，125%/150% 机器上不乘就会偏。
'use strict';

const path = require('path');
const fs = require('fs');

let koffi = null;
let api = null; // Mag* 函数
let u32 = null; // user32 函数
let magInitialized = false;
let hostHwnd = null;
let magHwnd = null;
let currentDisplayId = null;
let lastRect = null;
let failReason = '';
let loadedFrom = '';
let exitHookInstalled = false;

/**
 * 进程退出兜底（安全关键）。
 *
 * 放大宿主窗口是 WS_EX_TOPMOST | WS_EX_TRANSPARENT 的原生窗口，**不归 Chromium 管**：
 * Electron 退出时不会替你销毁它。一旦残留，就是一块盖满屏幕、鼠标点哪儿都穿过去、
 * 又永远置顶的东西 —— 用户会以为电脑坏了。
 *
 * 这里在进程退出与常见终止信号上尽最大努力销毁窗口。
 * 已知盲区：taskkill /F 之类的强制杀进程不会触发任何 JS 回调，那种情况只能靠注销/重启。
 * 因此正常路径（托盘退出、关窗、app.quit）必须走 zoomController.stop()，那是主保障。
 */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const cleanup = () => {
    try {
      destroyWindows();
    } catch (e) {
      /* 退出路径上不允许再抛 */
    }
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        cleanup();
        process.exit(0);
      });
    } catch (e) {
      /* Windows 上部分信号不可用 */
    }
  }
}

// Win32 常量
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
const LWA_ALPHA = 0x2;

const HOST_EX = WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
const MAG_EX = WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;

/** 查找可用的 Magnification.dll。顺序很重要：
 *    1. 系统 System32 —— 正常 Windows 都有，优先用系统的（不依赖随包文件）
 *    2. 安装包的 resources/magnification（extraResources 落在这里）
 *    3. 开发目录 resources/magnification
 *
 *  第 2 条是 v3.0.0 补的，也是一次真实事故的教训：
 *  之前为了「不随应用分发微软组件」把它从包里排除了，结果本机是精简版系统、
 *  System32 里只有一个 22726 字节的压缩存根（DCS 头，非 PE），
 *  于是「开发环境能用、装完就退回旧方案」——功能在用户手里等于不存在。
 *  现在的取舍：包里带一份兜底副本，系统有就用系统的，系统没有才用它。 */
function locateDll() {
  const candidates = [];
  if (process.env.SystemRoot) candidates.push(path.join(process.env.SystemRoot, 'System32', 'Magnification.dll'));
  try {
    // eslint-disable-next-line global-require
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'magnification', 'Magnification.dll'));
    }
  } catch (e) {
    /* 非 Electron 环境 */
  }
  candidates.push(path.join(__dirname, '..', '..', '..', 'resources', 'magnification', 'Magnification.dll'));

  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      // 快速排除 Compact OS 压缩存根：有效 PE 头是 MZ
      const fd = fs.openSync(c, 'r');
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head[0] !== 0x4d || head[1] !== 0x5a) continue;
      return c;
    } catch (e) {
      /* 继续下一个候选 */
    }
  }
  return '';
}

/** RECT 结构是 left/top/right/bottom，不是 x/y/w/h —— 传错会得到空白或错位画面 */
function rectBuf(x, y, w, h) {
  const b = Buffer.alloc(16);
  b.writeInt32LE(Math.round(x), 0);
  b.writeInt32LE(Math.round(y), 4);
  b.writeInt32LE(Math.round(x + w), 8);
  b.writeInt32LE(Math.round(y + h), 12);
  return b;
}

/** MAGTRANSFORM 是 3×3 float 矩阵，对角放缩放，第三行第三列必须为 1 */
function matrixBuf(s) {
  const b = Buffer.alloc(36);
  b.writeFloatLE(s, 0); // [0][0]
  b.writeFloatLE(s, 16); // [1][1]
  b.writeFloatLE(1, 32); // [2][2]
  return b;
}

function init() {
  if (api) return true;
  try {
    // eslint-disable-next-line global-require
    koffi = require('koffi');
    const dllPath = locateDll();
    if (!dllPath) {
      failReason = 'Magnification.dll 未找到（系统无此组件，且没有调试副本）';
      return false;
    }
    loadedFrom = dllPath;
    const mag = koffi.load(dllPath);
    api = {
      MagInitialize: mag.func('bool MagInitialize()'),
      MagUninitialize: mag.func('bool MagUninitialize()'),
      MagSetWindowSource: mag.func('bool MagSetWindowSource(void *hwnd, void *rect)'),
      MagSetWindowTransform: mag.func('bool MagSetWindowTransform(void *hwnd, void *matrix)'),
      MagGetWindowSource: mag.func('bool MagGetWindowSource(void *hwnd, void *rect)'),
      MagShowSystemCursor: mag.func('bool MagShowSystemCursor(bool show)'),
    };
    const u = koffi.load('user32.dll');
    u32 = {
      CreateWindowExW: u.func(
        'void *CreateWindowExW(uint32_t exStyle, str16 className, str16 winName, uint32_t style, int32_t x, int32_t y, int32_t cx, int32_t cy, void *parent, void *menu, void *inst, void *param)'
      ),
      SetWindowPos: u.func('bool SetWindowPos(void *hwnd, void *after, int32_t x, int32_t y, int32_t cx, int32_t cy, uint32_t flags)'),
      ShowWindow: u.func('bool ShowWindow(void *hwnd, int32_t cmd)'),
      DestroyWindow: u.func('bool DestroyWindow(void *hwnd)'),
      SetLayeredWindowAttributes: u.func(
        'bool SetLayeredWindowAttributes(void *hwnd, uint32_t key, uint8_t alpha, uint32_t flags)'
      ),
    };
    if (!api.MagInitialize()) {
      failReason = 'MagInitialize() 返回 false';
      api = null;
      return false;
    }
    magInitialized = true;
    installExitHook();
    // 让放大画面里显示真实系统光标（不用自绘假光标）
    try {
      api.MagShowSystemCursor(true);
    } catch (e) {
      /* 非关键 */
    }
    return true;
  } catch (e) {
    failReason = `初始化失败：${(e && e.message) || e}`;
    api = null;
    return false;
  }
}

/** 是否可用（只做一次性探测，结果缓存） */
function isAvailable() {
  if (api) return true;
  if (failReason) return false;
  return init();
}

function getInfo() {
  return {
    available: !!api,
    loadedFrom,
    reason: failReason || null,
    host: hostHwnd ? 'created' : null,
    displayId: currentDisplayId,
  };
}

/** 为一个显示器建宿主 + 放大子窗口（物理像素尺寸） */
function createForDisplay(display) {
  if (!isAvailable()) return false;
  if (hostHwnd && currentDisplayId === display.id) return true;

  destroyWindows();

  const sf = display.scaleFactor || 1;
  const b = display.bounds;
  const x = Math.round(b.x * sf);
  const y = Math.round(b.y * sf);
  const w = Math.round(b.width * sf);
  const h = Math.round(b.height * sf);

  hostHwnd = u32.CreateWindowExW(
    HOST_EX,
    'STATIC',
    'mingread-mag-host',
    WS_POPUP | WS_VISIBLE | WS_CLIPCHILDREN,
    x,
    y,
    w,
    h,
    null,
    null,
    null,
    null
  );
  if (!hostHwnd || hostHwnd === 0n) {
    failReason = '宿主窗口创建失败';
    hostHwnd = null;
    try {
      // eslint-disable-next-line global-require
      require('../diag').log('zoom', '放大宿主窗口创建失败');
    } catch (e) { /* noop */ }
    return false;
  }
  try {
    u32.SetLayeredWindowAttributes(hostHwnd, 0, 255, LWA_ALPHA);
  } catch (e) {
    /* 分层属性失败不致命 */
  }
  u32.SetWindowPos(hostHwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW | SWP_NOACTIVATE);
  u32.ShowWindow(hostHwnd, 4); // SW_SHOWNOACTIVATE

  magHwnd = u32.CreateWindowExW(
    MAG_EX,
    'Magnifier',
    'mingread-mag',
    WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN,
    0,
    0,
    w,
    h,
    hostHwnd,
    null,
    null,
    null
  );
  if (!magHwnd || magHwnd === 0n) {
    failReason = 'WC_MAGNIFIER 子窗口创建失败';
    destroyWindows();
    return false;
  }
  u32.ShowWindow(magHwnd, 4);
  currentDisplayId = display.id;
  const okLine = `放大窗口已创建 display=${display.id} ${w}x${h} dll=${loadedFrom}`;
  console.log(`[mag] ${okLine}`);
  try {
    // eslint-disable-next-line global-require
    require('../diag').log('zoom', okLine);
  } catch (e) {
    /* 诊断不可用不影响放大 */
  }
  return true;
}

/**
 * 显示一帧放大。
 * @param {{left:number, top:number, width:number, height:number}} src 源矩形（**物理像素**屏幕坐标）
 * @param {number} scale 放大倍率
 */
function showFrame(src, scale) {
  if (!api || !magHwnd) return false;
  // 源矩形宽高必须是整数像素，否则 Mag 会闪烁
  const left = Math.round(src.left);
  const top = Math.round(src.top);
  const w = Math.max(1, Math.round(src.width));
  const h = Math.max(1, Math.round(src.height));

  // 同一帧不重复下发（MagSetWindowSource 约 3.3ms，按需调用即可）
  if (lastRect && lastRect.left === left && lastRect.top === top && lastRect.width === w && lastRect.height === h && lastRect.scale === scale) {
    return true;
  }
  lastRect = { left, top, width: w, height: h, scale };

  try {
    const okSrc = api.MagSetWindowSource(magHwnd, rectBuf(left, top, w, h));
    const okTr = api.MagSetWindowTransform(magHwnd, matrixBuf(scale));
    if (!okSrc || !okTr) {
      if (!lastRect.warned) {
        lastRect.warned = true;
        console.warn(`[mag] SetWindowSource=${okSrc} SetWindowTransform=${okTr}`);
      }
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[mag] showFrame failed:', e && e.message);
    return false;
  }
}

function hide() {
  if (hostHwnd) {
    try {
      u32.ShowWindow(hostHwnd, 0); // SW_HIDE
    } catch (e) {
      /* noop */
    }
  }
  lastRect = null;
}

function destroyWindows() {
  try {
    if (magHwnd) u32.DestroyWindow(maghwndSafe());
  } catch (e) {
    /* noop */
  }
  try {
    if (hostHwnd) u32.DestroyWindow(hostHwnd);
  } catch (e) {
    /* noop */
  }
  magHwnd = null;
  hostHwnd = null;
  currentDisplayId = null;
  lastRect = null;
}

// DestroyWindow 对已销毁的句柄会失败但不崩；包一层避免读到 null
function maghndSafe() {
  return magHwnd;
}

function dispose() {
  destroyWindows();
  if (magInitialized && api) {
    try {
      api.MagUninitialize();
    } catch (e) {
      /* noop */
    }
    magInitialized = false;
  }
  api = null;
  u32 = null;
}

module.exports = {
  isAvailable,
  createForDisplay,
  showFrame,
  hide,
  destroyWindows,
  dispose,
  getInfo,
};
