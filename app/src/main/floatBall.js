// 桌面悬浮球（鼠标入口）：56x56 透明无边框、alwaysOnTop、不抢焦点（focusable:false，
// 保证 readSelection 的 SendKeys Ctrl+C 仍作用于原前台程序）、不出现在任务栏。
// 唯一例外：右键菜单打开期间临时可聚焦（否则窗口永远收不到 Esc / blur，菜单关不掉），
// 菜单一关立刻回到 focusable:false，见 applyFocusable / handleMenu。
// 页面加载顺序：dist/renderer/floatball.html（打包后）优先，public/floatball.html（开发态）兜底。
// IPC 由 ipc.js 统一注册，本模块只提供处理函数；任何失败都不能拖垮主进程。
'use strict';

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen } = require('electron');
const { readSelection } = require('./selectionReader');
const a11y = require('./a11yFeedback');
const { getSettings, saveSettings } = require('./settingsStore');
const zoomController = require('./zoomController');

// α-视觉增强：悬浮球尺寸档位（56 对低视力仍偏小 → 支持 80 / 112）
const BALL_SIZES = [56, 80, 112];
const BALL_SIZE_DEFAULT = 56;
const MARGIN = 24;
const PLAYBACK_CMDS = ['play', 'pause', 'stop', 'prev', 'next'];

/** 当前球体边长（读 settings.floatBallSize，吸附到最近档位） */
function ballSize() {
  let raw = BALL_SIZE_DEFAULT;
  try {
    const v = Number(getSettings().floatBallSize);
    if (isFinite(v) && v > 0) raw = v;
  } catch (e) {
    /* 读不到就用默认 */
  }
  let best = BALL_SIZES[0];
  BALL_SIZES.forEach((s) => {
    if (Math.abs(s - raw) < Math.abs(best - raw)) best = s;
  });
  return best;
}

let ballWin = null;
let dragOrigin = null;
let getMainWindowFn = null;
let getStateFn = null;
let ensureWindowFn = null;
// 右键菜单打开期间的窗口备份（菜单关闭后恢复球体尺寸与原位置）
let menuBackup = null;
// 右键菜单是否展开。只有展开期间窗口才临时可聚焦——这是 blur/Esc 能收到的前提；
// 关闭后必须立刻恢复 focusable:false，否则球会长期占据前台、吞掉用户的键盘输入。
let menuActive = false;

function floatBallHtmlPath() {
  const candidates = [
    path.join(__dirname, '..', '..', 'dist', 'renderer', 'floatball.html'),
    path.join(__dirname, '..', '..', 'public', 'floatball.html'),
  ];
  return (
    candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch (e) {
        return false;
      }
    }) || ''
  );
}

/** 把 (x,y) 夹回所在显示器 workArea，防止球被拖出屏幕 */
function clampPos(x, y) {
  const size = ballSize();
  try {
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    const maxX = Math.max(wa.x, wa.x + wa.width - size);
    const maxY = Math.max(wa.y, wa.y + wa.height - size);
    return {
      x: Math.min(Math.max(x, wa.x), maxX),
      y: Math.min(Math.max(y, wa.y), maxY),
    };
  } catch (e) {
    return { x, y };
  }
}

/** 主屏 workArea 右下角（边距 24px） */
function defaultPos() {
  const size = ballSize();
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return clampPos(wa.x + wa.width - size - MARGIN, wa.y + wa.height - size - MARGIN);
  } catch (e) {
    return { x: 0, y: 0 };
  }
}

function initialPos() {
  let pos = null;
  try {
    pos = getSettings().floatBallPos;
  } catch (e) {
    pos = null;
  }
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return defaultPos();
  return clampPos(pos.x, pos.y);
}

function createBall() {
  if (ballWin && !ballWin.isDestroyed()) return ballWin;
  const html = floatBallHtmlPath();
  if (!html) {
    console.error('[floatball] floatball.html not found (dist/renderer or public)');
    return null;
  }
  const pos = initialPos();
  const size = ballSize();
  ballWin = new BrowserWindow({
    width: size,
    height: size,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    ballWin.setVisibleOnAllWorkspaces(true);
  } catch (e) {
    /* 旧平台不支持时忽略 */
  }
  // 新窗口一律从「不可聚焦、无菜单」开始（dispose 后重建不能残留旧状态）
  menuActive = false;
  menuBackup = null;
  ballWin.setPosition(pos.x, pos.y);
  ballWin.loadFile(html).catch((e) => {
    console.error('[floatball] load failed:', e && e.message);
  });
  ballWin.on('ready-to-show', () => {
    try {
      ballWin.show();
      // 立即广播一次初始状态（热键冲突时球第一时间变红，无需等首次播放状态上报）
      broadcastState();
    } catch (e) {
      /* noop */
    }
  });
  ballWin.on('closed', () => {
    ballWin = null;
  });
  console.log(`[floatball] created at (${pos.x},${pos.y}) size=${size} html=${html}`);
  return ballWin;
}

/**
 * α-视觉增强：设置热更新（floatBallSize）。改档位后立刻改窗口尺寸并把球夹回屏幕内，
 * 同时广播一次状态让页面同步自身尺寸与菜单字号。
 */
function applySettingsPatch(patch) {
  try {
    const p = patch || {};
    if (!Object.prototype.hasOwnProperty.call(p, 'floatBallSize')) return;
    if (!ballWin || ballWin.isDestroyed()) return;
    // ipc.js 在落盘前回调这里，所以优先用传入值；没传才回读 settings
    let size = Number(p.floatBallSize);
    if (!isFinite(size) || size <= 0) size = ballSize();
    let best = BALL_SIZES[0];
    BALL_SIZES.forEach((s) => {
      if (Math.abs(s - size) < Math.abs(best - size)) best = s;
    });
    size = best;
    const [x, y] = ballWin.getPosition();
    const pos = clampPos(x, y);
    ballWin.setBounds({ x: pos.x, y: pos.y, width: size, height: size }, false);
    menuBackup = null;
    broadcastState();
    console.log(`[floatball] size -> ${size} at (${pos.x},${pos.y})`);
  } catch (e) {
    console.error('[floatball] applySettingsPatch failed:', e && e.message);
  }
}

/**
 * 初始化：保存 getWindow/getState 回调；按 settings.floatBallEnabled 决定是否立即创建窗口。
 * @param {() => import('electron').BrowserWindow|null} getWindow 主窗口获取器
 * @param {() => {playback:{isPlaying:boolean,buffering:boolean,hasAudio:boolean}, hotkey:string, hotkeyOk:boolean}} getState
 */
function initFloatBall(getWindow, getState, ensureWindow) {
  try {
    getMainWindowFn = getWindow;
    getStateFn = getState;
    ensureWindowFn = typeof ensureWindow === 'function' ? ensureWindow : null;
    let enabled = true;
    try {
      enabled = getSettings().floatBallEnabled !== false;
    } catch (e) {
      enabled = true;
    }
    if (enabled) createBall();
    else console.log('[floatball] disabled by settings (floatBallEnabled=false)');
  } catch (e) {
    console.error('[floatball] init failed:', e && e.message);
  }
}

/** 开/关悬浮球；开时按需懒创建窗口 */
function setEnabled(on) {
  try {
    if (on) {
      if (!ballWin || ballWin.isDestroyed()) createBall();
      if (ballWin && !ballWin.isDestroyed()) {
        ballWin.show();
        broadcastState();
      }
    } else if (ballWin && !ballWin.isDestroyed()) {
      // 菜单还开着就隐藏：先把扩大的窗口与临时焦点收回去，否则下次显示会留下一个
      // 205x392 的透明空挡板（会吞掉桌面上的点击）
      if (menuActive || menuBackup) handleMenu({ open: false });
      ballWin.hide();
    }
  } catch (e) {
    console.error('[floatball] setEnabled failed:', e && e.message);
  }
}

/** 托盘菜单用：可见则隐藏，否则显示 */
function toggle() {
  try {
    // 走 setEnabled(false) 而不是裸 hide()：隐藏前要顺带收回菜单留下的 focusable
    if (ballWin && !ballWin.isDestroyed() && ballWin.isVisible()) setEnabled(false);
    else setEnabled(true);
  } catch (e) {
    console.error('[floatball] toggle failed:', e && e.message);
  }
}

/** 复位到默认右下角（saveSystem 传 floatBallPos:null 时） */
function resetPosition() {
  try {
    if (ballWin && !ballWin.isDestroyed()) {
      const p = defaultPos();
      ballWin.setPosition(p.x, p.y);
    }
  } catch (e) {
    /* noop */
  }
}

/** 移动到指定坐标（clamp 后） */
function setPosition(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return;
  try {
    const p = clampPos(pos.x, pos.y);
    if (ballWin && !ballWin.isDestroyed()) ballWin.setPosition(p.x, p.y);
  } catch (e) {
    /* noop */
  }
}

function dispose() {
  try {
    if (ballWin && !ballWin.isDestroyed()) ballWin.destroy();
  } catch (e) {
    /* noop */
  }
  ballWin = null;
  dragOrigin = null;
  menuBackup = null;
  menuActive = false;
}

/** 向球窗口广播状态 {isPlaying, buffering, hotkey, hotkeyOk} */
function broadcastState() {
  if (!ballWin || ballWin.isDestroyed()) return;
  let s = { playback: {}, hotkey: 'F1', hotkeyOk: false };
  try {
    if (typeof getStateFn === 'function') s = getStateFn() || s;
  } catch (e) {
    /* 用默认值 */
  }
  const payload = {
    isPlaying: !!(s.playback && s.playback.isPlaying),
    buffering: !!(s.playback && s.playback.buffering),
    hotkey: s.hotkey || 'F1',
    hotkeyOk: !!s.hotkeyOk,
    size: ballSize(), // α：页面据此同步球体/图标/菜单字号
  };
  try {
    ballWin.webContents.send('floatBall:state', payload);
  } catch (e) {
    /* 页面未就绪时忽略 */
  }
}

/**
 * 临时切换窗口可聚焦（右键菜单专用，W-FIX3）。
 *
 * 背景：球窗口常驻 focusable:false，窗口永远拿不到焦点 → 渲染层的
 * `window.addEventListener('blur', closeMenu)` 是死代码、Esc 也进不来，
 * 用户点桌面/别的程序时菜单收不回去。
 *
 * 因此菜单打开时 setFocusable(true)+focus()，让 blur/Esc 真正可达；
 * 关闭时先 blur() 把前台还给用户原来的窗口（划词 Ctrl+C 依赖它），再 setFocusable(false)。
 * 只改 WS_EX_NOACTIVATE，不销毁/重建窗口 —— transparent 窗口重建会闪。
 */
function applyFocusable(on) {
  if (!ballWin || ballWin.isDestroyed()) return;
  try {
    if (on) {
      ballWin.setFocusable(true);
      ballWin.focus();
    } else {
      try {
        if (ballWin.isFocused()) ballWin.blur();
      } catch (e) {
        /* 非 Windows/旧版本没有 blur 时忽略 */
      }
      ballWin.setFocusable(false);
    }
  } catch (e) {
    console.error('[floatball] applyFocusable failed:', e && e.message);
  }
}

/**
 * v2.3 右键菜单窗口扩容：球窗口只有 56x56，直接弹菜单会被裁切。
 * 菜单打开时把窗口临时放大到菜单尺寸（锚定球右侧，空间不足翻转到左侧），
 * 关闭时恢复球体大小与位置，并立刻收回可聚焦状态（focusable:false）。
 */
function handleMenu(payload) {
  try {
    if (!ballWin || ballWin.isDestroyed()) return;
    const open = !!(payload && payload.open);
    if (open) {
      const w = Math.max(120, Math.min(400, Number(payload && payload.width) || 176)) + 16;
      const h = Math.max(120, Math.min(600, Number(payload && payload.height) || 268)) + 12;
      if (!menuBackup) {
        const [bx, by] = ballWin.getPosition();
        menuBackup = { x: bx, y: by };
      }
      const b = ballWin.getBounds();
      const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
      let nx = b.x + b.width + 4;
      if (nx + w > wa.x + wa.width) nx = b.x - w + b.width - 4; // 右侧空间不足 → 向左展开
      nx = Math.min(Math.max(nx, wa.x), Math.max(wa.x, wa.x + wa.width - w));
      let ny = b.y - 4;
      ny = Math.min(Math.max(ny, wa.y), Math.max(wa.y, wa.y + wa.height - h));
      ballWin.setBounds({ x: nx, y: ny, width: w, height: h }, false);
      // 先扩窗再夺焦：菜单与窗口尺寸已定型，焦点落上去不会随 resize 抖动
      menuActive = true;
      applyFocusable(true);
    } else if (menuActive || menuBackup) {
      if (menuBackup) {
        const target = dragOrigin || menuBackup;
        ballWin.setBounds(
          { x: target[0] !== undefined ? target[0] : target.x, y: target[1] !== undefined ? target[1] : target.y, width: ballSize(), height: ballSize() },
          false,
        );
        menuBackup = null;
      }
      menuActive = false;
      applyFocusable(false);
    }
  } catch (e) {
    console.error('[floatball] menu resize failed:', e && e.message);
  }
}

/** floatBall:cmd 载荷：{cmd:'read'|'play'|'pause'|'stop'|'prev'|'next'|'zoomIn'|'zoomOut'|'zoomExit'|'zoomPause'|'menu'|'hide', ...} */

/** 取一个可投递的窗口；真被销毁时尝试重建。
 *  历史 bug：主窗口被叉掉后 mainWindow=null，球的点击指令 `if (win) send` 静默丢弃 ——
 *  用户感觉「球点了没反应、图标还一直不变」。 */
function resolveWindow() {
  const w = typeof getMainWindowFn === 'function' ? getMainWindowFn() : null;
  if (w && !w.isDestroyed()) return w;
  if (ensureWindowFn) {
    try {
      const nw = ensureWindowFn();
      if (nw && !nw.isDestroyed()) return nw;
    } catch (e) {
      console.warn('[floatball] ensureWindow failed:', e && e.message);
    }
  }
  return null;
}

async function handleCmd(payload) {
  const cmd = typeof payload === 'string' ? payload : payload && payload.cmd;
  try {
    if (cmd === 'menu') {
      handleMenu(payload);
      return;
    }
    if (cmd === 'hide') {
      // 菜单「隐藏悬浮球」：隐藏窗口；恢复走托盘「显示/隐藏悬浮球」或设置开关
      if (ballWin && !ballWin.isDestroyed()) {
        // 同 setEnabled(false)：先收回菜单留下的扩大窗口与 focusable
        if (menuActive || menuBackup) handleMenu({ open: false });
        ballWin.hide();
      }
      console.log('[floatball] hidden by context menu');
      return;
    }
    if (cmd === 'read') {
      // 与热键同规格：入口第一行即出反馈音（基线指标 E，≤200ms 让用户知道「指令已收到」）
      try { a11y.cue('press'); } catch (_) { /* 反馈音失败不阻塞朗读 */ }
      const r = await readSelection();
      const win = resolveWindow();
      if (win) {
        // 与全局热键完全同路：hotkey:read-selection {text, source}
        win.webContents.send('hotkey:read-selection', { text: r.text, source: r.source });
      } else {
        // 不许静默：球点了但送不出去，必须说明（否则用户以为软件坏了）
        try {
          a11y.announce({
            text: '主窗口已关闭，朗读送不出去。请右键任务栏右下角的明读图标，选择「显示主窗口」。',
            priority: 'high',
          });
        } catch (e) {
          /* 播报失败至少留日志 */
        }
      }
      console.log(`[floatball] click -> source=${r.source} len=${(r.text || '').length} tookMs=${r.tookMs} delivered=${!!win}`);
      return;
    }
    // v2.3 屏幕缩放指令：zoomIn/zoomOut/zoomExit/zoomPause（控制器未就绪则忽略）
    if (cmd === 'zoomIn' || cmd === 'zoomOut' || cmd === 'zoomExit' || cmd === 'zoomPause') {
      const zoomCtl = zoomController.getZoomController();
      if (!zoomCtl) {
        console.warn('[floatball] zoom cmd ignored: controller not ready');
        return;
      }
      if (cmd === 'zoomIn') zoomCtl.nudge(true); // 未激活则先 activate
      else if (cmd === 'zoomOut') zoomCtl.nudge(false);
      else if (cmd === 'zoomExit') zoomCtl.reset();
      else zoomCtl.togglePause();
      broadcastState();
      return;
    }
    if (PLAYBACK_CMDS.indexOf(cmd) !== -1) {
      const win = resolveWindow();
      if (win) {
        win.webContents.send('playback:cmd', { cmd });
      } else {
        try {
          a11y.announce({ text: '主窗口已关闭，播放指令没有送达。', priority: 'high' });
        } catch (e) {
          /* noop */
        }
      }
      return;
    }
    console.warn('[floatball] unknown cmd:', cmd);
  } catch (e) {
    console.error('[floatball] handleCmd failed:', cmd, e && e.message);
  }
}

/** floatBall:dragStart：记录窗口起始位置 */
function handleDragStart() {
  try {
    if (ballWin && !ballWin.isDestroyed()) dragOrigin = ballWin.getPosition();
  } catch (e) {
    dragOrigin = null;
  }
}

/** floatBall:dragMove {dx,dy}：起点 + 增量，clamp 进 workArea */
function handleDragMove(payload) {
  try {
    if (!ballWin || ballWin.isDestroyed() || !dragOrigin) return;
    const dx = Number(payload && payload.dx) || 0;
    const dy = Number(payload && payload.dy) || 0;
    const p = clampPos(dragOrigin[0] + dx, dragOrigin[1] + dy);
    ballWin.setPosition(p.x, p.y);
  } catch (e) {
    /* noop */
  }
}

/** floatBall:dragEnd：位置持久化进 settings.json 的 floatBallPos */
function handleDragEnd() {
  try {
    if (ballWin && !ballWin.isDestroyed()) {
      const [x, y] = ballWin.getPosition();
      saveSettings({ floatBallPos: { x, y } });
      console.log(`[floatball] position saved (${x},${y})`);
    }
  } catch (e) {
    console.error('[floatball] dragEnd persist failed:', e && e.message);
  } finally {
    dragOrigin = null;
    // 拖拽全程不需要焦点；结束时会话已散，只要菜单没开就立刻收回可聚焦状态，
    // 防止球继续占着前台、挡住别的程序的键盘输入。
    if (!menuActive) applyFocusable(false);
  }
}

module.exports = {
  initFloatBall,
  setEnabled,
  toggle,
  resetPosition,
  setPosition,
  dispose,
  broadcastState,
  applySettingsPatch,
  BALL_SIZES,
  handleCmd,
  handleDragStart,
  handleDragMove,
  handleDragEnd,
};
