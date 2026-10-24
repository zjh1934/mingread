// 屏幕缩放（复刻 macOS 缩放）主进程控制器 —— v2.3 集成进 明读（src/main/）
// 毛坯来源：_src/LensZoom-handover/electron/zoomController.js。本文件按集成评审逐条修复：
//   F1  koffi/uiohook 原生模块本环境不存在 → 新增「热键触发模式」兜底（globalShortcut
//       Ctrl+Alt+= 放大 / Ctrl+Alt+- 缩小 / Ctrl+Alt+0 退出），zoomTrigger 设置 auto|hotkey；
//   F2  退出逻辑：缩到 1x 即 deactivate（与 macOS 一致）；zoomMin>1 时缩小到 zoomMin 停住，
//       退出靠 Ctrl+Alt+0 / 托盘菜单 / zoom:reset；activate 起始倍率 zoomMin<=1 取 2 否则 zoomMin；
//   F3  多显示器跟随：渲染循环检测光标所在显示器变化 → 重设 overlay bounds + 发 zoom:display-changed；
//   F4  frameLimit 热更新：applySettingsPatch 检测 zoomFrameLimit 变化 → stopLoop()+startLoop()；
//   F5  paused 语义改为「冻结」：暂停时 step()/pushState() 跳过，画面定格，恢复后继续；
//   F6  覆盖层加载容错：loadFile().catch() + did-fail-load 监听 + console.warn；
//   F7  state.cursor 初始化 try/catch（app 未 ready 时 screen 可能抛）；
//   F8  模块级单例：getZoomController() 供托盘/悬浮球/ipc 调用；
//   F9  IPC 自注册（listenerCount 防护）保留，start() 里调用；新增 registerZoomHotkeys()/
//       unregisterZoomHotkeys()，start()/stop() 配对；
//   F10 activate 时发 zoom:activate {displayId}；overlay did-finish-load 后补发一次。
// 契约（与用户重写的 src/main/zoomPreload.js、zoom-overlay.html 协作）：
//   - 激活/跨屏时给覆盖层发 zoom:activate {displayId} / zoom:display-changed {displayId}；
//   - 每帧发 zoom:state {zoom,originX,originY,width,height,cursorX,cursorY,displayId,showHud,fps,integer,backend}。
'use strict';

const path = require('path');
// desktopCapturer 在 Electron 32 里只有主进程能用，由主进程取源、把 id 交给覆盖层去 getUserMedia
const { BrowserWindow, screen, ipcMain, desktopCapturer, globalShortcut } = require('electron');

// ---------------------------------------------------------------------------
// 配置默认值（并入 明读 的 settingsStore 默认值即可）
// ---------------------------------------------------------------------------
const ZOOM_DEFAULTS = {
  zoomEnabled: true,        // 总开关
  zoomModifier: 'alt',      // alt | ctrl | win | middle
  zoomFollowMode: 'fixed',  // fixed | centered | push
  zoomMin: 1,               // 回到该值即退出放大
  zoomMax: 24,              // α：倍率上限加大（原 16，最高可到 32）
  zoomInteger: true,        // 整数倍步进（2x/3x/4x…）
  zoomSmoothing: 0.65,      // 0~0.95，倍率过渡平滑度
  zoomSwallowScroll: true,  // 吞掉被消费的滚轮（仅 koffi 钩子模式有效）
  zoomClickThrough: true,   // 放大时鼠标穿透（点击仍能打到下层 UI）
  zoomShowHud: false,       // 左上角调试信息
  zoomFrameLimit: 60,
  // ---- α-视觉增强（低视力）：放大画质与定位辅助 ----
  zoomEdgeEnhance: 0.30,    // 0~1 锐化强度（feConvolveMatrix），0=关闭
  zoomOutline: 0,           // 0~1 边缘描边强度（图形轮廓加描边），0=关闭
  zoomOutlineColor: '#ffff00', // 描边颜色（默认高对比黄）
  zoomContrast: 0.15,       // 0~1 额外对比度提升（0=原始）
  zoomColorMode: 'normal',  // normal | invert | hicontrast（反色 / 高对比灰度）
  zoomCrosshair: 'off',     // off | cross | full 十字线辅助定位
  zoomFocusRing: true,      // 光标处焦点高亮框（放大后最容易"找不到指针"）
  zoomFollowSmoothing: 0,   // 0~0.95 平移跟随平滑度（0=与指针严格同步，fixed 模式推荐 0）
  zoomHudFont: 18,          // HUD 字号（px）——调试信息也要看得清
  zoomAnnounce: true,       // α2：倍率变化语音播报（overlay 走 speechSynthesis；低视力用户可能看不清 HUD）
  // 注意：zoomTrigger（'auto'|'hotkey'，F1 新增）不放在这里，由 settingsStore 单独加默认值
};

const PUSH_MARGIN = 0.15;

// α2：倍率快速循环档位（Ctrl+Alt+Q 一键在几档间跳，减少低视力用户的按键次数）
const ZOOM_CYCLE = [2, 4, 8, 16, 32];
// α2：方向键平移步长 = 当前可见视口（源像素）的 1/2，留 50% 重叠便于连续阅读
const PAN_VIEWPORT_FRAC = 0.5;

// F1：热键触发模式的三键（注册失败不抛，仅记录 state.zoomHotkeyOk + console.warn）
// α2：新增 Ctrl+Alt+Q 倍率快速循环 + Ctrl+Alt+方向键平移（放大后看屏幕外内容）
const ZOOM_HOTKEYS = [
  { accel: 'Ctrl+Alt+=', hint: '放大一档' },
  { accel: 'Ctrl+Alt+-', hint: '缩小一档' },
  { accel: 'Ctrl+Alt+0', hint: '退出缩放' },
  { accel: 'Ctrl+Alt+Q', hint: '倍率快速循环 2/4/8/16/32' },
  { accel: 'Ctrl+Alt+Left', hint: '向左平移' },
  { accel: 'Ctrl+Alt+Right', hint: '向右平移' },
  { accel: 'Ctrl+Alt+Up', hint: '向上平移' },
  { accel: 'Ctrl+Alt+Down', hint: '向下平移' },
];

// F8：模块级单例（createZoomController 时赋值；托盘/悬浮球/ipc 经 getZoomController() 访问）
let _instance = null;

/** F7：光标点获取带容错（app 未 ready 时 screen.getCursorScreenPoint 可能抛） */
function safeCursorPoint() {
  try {
    const p = screen.getCursorScreenPoint();
    if (p && typeof p.x === 'number' && typeof p.y === 'number') return { x: p.x, y: p.y };
  } catch (e) {
    /* 退化到主屏中心 */
  }
  try {
    const b = screen.getPrimaryDisplay().bounds;
    return { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) };
  } catch (e) {
    return { x: 0, y: 0 };
  }
}

/**
 * 创建缩放控制器。
 * @param {object} opts
 * @param {() => object} opts.getSettings  读取完整设置（含上面的 zoom* 键）
 * @param {(patch: object) => void} opts.saveSettings 持久化
 * @param {() => import('electron').BrowserWindow|null} opts.getMainWindow 主窗口（用于状态栏提示/菜单复选）
 */
function createZoomController(opts) {
  const { getSettings, saveSettings, getMainWindow } = opts;

  const state = {
    active: false,
    paused: false,
    zoom: 1,
    targetZoom: 1,
    cursor: safeCursorPoint(),
    lastStepAt: Date.now(),
    fps: 0,
    _frames: 0,
    _fpsAt: Date.now(),
    _pushOrigin: null,
    displayId: null,        // F3：当前覆盖层所在显示器
    backend: 'none',        // koffi | uiohook | none（原生滚轮钩子）
    trigger: 'none',        // F1：实际生效模式 koffi | uiohook | hotkey | none
    zoomHotkeyOk: false,    // F1：热键模式三键注册结果（失败不抛）
    // α-视觉增强：平移平滑 + 退出动画
    oX: null,               // 平滑后的缩放原点（null = 尚未初始化）
    oY: null,
    panX: 0,                // α2：方向键平移偏移（源像素，加在 origin 上，clamp 在 buildTransform）
    panY: 0,
    exiting: false,         // 正在缩回 1x（缩到位后自动 deactivate，避免"啪"地消失）
  };

  let overlay = null;
  let hookHandle = null;
  let hookBackend = null; // { name, stop() }
  let pumpTimer = null;
  let _frameLimit = 60;   // F4：渲染循环当前帧率上限（供热更新比对）
  let overlayReady = false; // F10：覆盖层 did-finish-load 后才发 zoom:activate

  // -------------------------------------------------------------------------
  // 覆盖层窗口：只负责"显示"，所有状态由主进程算好推给它
  // -------------------------------------------------------------------------
  function ensureOverlay() {
    if (overlay && !overlay.isDestroyed()) return overlay;

    const display = screen.getDisplayNearestPoint(state.cursor);
    state.displayId = display.id;
    overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'zoomPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    overlay.setIgnoreMouseEvents(true, { forward: true }); // 默认点击穿透
    overlay.setAlwaysOnTop(true, 'screen-saver');
    // F6：加载容错（loadFile 失败 / did-fail-load 都只告警，不影响主流程）
    overlay.loadFile(path.join(__dirname, 'zoom-overlay.html')).catch((e) => {
      console.warn('[zoom] overlay loadFile failed:', e && e.message);
    });
    overlay.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.warn('[zoom] overlay did-fail-load:', code, desc, url);
    });
    // F10：加载完成补发一次 activate（激活早于加载完成时，覆盖层靠它触发 startCapture）
    overlay.webContents.once('did-finish-load', () => {
      overlayReady = true;
      if (state.active) sendActivate();
    });
    overlay.on('closed', () => {
      overlay = null;
      overlayReady = false;
    });
    return overlay;
  }

  function hideOverlay() {
    if (overlay && !overlay.isDestroyed() && overlay.isVisible()) overlay.hide();
  }

  /** F10：给覆盖层发激活通知（仅在加载完成后有效） */
  function sendActivate() {
    if (!overlay || overlay.isDestroyed() || !overlayReady) return;
    try {
      overlay.webContents.send('zoom:activate', { displayId: state.displayId });
    } catch (e) {
      /* 覆盖层崩溃/已销毁时忽略 */
    }
  }

  function pushState() {
    if (!overlay || overlay.isDestroyed()) return;
    try {
      const d = screen.getDisplayNearestPoint(state.cursor);
      overlay.webContents.send('zoom:state', buildTransform(d));
    } catch (e) {
      /* 屏幕枚举失败时本帧丢弃 */
    }
  }

  /**
   * 核心几何：把"源矩形"换算成 CSS transform 的 origin。
   * 缩放后某点的显示位置：displayed(p) = O + (p - O) * z
   *   fixed    指针是不动点 → O = 指针位置（与 macOS Continuously with Pointer 一致）
   *   centered 指针恒居中   → O = (center - C*z) / (1 - z)
   *   push     指针进边缘 15% 才推画面
   * 覆盖满屏的条件是 O 落在 [0,W]×[0,H] 内，因此统一 clamp。
   */
  /** 本帧的"目标"原点（未平滑），三种跟随策略的几何核心；末尾叠加 α2 方向键平移偏移 */
  function rawOrigin(display, z) {
    const s = getSettings();
    const W = display.bounds.width;
    const H = display.bounds.height;
    const cx = state.cursor.x - display.bounds.x;
    const cy = state.cursor.y - display.bounds.y;

    let ox;
    let oy;
    if (s.zoomFollowMode === 'centered') {
      if (Math.abs(1 - z) < 1e-6) {
        ox = cx;
        oy = cy;
      } else {
        ox = (W / 2 - cx * z) / (1 - z);
        oy = (H / 2 - cy * z) / (1 - z);
      }
    } else if (s.zoomFollowMode === 'push') {
      if (!state._pushOrigin) state._pushOrigin = { x: cx, y: cy };
      const o = state._pushOrigin;
      const mx = W * PUSH_MARGIN;
      const my = H * PUSH_MARGIN;
      const zz = Math.max(1, z);
      const dx = o.x + (cx - o.x) * zz;
      const dy = o.y + (cy - o.y) * zz;
      if (dx < mx) o.x -= (mx - dx) / zz;
      else if (dx > W - mx) o.x += (dx - (W - mx)) / zz;
      if (dy < my) o.y -= (my - dy) / zz;
      else if (dy > H - my) o.y += (dy - (H - my)) / zz;
      ox = o.x;
      oy = o.y;
    } else {
      ox = cx; // fixed：指针即不动点（等同 macOS 持续跟随）
      oy = cy;
    }
    // α2：方向键平移（fixed 模式下指针不动点被平移偏移打破，画面随手势移动）
    return { ox: ox + state.panX, oy: oy + state.panY };
  }

  function buildTransform(display) {
    const s = getSettings();
    const W = display.bounds.width;
    const H = display.bounds.height;
    const cx = state.cursor.x - display.bounds.x;
    const cy = state.cursor.y - display.bounds.y;
    const z = state.zoom;

    const raw = rawOrigin(display, z);
    const ox = state.oX == null ? raw.ox : state.oX;
    const oy = state.oY == null ? raw.oy : state.oY;

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    return {
      zoom: z,
      originX: clamp(ox, 0, W),
      originY: clamp(oy, 0, H),
      width: W,
      height: H,
      cursorX: cx,
      cursorY: cy,
      displayId: display.id,
      showHud: !!s.zoomShowHud,
      fps: Math.round(state.fps),
      integer: !!s.zoomInteger && Math.abs(z - Math.round(z)) < 0.01,
      backend: state.backend,
      // α-视觉增强：画质与定位辅助（覆盖层据此渲染）
      edgeEnhance: Math.min(1, Math.max(0, Number(s.zoomEdgeEnhance) || 0)),
      outline: Math.min(1, Math.max(0, Number(s.zoomOutline) || 0)),
      outlineColor: String(s.zoomOutlineColor || '#ffff00'),
      contrast: Math.min(1, Math.max(0, Number(s.zoomContrast) || 0)),
      colorMode: String(s.zoomColorMode || 'normal'),
      crosshair: String(s.zoomCrosshair || 'off'),
      focusRing: !!s.zoomFocusRing,
      hudFont: Math.min(40, Math.max(10, Number(s.zoomHudFont) || 18)),
      exiting: !!state.exiting,
      // α2：冻结态与语音播报开关（overlay 据此显示「已冻结」并朗读倍率变化）
      paused: !!state.paused,
      announce: !!s.zoomAnnounce,
    };
  }

  // -------------------------------------------------------------------------
  // 状态机
  // -------------------------------------------------------------------------
  function activate() {
    const s = getSettings();
    // F2：起始倍率 zoomMin<=1 取 2，否则取 zoomMin
    const start = Number(s.zoomMin) <= 1 ? 2 : Number(s.zoomMin);
    state.active = true;
    state.paused = false; // F5：激活即解除冻结
    state.targetZoom = Math.max(1, Math.min(s.zoomInteger ? Math.round(start) : start, Number(s.zoomMax) || 24));
    state._pushOrigin = null;
    state.oX = null; // 重新取一次原点，避免残留上一轮的平滑值
    state.oY = null;
    state.panX = 0; // α2：新会话清零平移偏移
    state.panY = 0;
    state.exiting = false;
    state.lastStepAt = Date.now();
    showOverlayForCurrentDisplay();
    sendActivate(); // F10
    notifyRenderer();
  }

  function showOverlayForCurrentDisplay() {
    const win = ensureOverlay();
    const d = screen.getDisplayNearestPoint(state.cursor);
    state.displayId = d.id;
    win.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
    const s = getSettings();
    win.setIgnoreMouseEvents(!!s.zoomClickThrough, { forward: true });
    if (!win.isVisible()) win.showInactive(); // showInactive：不抢焦点，朗读不会被打断
  }

  function deactivate() {
    state.active = false;
    state.zoom = 1;
    state.targetZoom = 1;
    state._pushOrigin = null;
    state.oX = null;
    state.oY = null;
    state.panX = 0;
    state.panY = 0;
    state.exiting = false;
    // 通知覆盖层停掉屏幕捕获流（省电，避免隐藏窗口继续录屏）
    if (overlay && !overlay.isDestroyed() && overlayReady) {
      try {
        overlay.webContents.send('zoom:deactivate');
      } catch (e) {
        /* noop */
      }
    }
    hideOverlay();
    notifyRenderer();
  }

  /** α：请求退出——先平滑缩回 1x，到位后由 step() 收起覆盖层 */
  function beginExit() {
    if (!state.active) {
      deactivate();
      return;
    }
    // 冻结态下 step() 不跑，动画无从推进 → 直接收起，避免窗口卡在屏幕上
    if (state.paused) {
      deactivate();
      return;
    }
    state.exiting = true;
    state.targetZoom = 1;
    notifyRenderer();
  }

  function bump(up) {
    const s = getSettings();
    const zmin = Number(s.zoomMin) || 1;
    const zmax = Number(s.zoomMax) || 24;
    // α：退出动画进行中时，任何放大指令都要能"救回来"
    if (up) state.exiting = false;
    let next;
    if (s.zoomInteger) {
      const base = state.exiting ? state.zoom : state.targetZoom;
      next = up ? Math.floor(base + 1e-6) + 1 : Math.ceil(base - 1e-6) - 1;
      next = Math.max(Math.ceil(zmin - 1e-6), Math.min(Math.floor(zmax + 1e-6), next));
    } else {
      const base = state.exiting ? state.zoom : state.targetZoom;
      next = base * Math.exp(up ? 0.15 : -0.15);
      next = Math.max(zmin, Math.min(zmax, next));
    }
    // F2：缩到 1x 即退出（与 macOS 一致）；zoomMin>1 时 next 被钳在 zoomMin，自然停住，
    //     退出只能靠 Ctrl+Alt+0 / 托盘菜单 / zoom:reset。
    // α：不再"立刻消失"，改为平滑缩回 1x（beginExit → step() 收尾）。
    if (next <= 1 + 1e-6) {
      beginExit();
      return;
    }
    state.targetZoom = next;
  }

  /** F1/T7：放大/缩小一档；未激活时 zoomIn 先 activate，zoomOut 无动作 */
  function nudge(up) {
    if (!state.active) {
      if (up) activate();
      return state.active;
    }
    bump(!!up);
    notifyRenderer();
    return state.active;
  }

  /**
   * α2：倍率快速循环——Ctrl+Alt+Q 在 ZOOM_CYCLE 档位间跳（受 zoomMax 钳制）。
   * 低视力用户从 2x 到 8x 只需按一次，不用连按 6 次 +/-。
   */
  function cycleZoom() {
    const s = getSettings();
    if (!s.zoomEnabled) return false;
    if (!state.active) {
      activate();
      return state.active;
    }
    const zmax = Number(s.zoomMax) || 24;
    const curZ = state.exiting ? state.zoom : state.targetZoom;
    const next = ZOOM_CYCLE.find((v) => v > curZ + 0.01 && v <= zmax + 1e-6);
    state.exiting = false;
    state.targetZoom = next != null ? next : ZOOM_CYCLE[0];
    notifyRenderer();
    return true;
  }

  /** α2：方向键平移步长（源像素）= 当前可见视口的一半，随倍率自适应 */
  function panStep() {
    let d = null;
    try {
      d = screen.getDisplayNearestPoint(state.cursor);
    } catch (e) {
      d = null;
    }
    if (!d) return { dx: 60, dy: 60 };
    const z = Math.max(1.01, state.zoom);
    return {
      dx: (d.bounds.width / z) * PAN_VIEWPORT_FRAC,
      dy: (d.bounds.height / z) * PAN_VIEWPORT_FRAC,
    };
  }

  /**
   * α2：平移画面（Ctrl+Alt+方向键）。解决放大后"指针推不到边缘就看不到屏幕外内容"：
   * 键盘平移不依赖鼠标精度，低视力用户也能把边缘内容滚进来。
   * 冻结态下同样有效（推一帧状态，定格画面可平移查看）。
   */
  function pan(dx, dy) {
    if (!state.active) return false;
    state.panX += Number(dx) || 0;
    state.panY += Number(dy) || 0;
    pushState(); // 立即推一帧：暂停/静止时也立刻生效
    notifyRenderer();
    return true;
  }

  /** F5：暂停=冻结（不再 deactivate），恢复后继续；α2：推一帧让 overlay 显示「已冻结」并播报 */
  function togglePause() {
    state.paused = !state.paused;
    pushState();
    notifyRenderer();
    return state.paused;
  }

  /** 退出缩放：平滑缩回 1x 再收起（冻结态下立即收起） */
  function reset() {
    beginExit();
    return true;
  }

  function onWheel(delta) {
    const s = getSettings();
    if (!s.zoomEnabled || state.paused) return false;
    if (!state.active) {
      if (delta <= 0) return false;
      activate();
      return true;
    }
    bump(delta > 0);
    return true;
  }

  function step() {
    const s = getSettings();
    if (!state.active || state.paused) return; // F5：冻结时跳过
    const smoothing = Math.min(0.95, Math.max(0, Number(s.zoomSmoothing) || 0));
    const lambda = Math.max(1, 60 * (1 - smoothing));
    const dt = Math.min(0.2, (Date.now() - state.lastStepAt) / 1000);
    state.lastStepAt = Date.now();
    const alpha = 1 - Math.exp(-lambda * dt);
    state.zoom += (state.targetZoom - state.zoom) * alpha;
    if (Math.abs(state.targetZoom - state.zoom) < 0.002) state.zoom = state.targetZoom;

    // α：平移跟随平滑（0 = 与指针严格同步；调大则画面"拖着走"，缓解抖动）
    let display = null;
    try {
      display = screen.getDisplayNearestPoint(state.cursor);
    } catch (e) {
      display = null;
    }
    if (display) {
      const raw = rawOrigin(display, state.zoom);
      const follow = Math.min(0.95, Math.max(0, Number(s.zoomFollowSmoothing) || 0));
      if (state.oX == null || follow <= 0.001) {
        state.oX = raw.ox;
        state.oY = raw.oy;
      } else {
        const lambdaO = Math.max(1, 60 * (1 - follow));
        const alphaO = 1 - Math.exp(-lambdaO * dt);
        state.oX += (raw.ox - state.oX) * alphaO;
        state.oY += (raw.oy - state.oY) * alphaO;
      }
    }

    // α：退出动画——缩到 1x 才真正收起（指标 D「缩回 1x 退出」要顺滑，不能"啪"地消失）
    if (state.exiting && state.zoom <= 1.004) {
      deactivate();
      return;
    }

    state._frames += 1;
    const now = Date.now();
    if (now - state._fpsAt >= 500) {
      state.fps = (state._frames * 1000) / (now - state._fpsAt);
      state._frames = 0;
      state._fpsAt = now;
    }
  }

  // -------------------------------------------------------------------------
  // 渲染循环：只在放大态跑，静止时开销极低
  // -------------------------------------------------------------------------
  function startLoop() {
    if (pumpTimer) return;
    _frameLimit = Math.max(1, Number(getSettings().zoomFrameLimit) || 60);
    const interval = Math.round(1000 / _frameLimit);
    pumpTimer = setInterval(() => {
      state.cursor = safeCursorPoint();
      // F3：多显示器跟随——光标跨到另一显示器时重设 bounds 并通知覆盖层重新取流
      if (state.active) {
        let d = null;
        try {
          d = screen.getDisplayNearestPoint(state.cursor);
        } catch (e) {
          d = null;
        }
        if (d && d.id !== state.displayId) {
          state.displayId = d.id;
          if (overlay && !overlay.isDestroyed()) {
            try {
              overlay.setBounds({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height });
            } catch (e) {
              /* noop */
            }
            try {
              overlay.webContents.send('zoom:display-changed', { displayId: d.id });
            } catch (e) {
              /* noop */
            }
          }
        }
      }
      step();
      if (state.active && !state.paused && state.zoom > 1.001) {
        pushState();
      }
    }, interval);
  }

  function stopLoop() {
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
  }

  // -------------------------------------------------------------------------
  // F4：设置热更新（frameLimit / clickThrough / followMode / enabled / trigger）
  // -------------------------------------------------------------------------
  function applySettingsPatch(patch) {
    const p = patch || {};
    if (Object.prototype.hasOwnProperty.call(p, 'zoomFrameLimit')) {
      const next = Math.max(1, Number(p.zoomFrameLimit) || 60);
      if (next !== _frameLimit) {
        _frameLimit = next;
        if (pumpTimer) {
          stopLoop();
          startLoop();
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(p, 'zoomFollowMode')) {
      state._pushOrigin = null;
      state.oX = null; // 换跟随策略后原点不连续，重新取一次
      state.oY = null;
    }
    if (Object.prototype.hasOwnProperty.call(p, 'zoomClickThrough') && overlay && !overlay.isDestroyed()) {
      try {
        overlay.setIgnoreMouseEvents(!!p.zoomClickThrough, { forward: true });
      } catch (e) {
        /* noop */
      }
    }
    if (Object.prototype.hasOwnProperty.call(p, 'zoomEnabled') && !p.zoomEnabled) deactivate();
    if (Object.prototype.hasOwnProperty.call(p, 'zoomTrigger')) applyTriggerMode(p.zoomTrigger);
  }

  /** F1：按 zoomTrigger 重新评估触发模式（拆旧钩子/热键 → 装新的） */
  function applyTriggerMode(pref) {
    if (hookBackend) {
      try {
        hookBackend.stop();
      } catch (e) {
        /* noop */
      }
      hookBackend = null;
    }
    unregisterZoomHotkeys();
    const forceHotkey = pref === 'hotkey';
    if (!forceHotkey) hookBackend = installKoffi() || installUiohook();
    state.backend = hookBackend ? hookBackend.name : 'none';
    if (hookBackend) state.trigger = hookBackend.name;
    else if (registerZoomHotkeys()) state.trigger = 'hotkey';
    else state.trigger = 'none';
    console.log(`[zoom] trigger mode applied: ${state.trigger} (pref=${pref})`);
  }

  // -------------------------------------------------------------------------
  // 全局滚轮捕获
  //   首选 koffi(FFI) 自装 WH_MOUSE_LL —— 能吞掉事件
  //   退化 uiohook-napi —— 只能监听，吞不掉
  //   都没有/强制 hotkey —— F1 热键触发模式（Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0）
  // -------------------------------------------------------------------------
  function modifierDown(mod, mouseButtons) {
    switch (mod) {
      case 'alt': return mouseButtons.alt;
      case 'ctrl': return mouseButtons.ctrl;
      case 'win': return mouseButtons.win;
      case 'middle': return mouseButtons.middle;
      default: return false;
    }
  }

  function installKoffi() {
    let koffi;
    try {
      // eslint-disable-next-line global-require
      koffi = require('koffi');
    } catch (e) {
      return null;
    }
    const user32 = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
    const MSLLHOOKSTRUCT = koffi.struct('MSLLHOOKSTRUCT', {
      pt: POINT, mouseData: 'uint32', flags: 'uint32', time: 'uint32', dwExtraInfo: 'uint64',
    });
    const SetWindowsHookExW = user32.func('void *SetWindowsHookExW(int idHook, void *lpfn, void *hmod, uint32 dwThreadId)');
    const UnhookWindowsHookEx = user32.func('int UnhookWindowsHookEx(void *hhk)');
    const CallNextHookEx = user32.func('int64 CallNextHookEx(void *hhk, int nCode, uint64 wParam, void *lParam)');
    const GetAsyncKeyState = user32.func('int16 GetAsyncKeyState(int vKey)');
    const HOOKPROC = koffi.proto('int64 __stdcall HOOKPROC(int nCode, uint64 wParam, void *lParam)');

    const WM_MOUSEWHEEL = 0x020a;
    const WM_MOUSEHWHEEL = 0x020e;
    const VK_MENU = 0x12;
    const VK_CONTROL = 0x11;
    const VK_LWIN = 0x5b;
    const VK_RWIN = 0x5c;

    const cb = koffi.register((nCode, wParam, lParam) => {
      try {
        if (nCode >= 0 && lParam && (wParam === WM_MOUSEWHEEL || wParam === WM_MOUSEHWHEEL)) {
          const st = koffi.decode(lParam, MSLLHOOKSTRUCT);
          const raw = (st.mouseData >> 16) & 0xffff;
          let delta = raw > 0x7fff ? raw - 0x10000 : raw;
          if (wParam === WM_MOUSEHWHEEL) delta = -delta;
          const s = getSettings();
          const down = modifierDown(s.zoomModifier, {
            alt: (GetAsyncKeyState(VK_MENU) & 0x8000) !== 0,
            ctrl: (GetAsyncKeyState(VK_CONTROL) & 0x8000) !== 0,
            win: ((GetAsyncKeyState(VK_LWIN) | GetAsyncKeyState(VK_RWIN)) & 0x8000) !== 0,
            middle: false, // 中键修饰由 uiohook 路径提供；koffi 路径暂不支持
          });
          if (down && onWheel(delta) && s.zoomSwallowScroll) {
            return 1; // 吞掉：页面不会跟着滚动
          }
        }
      } catch (e) {
        /* 钩子回调内绝不抛异常 */
      }
      return CallNextHookEx(hookHandle, nCode, wParam, lParam);
    }, koffi.pointer(HOOKPROC));

    hookHandle = SetWindowsHookExW(14, cb, null, 0); // WH_MOUSE_LL = 14
    if (!hookHandle) {
      hookHandle = null;
      return null;
    }
    // 注意：低级钩子依赖消息泵，Electron 主线程自带，无需自己泵
    return {
      name: 'koffi',
      stop() {
        if (hookHandle) UnhookWindowsHookEx(hookHandle);
        hookHandle = null;
      },
      winSuppression: true,
    };
  }

  function installUiohook() {
    let uIOhook;
    try {
      // eslint-disable-next-line global-require
      ({ uIOhook } = require('uiohook-napi'));
    } catch (e) {
      return null;
    }
    const keyState = { alt: false, ctrl: false, win: false, middle: false };
    uIOhook.on('keydown', (e) => {
      if (e.keycode === 42 || e.keycode === 56) keyState.alt = true; // Alt / AltGr
      if (e.keycode === 29 || e.keycode === 3613) keyState.ctrl = true;
      if (e.keycode === 3675 || e.keycode === 3676) keyState.win = true;
    });
    uIOhook.on('keyup', (e) => {
      if (e.keycode === 42 || e.keycode === 56) keyState.alt = false;
      if (e.keycode === 29 || e.keycode === 3613) keyState.ctrl = false;
      if (e.keycode === 3675 || e.keycode === 3676) keyState.win = false;
    });
    uIOhook.on('mousedown', (e) => {
      if (e.button === 2) keyState.middle = true;
    });
    uIOhook.on('mouseup', (e) => {
      if (e.button === 2) keyState.middle = false;
    });
    uIOhook.on('wheel', (e) => {
      const s = getSettings();
      if (modifierDown(s.zoomModifier, keyState)) onWheel(e.rotation > 0 ? 120 : -120);
    });
    uIOhook.start();
    return {
      name: 'uiohook',
      stop() {
        try {
          uIOhook.stop();
        } catch (e) { /* noop */ }
      },
      winSuppression: false,
    };
  }

  // -------------------------------------------------------------------------
  // F1：热键触发模式（Ctrl+Alt+= 放大 / Ctrl+Alt+- 缩小 / Ctrl+Alt+0 退出）
  //     注册失败不抛：记 state.zoomHotkeyOk=false + console.warn（托盘/设置层可据此提示）
  // -------------------------------------------------------------------------
  function unregisterZoomHotkeys() {
    ZOOM_HOTKEYS.forEach(({ accel }) => {
      try {
        if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
      } catch (e) {
        /* noop */
      }
    });
    state.zoomHotkeyOk = false;
  }

  function registerZoomHotkeys() {
    unregisterZoomHotkeys(); // 幂等：先清理再注册
    let ok = true;
    ZOOM_HOTKEYS.forEach(({ accel, hint }) => {
      try {
        const r = globalShortcut.register(accel, () => {
          const s = getSettings();
          // 总开关关闭时仅保留退出键（幂等无害），其余不动作
          if (!s.zoomEnabled && accel !== 'Ctrl+Alt+0') return;
          if (accel === 'Ctrl+Alt+=') nudge(true);
          else if (accel === 'Ctrl+Alt+-') nudge(false);
          else if (accel === 'Ctrl+Alt+0') reset();
          else if (accel === 'Ctrl+Alt+Q') cycleZoom();
          else if (accel === 'Ctrl+Alt+Left' || accel === 'Ctrl+Alt+Right' || accel === 'Ctrl+Alt+Up' || accel === 'Ctrl+Alt+Down') {
            const st = panStep();
            if (accel === 'Ctrl+Alt+Left') pan(-st.dx, 0);
            else if (accel === 'Ctrl+Alt+Right') pan(st.dx, 0);
            else if (accel === 'Ctrl+Alt+Up') pan(0, -st.dy);
            else pan(0, st.dy);
          }
        });
        if (!r) {
          ok = false;
          console.warn(`[zoom] 热键注册失败（可能被其他程序占用）：${accel} ${hint}`);
        }
      } catch (e) {
        ok = false;
        console.warn(`[zoom] 热键注册异常：${accel} ${hint}`, e && e.message);
      }
    });
    state.zoomHotkeyOk = ok;
    console.log(`[zoom] 热键模式注册结果 ok=${ok}（Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0）`);
    return ok;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------
  function start() {
    const s = getSettings();
    if (s.zoomTrigger === 'hotkey') {
      hookBackend = null;
      state.backend = 'none';
    } else {
      // 'auto'：有 koffi/uiohook 用滚轮，都没有 → 自动降级热键模式
      hookBackend = installKoffi() || installUiohook();
      state.backend = hookBackend ? hookBackend.name : 'none';
    }
    if (hookBackend) state.trigger = hookBackend.name;
    else if (registerZoomHotkeys()) state.trigger = 'hotkey';
    else state.trigger = 'none';
    console.log(`[zoom] 输入后端: backend=${state.backend} trigger=${state.trigger} zoomHotkeyOk=${state.zoomHotkeyOk}`);
    startLoop();
    registerIpc();
  }

  function stop() {
    stopLoop();
    if (hookBackend) {
      try {
        hookBackend.stop();
      } catch (e) {
        /* noop */
      }
      hookBackend = null;
    }
    unregisterZoomHotkeys();
    state.active = false;
    state.paused = false;
    state.zoom = 1;
    state.targetZoom = 1;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
    overlayReady = false;
    state.backend = 'none';
    state.trigger = 'none';
  }

  // -------------------------------------------------------------------------
  // IPC：渲染进程（设置界面）↔ 主进程
  // -------------------------------------------------------------------------
  function registerIpc() {
    const handlers = {
      'zoom:get': () => ({
        ...pickZoom(getSettings()),
        zoomTrigger: getSettings().zoomTrigger === 'hotkey' ? 'hotkey' : 'auto',
        active: state.active,
        paused: state.paused,
        zoom: state.zoom,
        backend: state.backend,
        trigger: state.trigger,
        zoomHotkeyOk: !!state.zoomHotkeyOk,
        fps: Math.round(state.fps),
      }),
      // 覆盖层索取屏幕源：按 displayId 精确匹配，匹配不到就退回第一个
      'zoom:getSource': async (_e, displayId) => {
        try {
          const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
          const hit = sources.find((s) => String(s.display_id) === String(displayId));
          const source = hit || sources[0];
          return source ? source.id : null;
        } catch (e) {
          console.warn('[zoom] desktopCapturer 取源失败:', e && e.message);
          return null;
        }
      },
      'zoom:set': (_e, patch) => {
        const p = patch || {};
        saveSettings(p);
        applySettingsPatch(p);
        return true;
      },
      'zoom:togglePause': () => togglePause(),
      'zoom:nudge': (_e, up) => nudge(!!up),
      'zoom:reset': () => reset(),
      // α2：倍率快速循环 / 方向键平移（设置界面或未来悬浮球可调用）
      'zoom:cycle': () => cycleZoom(),
      'zoom:pan': (_e, dx, dy) => pan(Number(dx) || 0, Number(dy) || 0),
    };
    Object.entries(handlers).forEach(([ch, fn]) => {
      if (ipcMain.listenerCount(ch) === 0) ipcMain.handle(ch, fn);
    });
    if (ipcMain.listenerCount('zoom:error') === 0) {
      ipcMain.on('zoom:error', (_e, msg) => console.warn('[zoom] overlay error:', String(msg)));
    }
  }

  function pickZoom(s) {
    const out = {};
    Object.keys(ZOOM_DEFAULTS).forEach((k) => {
      out[k] = Object.prototype.hasOwnProperty.call(s, k) ? s[k] : ZOOM_DEFAULTS[k];
    });
    return out;
  }

  // 供托盘菜单 / 主窗口调用
  function notifyRenderer() {
    const w = getMainWindow && getMainWindow();
    if (w && !w.isDestroyed()) {
      try {
        w.webContents.send('zoom:changed', {
          active: state.active,
          zoom: state.zoom,
          paused: state.paused,
          trigger: state.trigger,
          zoomHotkeyOk: !!state.zoomHotkeyOk,
        });
      } catch (e) {
        /* 渲染进程未就绪时忽略 */
      }
    }
  }

  const api = {
    start,
    stop,
    state,
    activate,
    deactivate,
    nudge,
    cycleZoom,
    pan,
    panStep,
    togglePause,
    reset,
    onWheel,
    applySettingsPatch,
    registerZoomHotkeys,
    unregisterZoomHotkeys,
    reregisterZoomHotkeys: registerZoomHotkeys, // hotkeyTray unregisterAll 后补注册用
    notifyRenderer,
    ZOOM_DEFAULTS,
    _buildTransform: buildTransform,
  };
  _instance = api; // F8：模块级单例
  return api;
}

/** F8：托盘 / 悬浮球 / ipc 获取控制器单例（未创建时为 null） */
function getZoomController() {
  return _instance;
}

module.exports = { createZoomController, getZoomController, ZOOM_DEFAULTS };
