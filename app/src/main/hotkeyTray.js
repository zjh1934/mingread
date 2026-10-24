// 全局热键 + 系统托盘。默认热键 F1（v2.4.0 起，用户 2026-10-24 明确要求"选中文字按 F1 即读"，
// 推翻基线 P2-11 的 Ctrl+Alt+R 默认；Ctrl+Alt+R 降为设置里的备选预设）：在任意位置选中
// 文字后按热键直接朗读。
// v2.4.0 起 F1 有**三层保障**（用户诉求是「按 F1 就必须出声」，不能因为别人占了键就失效）：
//   ① 官方 API：globalShortcut.register('F1')，正常情况走这条；
//   ② 低级键盘钩子旁路：RegisterHotKey 是独占的，被别的程序先占（本机实测：网吧管理客户端
//      稳定占用 F1，globalShortcut 恒返回 false）时，用 WH_KEYBOARD_LL 钩子旁听按键 ——
//      钩子挂在输入分发链最前端，热键被独占也照样收得到（见 platform/keyboardHook.js）；
//   ③ 冲突播报：连钩子都装不上（koffi 缺失/非 Windows）才播报不可用，并每 5s 重试注册，
//      外部程序一放手就切回官方 API（切回后立刻卸钩子，避免一次按键触发两遍）。
// v2.2：注册结果可观测（console.log + isRegistered()），失败时托盘气泡 + 主窗口 hotkey:conflict 事件。
// v2.3.1（三项修复，均为低视力可用性红线）：
//   1. 注册失败除托盘气泡/窗口事件外，必须经 a11yFeedback.announce 语音播报
//      「热键被其他程序占用」——主窗口可能未聚焦甚至隐藏，只弹 Snackbar 不够可感知（基线 P1-7）。
//   2. register() 不再 globalShortcut.unregisterAll()：那会把 zoomController 的
//      Ctrl+Alt+=/-/0 缩放热键一起清掉（旧设计靠补注册兜底，很脆）。改为只精准注销
//      自己上一个朗读热键，缩放热键天然不受影响。
//   3. 热键回调第一行立即 cue('press')（基线指标 E：≤200ms 出反馈音）：主进程侧直接播放，
//      不等 readSelection（X11 实测约 31ms，失败要等满超时），也不依赖主窗口聚焦。
'use strict';

const { globalShortcut, Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { readSelection } = require('./selectionReader');
const zoomController = require('./zoomController');
// v2.4.0：F1 被其他程序独占时的旁路捕获层（低级键盘钩子，koffi 缺失时自身降级为不可用）
const keyboardHook = require('./platform/keyboardHook');
// γ 的 a11yFeedback：只读使用其导出（announce / cue），不修改其实现
const a11y = require('./a11yFeedback');
// 抓选区会短暂改写剪贴板：告知剪贴板监视器静默，避免被误判成「用户又复制了一次」
const { suppressAutoRead } = require('./clipboardMonitor');

/** v2.4.0 默认热键：F1（用户明确要求；Ctrl+Alt+R 为备选预设） */
const DEFAULT_HOTKEY = 'F1';

/**
 * 可用「低级键盘钩子」旁路捕获的加速器 → 虚拟键码。
 * 只收单键：组合键（Ctrl+Alt+R 等）需要跟踪修饰键状态，钩子实现复杂度不成比例，
 * 而且组合键冲突概率远低于 F1（F1 是各路软件的常用热键）。
 * F1 = VK_F1(0x70)。
 */
const HOOKABLE_ACCELS = { F1: 0x70 };

function trayIcon() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'icon.png'));
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'icon.png'));
  const p = candidates.find((x) => fs.existsSync(x));
  if (p) {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

/**
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {() => string} getHotkey 例如 'Ctrl+Alt+R'
 * @param {() => void} [toggleFloatBall] 显示/隐藏悬浮球（由 index.js 注入 floatBall.toggle）
 */
function registerHotkeyTray(getWindow, getHotkey, toggleFloatBall, ensureWindow) {
  let tray = null;
  let busy = false;
  let registered = false;
  let disposed = false;
  /** 本模块自己注册成功的朗读热键；只注销它，绝不动别人（缩放）的热键 */
  let registeredAccel = '';

  /** 取一个**可用**的主窗口：优先现有窗口（隐藏态也能 show 回来），
   *  真被销毁时调 ensureWindow 重建。返回 null 表示连重建都失败。 */
  function resolveWindow() {
    const w = getWindow();
    if (w && !w.isDestroyed()) return w;
    if (typeof ensureWindow === 'function') {
      try {
        const nw = ensureWindow();
        if (nw && !nw.isDestroyed()) return nw;
      } catch (e) {
        console.warn('[hotkey] ensureWindow failed:', e && e.message);
      }
    }
    return null;
  }

  /** 托盘点击 / 菜单「显示主窗口」的唯一入口：恢复、置顶、聚焦 */
  function showMainWindow() {
    const w = resolveWindow();
    if (!w) {
      // 连重建都失败：必须让用户知道，不能点了没反应
      try {
        a11y.announce({
          text: '主窗口已关闭且无法重新打开，请从开始菜单重新启动明读。',
          priority: 'high',
        });
      } catch (e) {
        /* 播报失败时至少留日志 */
      }
      console.error('[hotkey] showMainWindow: no window available');
      return false;
    }
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    } catch (e) {
      console.warn('[hotkey] showMainWindow failed:', e && e.message);
      return false;
    }
    return true;
  }

  /** 热键按下的即时反馈（v2.4.0 起默认关闭，见 settingsStore.hotkeyCue） */
  function firePressCue(t0) {
    // 用户反馈：选中文字按热键后「滴」一声没必要（本地引擎 150ms 就出声，提示音像干扰）。
    // 默认关；仅在设置里显式打开时才播。注意：这里只跳过**提示音**，
    // 朗读链路与「没有选中文字」的语音播报完全不受影响。
    try {
      // eslint-disable-next-line global-require
      if (!require('./settingsStore').getSettings().hotkeyCue) return;
    } catch (e) {
      /* 读设置失败就保持静音（宁可少一声，也不要误响） */
      return;
    }
    try {
      const p = a11y.cue('press');
      if (p && typeof p.then === 'function') {
      p.then((r) => {
        // tookMs=按键事件到达主进程→提示音在音频窗口播放；at=按键事件到达时刻（epoch ms，供端到端比对）
        console.log(`[hotkey] press cue ok=${!!(r && r.ok)} tookMs=${Date.now() - t0} at=${t0}`);
      }).catch((e) => {
          console.warn('[hotkey] press cue failed:', e && e.message);
        });
      }
    } catch (e) {
      console.warn('[hotkey] press cue threw:', e && e.message);
    }
  }

  async function triggerSelectionRead() {
    const t0 = Date.now();
    // 指标 E：用户按下的瞬间就有反馈音，之后才做可能耗时几百毫秒的抓选区
    firePressCue(t0);
    if (busy) {
      console.log(`[hotkey] busy, read skipped (t+${Date.now() - t0}ms)`);
      return;
    }
    busy = true;
    try {
      // 关键：先确认有窗口能接收结果，否则抓完选区才丢弃（用户只听到提示音、毫无说明）。
      // 这条路径曾经就是这么静默 return 的 —— 用户原话「按热键它不出来，就低一下，也不说一下」。
      const target = resolveWindow();
      if (!target) {
        a11y.announce({
          text: '没有可以朗读的窗口。请右键任务栏右下角的明读图标，选择「显示主窗口」。',
          priority: 'high',
        });
        console.warn('[hotkey] read skipped: no window to deliver result');
        return;
      }
      // 抓选区期间（发 Ctrl+C → 读完还原）抑制复制即读，否则监视器会把选区内容和
      // 还原后的旧剪贴板当成连续两次复制，造成重复朗读（含旧剪贴板误读）
      suppressAutoRead(1500);
      const r = await readSelection();
      // 抓选区要几百毫秒，这期间窗口可能被关 —— 重新取一次，别拿旧引用
      const win = resolveWindow();
      if (!win) {
        a11y.announce({ text: '主窗口已关闭，这次朗读没有送达。', priority: 'high' });
        return;
      }
      // v2.3：整包透传（多出 code/message/stale），上层据此播报"未获取到选区"或"这是剪贴板内容"
      win.webContents.send('hotkey:read-selection', { ...r });
      console.log(
        `[hotkey] fired -> source=${r.source} code=${r.code} len=${(r.text || '').length} tookMs=${r.tookMs} totalMs=${Date.now() - t0}`
      );
    } catch (e) {
      console.error('[hotkey] read-selection failed:', e && e.message);
    } finally {
      busy = false;
    }
  }

  /** 注册失败：语音播报（主进程侧，窗口未聚焦也能听到）+ 托盘气泡 + 通知主窗口
   *  @param {string} accelerator
   *  @param {{hooked?:boolean}} [opts] hooked=true 表示低级钩子已接管：功能可用，文案必须改，
   *         否则会对着「已经能按 F1 朗读」的用户播报「朗读暂不可用」，属严重误导。
   */
  function reportConflict(accelerator, opts) {
    const hooked = !!(opts && opts.hooked);
    // 基线 P1-7 / 指标 G：状态变化必须可感知。语音播报走主进程常驻音频窗口，
    // 与主窗口是否聚焦/可见无关；announce 内部有 800ms 去重，重复注册失败不会刷屏
    try {
      const p = a11y.announce({
        text: hooked
          ? `热键 ${accelerator} 已被其他程序独占，已自动改用底层监听，按 ${accelerator} 照样能朗读。若想彻底接管，退出占用它的程序即可，我会自动切换回来。`
          : `热键 ${accelerator} 被其他程序占用，朗读暂不可用。常见原因是其他朗读软件正在运行，请退出后会自动重试，或在设置中更换热键。`,
        priority: 'high',
      });
      if (p && typeof p.then === 'function') {
        p.then((r) => {
          console.log(`[hotkey] conflict announce ok=${!!(r && r.ok)} skipped=${(r && r.skipped) || '-'}`);
        }).catch((e) => {
          console.warn('[hotkey] conflict announce failed:', e && e.message);
        });
      }
    } catch (e) {
      /* 播报通道异常不影响其余反馈 */
    }
    try {
      if (tray && !tray.isDestroyed()) {
        tray.displayBalloon({
          title: hooked ? '已接管热键' : '热键被占用',
          content: hooked
            ? `${accelerator} 被其他程序独占，已自动改用底层监听，照常按 ${accelerator} 即可朗读。`
            : `${accelerator} 被其他程序占用，朗读热键暂不可用。请在设置中更换热键后重试。`,
        });
      }
    } catch (e) {
      /* 托盘不可用时忽略 */
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('hotkey:conflict', { accelerator, hooked });
      } catch (e) {
        /* 渲染进程未就绪时忽略 */
      }
    }
  }

  function buildMenu() {
    const hk = getHotkey() || DEFAULT_HOTKEY;
    const items = [
      { label: `朗读选中文字（${hk}）`, click: () => triggerSelectionRead() },
      {
        label: '朗读剪贴板',
        click: () => {
          const w = resolveWindow();
          if (w) w.webContents.send('hotkey:read-clipboard');
        },
      },
    ];
    if (typeof toggleFloatBall === 'function') {
      items.push({ label: '显示/隐藏悬浮球', click: () => toggleFloatBall() });
    }
    // v2.3：屏幕缩放子菜单（zoomController 单例存在才显示；Ctrl+Alt+0 退出等热键仅热键模式注册）
    const zoomCtl = zoomController.getZoomController();
    if (zoomCtl) {
      items.push({
        label: '屏幕缩放',
        submenu: [
          { label: '放大一档 (Ctrl+Alt+=)', click: () => zoomCtl.nudge(true) },
          { label: '缩小一档 (Ctrl+Alt+-)', click: () => zoomCtl.nudge(false) },
          { label: '退出缩放 (Ctrl+Alt+0)', click: () => zoomCtl.reset() },
          { type: 'separator' },
          { label: zoomCtl.state.paused ? '恢复缩放' : '暂停缩放', click: () => zoomCtl.togglePause() },
        ],
      });
    }
    items.push(
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => showMainWindow(),
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    );
    return Menu.buildFromTemplate(items);
  }

  try {
    tray = new Tray(trayIcon());
    tray.setContextMenu(buildMenu());
    tray.setToolTip(`明读 · 选中文字按 ${getHotkey() || DEFAULT_HOTKEY} 朗读`);
    tray.on('click', () => {
      // 左键单击 = 恢复主窗口。窗口被 hide 到托盘时，这是用户唯一的「找回来」入口，
      // 所以绝对不能静默失败（见 showMainWindow 的兜底播报）。
      showMainWindow();
    });
  } catch (e) {
    console.error('[hotkey] tray init failed:', e && e.message);
    tray = null;
  }

  /** 实际执行一次注册尝试（不触发冲突播报/自动重试），返回是否成功 */
  const tryRegister = () => {
    const hk = getHotkey() || DEFAULT_HOTKEY;
    // v2.3.1：只精准注销自己上一个朗读热键。不再用 globalShortcut.unregisterAll()——
    // 那会把 zoomController 的 Ctrl+Alt+=/-/0 缩放热键一起清掉，旧代码靠事后补注册兜底，
    // 一旦补注册失败（或补注册时机落后于一次按键）缩放热键就静默消失，设计很脆。
    // 用户若自选热键撞上缩放热键，只会是我们注册失败并播报冲突，缩放键不受损。
    if (registeredAccel) {
      try {
        if (globalShortcut.isRegistered(registeredAccel)) globalShortcut.unregister(registeredAccel);
      } catch (e) {
        /* 注销失败不阻塞重注册 */
      }
      registeredAccel = '';
    }
    try {
      registered = !!globalShortcut.register(hk, () => {
        triggerSelectionRead();
      });
    } catch (e) {
      registered = false;
      console.error(`[hotkey] register threw accelerator=${hk} err=${e && e.message}`);
    }
    if (registered) registeredAccel = hk;
    console.log(`[hotkey] register accelerator=${hk} ok=${registered}`);
    return registered;
  };

  /** 托盘菜单/提示语随实际热键刷新 */
  function refreshTrayLabel() {
    const hk = getHotkey() || DEFAULT_HOTKEY;
    try {
      if (tray && !tray.isDestroyed()) {
        tray.setContextMenu(buildMenu());
        tray.setToolTip(`明读 · 选中文字按 ${hk} 朗读`);
      }
    } catch (e) {
      /* noop */
    }
  }

  /** 重试恢复成功时播报一次（与冲突播报形成闭环；启动即成功不播，避免噪音） */
  function announceReady() {
    try {
      const hk = getHotkey() || DEFAULT_HOTKEY;
      const p = a11y.announce({
        text: `朗读热键 ${hk} 已就绪，选中文字后按 ${hk} 即可朗读。`,
        priority: 'high',
      });
      if (p && typeof p.then === 'function') p.catch(() => {});
    } catch (e) {
      /* 播报通道异常不影响注册 */
    }
  }

  /** v2.4.0：热键被占用时的有界自动重试。典型场景：旧版「明读」常驻占 F1，用户退出后
   *  新版几秒内自动接管并语音告知。RETRY_MAX 次（约 10 分钟）后停止，不无限循环；
   *  之后用户可在设置里更换热键，或重启应用再次重试。 */
  const RETRY_INTERVAL_MS = 5000;
  const RETRY_MAX = 120;
  let retryTimer = null;
  let retryCount = 0;
  let conflictActive = false;
  /** v2.4.0：低级键盘钩子是否已接管（true 时 registered=false，但功能实际可用） */
  let hookActive = false;
  const stopRetry = () => {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
    retryCount = 0;
  };
  const startRetry = () => {
    if (retryTimer || disposed) return;
    retryCount = 0;
    retryTimer = setInterval(() => {
      retryCount += 1;
      if (disposed || retryCount > RETRY_MAX) {
        stopRetry();
        if (!disposed) console.log('[hotkey] conflict auto-retry gave up (~10min)');
        return;
      }
      register();
    }, RETRY_INTERVAL_MS);
  };

  /**
   * 官方 API 抢不到热键时，尝试用低级键盘钩子旁路捕获。
   * 只对 HOOKABLE_ACCELS 里的单键生效（当前只有 F1）。
   * @param {string} hk
   * @returns {boolean} 钩子是否已接管
   */
  function tryHookFallback(hk) {
    const vk = HOOKABLE_ACCELS[hk];
    if (vk == null) return false;
    if (hookActive) return true;
    const ok = keyboardHook.start(() => {
      // 与 globalShortcut 回调走同一入口：反馈音 → 防重入 → 抓选区
      triggerSelectionRead();
    }, { vkCode: vk });
    if (ok) {
      hookActive = true;
      console.log(`[hotkey] low-level hook took over accelerator=${hk} vk=${vk}`);
    } else {
      console.warn(`[hotkey] low-level hook unavailable: ${keyboardHook.currentError()}`);
    }
    return ok;
  }

  /** 注册（或重注册）全局热键；返回功能是否可用（官方 API 或钩子任一生效）。
   *  失败：播报冲突 + 启动自动重试；重试恢复：切回官方 API + 播报就绪 */
  const register = () => {
    const hk = getHotkey() || DEFAULT_HOTKEY;
    const ok = tryRegister();
    if (!ok) {
      const hooked = tryHookFallback(hk);
      if (!conflictActive) reportConflict(hk, { hooked }); // 仅状态变化时播报，重试期间不刷屏
      conflictActive = true;
      // 钩子接管后仍然继续重试：外部程序一放手就切回官方 API（比钩子更可靠、开销更低）
      startRetry();
    } else {
      const recovered = conflictActive;
      conflictActive = false;
      stopRetry();
      // 官方 API 已接管：必须卸钩子，否则一次按键会同时命中两条路径 → 朗读两遍
      if (hookActive) {
        keyboardHook.stop();
        hookActive = false;
        console.log('[hotkey] low-level hook released (globalShortcut took over)');
      }
      if (recovered) announceReady();
    }
    refreshTrayLabel();
    return ok || hookActive;
  };
  register();

  /** 首次「关窗到托盘」时说明一次。
   *  用系统气泡而不是语音播报：此时用户可能正在听朗读，语音会打断；气泡不抢音频。 */
  function showTrayHint() {
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.displayBalloon({
        title: '明读 仍在后台运行',
        content: `按 ${getHotkey() || DEFAULT_HOTKEY} 照样能朗读。要重新打开窗口，单击这个图标；要彻底退出，右键图标选「退出」。`,
      });
    } catch (e) {
      console.warn('[hotkey] tray balloon failed:', e && e.message);
    }
  }

  return {
    tray,
    reregister: register,
    showMainWindow,
    showTrayHint,
    isRegistered: () => registered || hookActive,
    /** 诊断用：钩子是否支持/激活/命中统计 */
    hookState: () => keyboardHook.getState(),
    dispose: () => {
      disposed = true;
      stopRetry();
      if (hookActive) {
        try {
          keyboardHook.stop();
        } catch (e) {
          /* noop */
        }
        hookActive = false;
      }
      try {
        if (tray) tray.destroy();
      } catch (e) {
        /* noop */
      }
      // v2.3.1：同样只注销自己的热键，不用 unregisterAll()（退出前 zoomController.stop()
      // 已自行注销缩放热键；即便顺序变化，也不该由我们代劳清空全局）
      if (registeredAccel) {
        try {
          if (globalShortcut.isRegistered(registeredAccel)) globalShortcut.unregister(registeredAccel);
        } catch (e) {
          /* noop */
        }
        registeredAccel = '';
      }
      registered = false;
    },
  };
}

module.exports = { registerHotkeyTray };
