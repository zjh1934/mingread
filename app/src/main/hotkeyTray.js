// 全局热键 + 系统托盘。默认热键 Ctrl+Alt+R（v2.3.1 起，基线 P2-11：F1 是 Windows 通用
// 「帮助」键，语义冲突，仅保留为设置里的可选预设）：在任意位置选中文字后按热键直接朗读。
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
// γ 的 a11yFeedback：只读使用其导出（announce / cue），不修改其实现
const a11y = require('./a11yFeedback');
// 抓选区会短暂改写剪贴板：告知剪贴板监视器静默，避免被误判成「用户又复制了一次」
const { suppressAutoRead } = require('./clipboardMonitor');

/** v2.3.1 默认热键（基线 P2-11）。F1 仅作为可选预设保留在设置界面 */
const DEFAULT_HOTKEY = 'Ctrl+Alt+R';

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
function registerHotkeyTray(getWindow, getHotkey, toggleFloatBall) {
  let tray = null;
  let busy = false;
  let registered = false;
  /** 本模块自己注册成功的朗读热键；只注销它，绝不动别人（缩放）的热键 */
  let registeredAccel = '';

  /** 热键按下的即时反馈（基线指标 E）。第一行调用，不 await，不阻塞抓选区 */
  function firePressCue(t0) {
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
      const win = getWindow();
      // 抓选区期间（发 Ctrl+C → 读完还原）抑制复制即读，否则监视器会把选区内容和
      // 还原后的旧剪贴板当成连续两次复制，造成重复朗读（含旧剪贴板误读）
      suppressAutoRead(1500);
      const r = await readSelection();
      if (!win || win.isDestroyed()) return;
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

  /** 注册失败：语音播报（主进程侧，窗口未聚焦也能听到）+ 托盘气泡 + 通知主窗口 */
  function reportConflict(accelerator) {
    // 基线 P1-7 / 指标 G：状态变化必须可感知。语音播报走主进程常驻音频窗口，
    // 与主窗口是否聚焦/可见无关；announce 内部有 800ms 去重，重复注册失败不会刷屏
    try {
      const p = a11y.announce({
        text: `热键 ${accelerator} 被其他程序占用，朗读暂不可用，请在设置中更换热键。`,
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
          title: '热键被占用',
          content: `${accelerator} 被其他程序占用，朗读热键暂不可用。请在设置中更换热键后重试。`,
        });
      }
    } catch (e) {
      /* 托盘不可用时忽略 */
    }
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('hotkey:conflict', { accelerator });
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
          const w = getWindow();
          if (w && !w.isDestroyed()) w.webContents.send('hotkey:read-clipboard');
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
        click: () => {
          const w = getWindow();
          if (w) {
            w.show();
            w.focus();
          }
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    );
    return Menu.buildFromTemplate(items);
  }

  try {
    tray = new Tray(trayIcon());
    tray.setContextMenu(buildMenu());
    tray.setToolTip(`朗读女 Neo · 选中文字按 ${getHotkey() || DEFAULT_HOTKEY} 朗读`);
    tray.on('click', () => {
      const w = getWindow();
      if (w) {
        w.show();
        w.focus();
      }
    });
  } catch (e) {
    console.error('[hotkey] tray init failed:', e && e.message);
    tray = null;
  }

  /** 注册（或重注册）全局热键；返回是否成功 */
  const register = () => {
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
    if (!registered) reportConflict(hk);
    // 菜单热键标签 / 提示语随实际热键刷新
    try {
      if (tray && !tray.isDestroyed()) {
        tray.setContextMenu(buildMenu());
        tray.setToolTip(`朗读女 Neo · 选中文字按 ${hk} 朗读`);
      }
    } catch (e) {
      /* noop */
    }
    return registered;
  };
  register();

  return {
    tray,
    reregister: register,
    isRegistered: () => registered,
    dispose: () => {
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
