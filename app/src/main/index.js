// 主进程入口：窗口生命周期、TTS 桥接预热、IPC 注册、剪贴板监视、热键/托盘。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, nativeImage, Menu, ipcMain } = require('electron');

// 固定 ASCII 的产品目录名：避免中文路径影响 NVSA 语音引擎与注册表路径
const APP_DIR_NAME = 'LangduNvNeo';
// v2.4.0：调试版与安装版必须用**不同的** userData 目录。
// 事故复盘：两者共用 %APPDATA%\LangduNvNeo 时，
//   · 调试探针改的主题/字号/热键会立刻串到用户正在用的安装版；
//   · 两个进程同时跑会抢同一个朗读热键、出现两个托盘图标和两个悬浮球；
//   · 用户看到「叉掉窗口后托盘点不开」时，无法判断是自身 bug 还是调试版干扰。
// 打包后（app.isPackaged=true）仍用原目录，老用户设置不迁移、不受影响。
const USER_DATA_DIR = app.isPackaged ? APP_DIR_NAME : `${APP_DIR_NAME}-dev`;
app.setName(APP_DIR_NAME);
try {
  const asciiUserData =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), USER_DATA_DIR)
      : path.join(os.homedir(), '.config', USER_DATA_DIR);
  fs.mkdirSync(asciiUserData, { recursive: true });
  app.setPath('userData', asciiUserData);
} catch (e) {
  /* 保留默认路径 */
}

const { getBridge } = require('./ttsBridge');
const { registerIpc } = require('./ipc');
const { startClipboardMonitor } = require('./clipboardMonitor');
const { registerHotkeyTray } = require('./hotkeyTray');
// v2.4.0 延迟优化：常驻 PowerShell 抓取通道（划词抓取 771ms → 稳态 33ms 的关键）
const { initCaptureHost } = require('./platform/captureHost');
const settingsStore = require('./settingsStore');
const floatBall = require('./floatBall');
const { warmupVoiceSetup } = require('./voiceSetup');
const { createZoomController } = require('./zoomController');

const ICON_PATH = (() => {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'icon.png'));
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'icon.png'));
  return candidates.find((p) => fs.existsSync(p)) || '';
})();

let mainWindow = null;
let hotkeyRef = null;
let ipcApi = null;

// v2.2：settings.json（settingsStore，启动时已做旧热键迁移）是系统设置权威源
// v2.4.0：默认热键 F1（用户明确要求，Ctrl+Alt+R 留备选）；复制即读默认开（基线 P1-9）
const initialSettings = settingsStore.getSettings();
const state = {
  hotkey: initialSettings.hotkey || 'F1',
  hotkeyOk: false,
  playback: { isPlaying: false, buffering: false, hasAudio: false },
  clipboardAuto: !!initialSettings.clipboardAuto,
  stopClipboard: null,
  floatBallRef: null,
  // v2.4.0：关窗 = 收到托盘（hide），只有真正退出时才放行 close。
  // 事故：主窗口被叉掉后 mainWindow 置 null，而托盘点击/悬浮球/热键全依赖
  // win.webContents.send —— 三者同时「静默失效」（托盘点不开、球图标不动、热键只滴一声）。
  quitting: false,
  trayHintShown: false,
};

function getMainWindow() {
  return mainWindow;
}

/** 取主窗口；真被销毁时重建。托盘点击、「显示主窗口」、悬浮球唤醒都走这里。
 *  正常路径下窗口只是 hide（close 被拦截），这里只是防御性兜底。 */
function ensureWindow() {
  const w = getMainWindow();
  if (w && !w.isDestroyed()) return w;
  return createWindow();
}

// ---------------------------------------------------------------------------
// WFIX2 启动显隐：历史 bug —— backgroundColor 写死深色 '#0f1115' 且窗口创建即显示，
// 用户先看到深色底，渲染层浅色主题生效后变白，观感是「黑屏 → 白屏」闪烁。
// 修法：① show:false，ready-to-show 之后再 show（首帧已绘制，无「底色 → 内容」跳变）；
//       ② 底色与 src/renderer/theme.js 的 background.default 对齐；
//       ③ 5s 兜底强制 show（加载卡死时不能让用户以为程序没启动）。
// 说明：themeMode 存在渲染层 localStorage，主进程读不到；settingsStore 里只有 theme，
//       读不到就按浅色（渲染层默认主题 light）。
// ---------------------------------------------------------------------------
const STARTUP_BG = { light: '#f5f6fa', dark: '#0c0f16', hc: '#000000' };
const SHOW_FALLBACK_MS = 5000;
let bootT0 = 0;

function resolveStartupBackground() {
  try {
    const s = settingsStore.getSettings();
    const mode = s && (s.themeMode || s.theme);
    if (mode === 'dark') return STARTUP_BG.dark;
    if (mode === 'hc') return STARTUP_BG.hc;
  } catch (e) {
    /* 读不到按浅色 */
  }
  return STARTUP_BG.light;
}

// ---------------------------------------------------------------------------
// W-WIN1 窗口融合：去原生标题栏 + 去内置应用菜单
//   用户诉求：① 最上面一层颜色要和 UI 融为一体；② 第二行那串英文菜单（File/Edit/…）
//   不该出现；③ 三个窗口控制键放大。
//   做法：frame:false 让窗口没有系统标题栏（系统灰白条消失），整条顶栏由渲染层 TopBar 承担；
//   Menu.setApplicationMenu(null) 干掉 Electron 默认英文菜单（本应用所有功能都在界面内，
//   不需要菜单入口）。titleBarStyle 刻意不设 —— 那是 macOS 的 traffic light 语义。
//   thickFrame 保持默认 true：Windows 下保住 WS_THICKFRAME（边缘拖拽缩放 + Aero Snap），
//   frame:false 只去掉标题栏绘制，两者不冲突。
// ---------------------------------------------------------------------------
function getWindowOptions() {
  return {
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    thickFrame: true,
    backgroundColor: resolveStartupBackground(),
    show: false,
    title: '朗读女 Neo',
    icon: ICON_PATH ? nativeImage.createFromPath(ICON_PATH) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
}

/** 去掉 Electron 默认应用菜单（英文 File/Edit/View/Window/Help 那一行）。
 *  开发期快捷方式不重建菜单，走 before-input-event（见 attachDevShortcuts）。 */
function installAppMenu() {
  Menu.setApplicationMenu(null);
}

/** 开发期键盘快捷方式：F12 开关 DevTools、Ctrl+R 重载（仅未打包）。
 *  只处理这两个；其余编辑快捷键（Ctrl+C/V/X/A/Z）由 Chromium 内建实现，不依赖菜单。 */
function attachDevShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      event.preventDefault();
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
      return;
    }
    if (!app.isPackaged && input.control && !input.alt && !input.meta && (input.key === 'r' || input.key === 'R')) {
      event.preventDefault();
      win.webContents.reload();
    }
  });
}

// ---------------------------------------------------------------------------
// 窗口控制 IPC（W-WIN1）
//   目标窗口一律用 BrowserWindow.fromWebContents(e.sender) 定位：悬浮球窗口也复用同一个
//   preload，用全局 mainWindow 会把控制指令打到主窗口上。
//   close 只 win.close()，不 app.quit() —— 托盘常驻/退出流程由既有逻辑接管。
// ---------------------------------------------------------------------------
function windowFromEvent(e) {
  if (!e || !e.sender) return null;
  const win = BrowserWindow.fromWebContents(e.sender);
  return win && !win.isDestroyed() ? win : null;
}

const windowControlHandlers = {
  minimize(e) {
    const win = windowFromEvent(e);
    if (!win) return false;
    win.minimize();
    return true;
  },
  toggleMaximize(e) {
    const win = windowFromEvent(e);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return true;
  },
  close(e) {
    const win = windowFromEvent(e);
    if (!win) return false;
    win.close();
    return true;
  },
  isMaximized(e) {
    const win = windowFromEvent(e);
    return !!(win && win.isMaximized());
  },
};

let windowIpcRegistered = false;
/** 幂等注册：只注册一次（ipcMain.handle 重复注册会抛错；探针也会调用本函数）。 */
function registerWindowControlIpc() {
  if (windowIpcRegistered) return false;
  windowIpcRegistered = true;
  ipcMain.handle('window:minimize', windowControlHandlers.minimize);
  ipcMain.handle('window:toggle-maximize', windowControlHandlers.toggleMaximize);
  ipcMain.handle('window:close', windowControlHandlers.close);
  ipcMain.handle('window:is-maximized', windowControlHandlers.isMaximized);
  return true;
}

/** 最大化状态双向同步：Win+↑ / 双击拖拽区 / Aero Snap 都不会走渲染层按钮，
 *  必须由主进程的 maximize / unmaximize 事件反向推送。 */
function attachMaximizeSync(win) {
  const push = () => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send('window:maximized-changed', win.isMaximized());
    } catch (e) {
      /* 渲染层尚未就绪时忽略 */
    }
  };
  win.on('maximize', push);
  win.on('unmaximize', push);
  return push;
}

function createWindow() {
  const startupBg = resolveStartupBackground();
  const win = new BrowserWindow(getWindowOptions());
  mainWindow = win;

  attachDevShortcuts(win);
  attachMaximizeSync(win);

  // WFIX2：先隐藏后显示。ready-to-show 表示首帧已绘制，此时 show() 用户不会看到底色闪变；
  // 5s 内没等到（加载失败/卡住）也强制显示，否则用户会以为程序没启动。
  let revealed = false;
  let revealTimer = null;
  const reveal = (reason) => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    win.show();
    console.log(`[boot] window shown (${reason}) +${bootT0 ? Date.now() - bootT0 : 0}ms bg=${startupBg}`);
  };
  revealTimer = setTimeout(() => reveal('timeout'), SHOW_FALLBACK_MS);
  if (typeof revealTimer.unref === 'function') revealTimer.unref();
  win.once('ready-to-show', () => reveal('ready-to-show'));

  // v2.4.0：提前显示骨架，把「双击后毫无反馈」的 3.4 秒压到约 0.4 秒。
  //
  // 试过两条更"精确"的路，都不行，记在这里免得后来人重踩：
  //   · dom-ready → Vite 的入口是 `<script type="module">`，按 defer 语义在 DOMContentLoaded
  //     **之前**执行完，所以 dom-ready 要等整个 React bundle 跑完，实测与 ready-to-show 同为 3390ms；
  //   · 骨架里 console.log('__LDN_SKELETON_READY__') → Electron 的 console-message 在页面
  //     加载完成前不会派发（实测同样 3390ms 才收到），拿不到"早"这个性质。
  //
  // 最终用固定时延：did-start-loading 是导航开始（最早的可观测点），+260ms 后 HTML 基本已解析
  // 并画出骨架。即使这台机器偏慢、260ms 时骨架还没上屏，用户看到的也只是与骨架同色的空白
  // （窗口 backgroundColor 与骨架背景都跟随主题，见 resolveStartupBackground 与 index.html），
  // 不会出现底色跳变。ready-to-show 与 5s 超时仍作为兜底。
  win.webContents.once('did-start-loading', () => {
    setTimeout(() => reveal('early'), 140);
  });

  // 渲染层 hydrate：主窗口首次加载完成后推送一次系统设置；之后每次变化由 ipc.js 广播
  win.webContents.once('did-finish-load', () => {
    try {
      if (ipcApi && typeof ipcApi.broadcastSystemSettings === 'function') {
        ipcApi.broadcastSystemSettings();
      }
    } catch (e) {
      /* noop */
    }
  });

  // QA 辅助：--capture=<png 路径> 载入构建产物并截图后退出（不影响正常启动）
  const captureArg = process.argv.find((a) => a.startsWith('--capture='));
  const capturePath = captureArg ? captureArg.slice('--capture='.length) : '';

  if (capturePath) {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
    win.webContents.once('did-finish-load', () => {
      // QA 辅助：--playcapture=<png> 先触发真实播放，等若干毫秒后在「播放中」截图再退出
      const playArg = process.argv.find((a) => a.startsWith('--playcapture='));
      if (playArg) {
        const playPath = playArg.slice('--playcapture='.length);
        const waitMs = Number((process.argv.find((a) => a.startsWith('--playwait=')) || '--playwait=4000').slice('--playwait='.length)) || 4000;
        setTimeout(async () => {
          try {
            await win.webContents.executeJavaScript(
              `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'')==='播放'); if(b){b.click();return true;} return false; })()`
            );
            console.log('[playcapture] play triggered');
          } catch (e) {
            console.error('[playcapture] trigger failed', e.message);
          }
        }, 1200);
        setTimeout(async () => {
          try {
            if (!win.isVisible()) reveal('playcapture-before-shot');
            const img = await win.webContents.capturePage();
            fs.writeFileSync(playPath, img.toPNG());
            console.log('[playcapture] saved', playPath);
          } catch (e) {
            console.error('[playcapture] failed', e.message);
          }
          app.exit(0);
        }, 1200 + waitMs);
        return; // 播放捕获模式下不走常规 capture 流程
      }
      // v2.4.0：--capture-delay=<ms> 延迟截图。did-finish-load 时 VoiceDeployGate 等组件的
      // IPC 状态还没回来，立即截图会拍成「未加载」的初始帧（每次字节数都一样）。
      const delayArg = process.argv.find((a) => a.startsWith('--capture-delay='));
      const capDelay = delayArg ? Math.max(0, Number(delayArg.split('=')[1]) || 0) : 0;
      // v2.4.0：--capture-scale=<1|1.25|1.5|2> 在截图前切到指定字号档位，
      // 用于验证无障碍红线（2.0x 下不破版）。档位真源是 CSS 变量 --ldn-scale + html font-size。
      const scaleArg = process.argv.find((a) => a.startsWith('--capture-scale='));
      const capScale = scaleArg ? Number(scaleArg.split('=')[1]) || 1 : 1;
      // v2.4.0：--capture-theme=light|dark|hc 截图前切到指定主题。
      // 主题存在渲染层 localStorage，探针点过主题按钮后会被记住，导致后续截图颜色不可预期
      // （曾出现「同一命令一次浅色一次深色」）。这里统一收敛：按需点主题按钮循环到目标档。
      const themeArg = process.argv.find((a) => a.startsWith('--capture-theme='));
      const capTheme = themeArg ? themeArg.split('=')[1] : '';
      const settleTheme = async () => {
        if (!capTheme) return;
        for (let i = 0; i < 4; i += 1) {
          // 按钮 aria-label 表示「点了会切到什么」，所以「当前是 light」⟺ label 为「切换深色主题」
          const label = await win.webContents.executeJavaScript(
            `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('切换')); return b ? b.getAttribute('aria-label') : ''; })()`
          );
          const cur =
            label === '切换深色主题' ? 'light' : label === '切换高对比度主题' ? 'dark' : label === '切换浅色主题' ? 'hc' : '';
          if (!cur || cur === capTheme) return;
          await win.webContents.executeJavaScript(
            `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('切换')); if (b) b.click(); return true; })()`
          );
          await new Promise((r) => setTimeout(r, 400));
        }
      };
      setTimeout(async () => {
        try {
          // WFIX2：窗口在 ready-to-show 前是隐藏的，隐藏窗口截不出真实帧 → 截图前先确保已显示
          if (!win.isVisible()) reveal('capture-before-shot');
          if (capTheme) {
            await settleTheme();
            await new Promise((r) => setTimeout(r, 500));
          }
          if (capScale !== 1) {
            await win.webContents.executeJavaScript(
              `document.documentElement.style.fontSize='${16 * capScale}px';` +
                `document.documentElement.style.setProperty('--ldn-scale','${capScale}');`
            );
            await new Promise((r) => setTimeout(r, 700));
          }
          const img = await win.webContents.capturePage();
          fs.mkdirSync(path.dirname(capturePath), { recursive: true });
          fs.writeFileSync(capturePath, img.toPNG());
          console.log('[capture] saved', capturePath);
        } catch (e) {
          console.error('[capture] failed', e.message);
        }
        const second = process.argv.find((a) => a.startsWith('--capture2='));
        if (second) {
          const p2 = second.slice('--capture2='.length);
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          setTimeout(async () => {
            try {
              const img2 = await win.webContents.capturePage();
              fs.writeFileSync(p2, img2.toPNG());
              console.log('[capture] saved', p2);
            } catch (e) {
              console.error('[capture2] failed', e.message);
            }
            app.quit();
          }, 900);
          return;
        }
        setTimeout(() => app.quit(), 300);
      }, 3500 + capDelay);
    });
    return win;
  }

  if (!app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  // v2.4.0：关窗 = 收到托盘（hide），**不再销毁窗口**。
  //
  // 为什么必须 hide 而不是 close：
  //   托盘点击、悬浮球指令、热键朗读结果，全部经由 win.webContents.send 投递。
  //   窗口一旦销毁 → mainWindow=null → 三者全部静默失效：
  //     · 点托盘没反应（菜单里 `if (w) w.show()` 不成立）；
  //     · 悬浮球点不动、图标卡在最后一次状态（渲染层消失后再没人上报 isPlaying=false）；
  //     · 按热键能听到提示音，但抓到选区后 `if (!win) return` 直接丢弃，且不说明原因。
  //   hide 之后 webContents 仍然存活：托盘能 show 回来，热键结果照常送达，状态继续同步。
  //   代价是「叉掉不等于退出」，所以第一次隐藏时用托盘气泡说明（只提示一次）。
  win.on('close', (e) => {
    if (state.quitting) return; // 真正退出（托盘「退出」/ app.quit()）时放行
    e.preventDefault();
    if (win.isDestroyed()) return;
    win.hide();
    if (!state.trayHintShown) {
      state.trayHintShown = true;
      try {
        if (hotkeyRef && typeof hotkeyRef.showTrayHint === 'function') hotkeyRef.showTrayHint();
      } catch (err) {
        /* 提示失败不影响隐藏本身 */
      }
    }
  });

  win.on('closed', () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    mainWindow = null;
    // 防御：万一窗口真被销毁（崩溃/外部强关），把播放快照复位并同步给悬浮球，
    // 否则球会永远停在「播放中」的暂停图标上。
    state.playback = { isPlaying: false, buffering: false, hasAudio: false };
    try {
      if (state.floatBallRef && typeof state.floatBallRef.broadcastState === 'function') {
        state.floatBallRef.broadcastState();
      }
    } catch (e) {
      /* 球已销毁就算了 */
    }
  });
  return win;
}

function bootstrap() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
    }
  });

  app.whenReady().then(() => {
    bootT0 = Date.now(); // WFIX2：启动时间线基准（窗口显示日志以此为零点）
    // W-WIN1：必须在 createWindow 之前清掉默认菜单，否则首帧会先带出英文菜单条
    installAppMenu();
    registerWindowControlIpc();
    // v2.4.0 启动提速：getBridge() 会构造 TtsBridge 并 init（读设置、装配引擎），
    // 实测占掉 whenReady 到 did-start-loading 之间相当一段时间。它对「窗口能否出现」不是必需的
    // （渲染层的语音请求走 IPC → 那里再 lazy 取单例），所以挪到 createWindow 之后再初始化，
    // 先把窗口和骨架推上屏。异常仍然只是容错，不阻塞启动。
    createWindow();
    try {
      getBridge();
    } catch (e) {
      /* 容错，运行时再报 */
    }
    ipcApi = registerIpc(getMainWindow, state);
    // v2.4.0 离线语音：启动时后台跑一次检测，否则 voiceDeploy 状态一直停在 IDLE，
    // VoiceDeployGate 会对着「已经装好」的用户显示「未安装」引导卡片（本机实测踩到）。
    // 不 await：检测要枚举系统语音（新进程，几百毫秒），不能挡首屏。
    try {
      // eslint-disable-next-line global-require
      const voiceDeploy = require('./voiceDeploy').getVoiceDeploy();
      setImmediate(() => {
        voiceDeploy.detect({ announce: false }).catch((e) => {
          console.warn('[voiceDeploy] startup detect failed:', e && e.message);
        });
      });
    } catch (e) {
      /* 容错：离线语音引导不可用不影响朗读 */
    }
    // v2.3 屏幕缩放（LensZoom 集成）：无论 zoomEnabled 初始值如何都 start()——
    // start() 只安装滚轮钩子/热键并跑渲染循环，不会主动激活画面；激活只发生在用户触发时
    // （onWheel / Ctrl+Alt+= / nudge 均校验 zoomEnabled）。初始 zoomEnabled=false 的用户
    // 保持关闭态，之后在设置里打开由 applySettingsPatch 处理；关闭时同样由它 deactivate。
    const zoomCtl = createZoomController({
      getSettings: settingsStore.getSettings,
      saveSettings: settingsStore.saveSettings,
      getMainWindow,
    });
    zoomCtl.start();
    state.zoomRef = zoomCtl;
    hotkeyRef = registerHotkeyTray(
      getMainWindow,
      () => state.hotkey,
      () => floatBall.toggle(),
      ensureWindow // 托盘点击/显示主窗口时兜底重建，避免窗口销毁后永久点不开
    );
    state.hotkeyRef = hotkeyRef;
    state.hotkeyOk = !!(hotkeyRef && typeof hotkeyRef.isRegistered === 'function' && hotkeyRef.isRegistered());
    // v2.4.0：预热抓取宿主。冷启动实测 0.9~1.1s；不预热则首次按 F1 要吃「宿主启动 + 超时」
    // ≈1.7s，比旧的一次性 powershell 还慢 —— 必须在窗口显示后立刻拉起，但不 await（不挡首屏）。
    // 失败不影响功能：captureSelection 会自动回退一次性进程（约 0.7s），只是慢一点。
    initCaptureHost()
      .then((w) => console.log(`[capture] host warm ok=${w.ok} warmMs=${w.warmMs} ${w.error || ''}`))
      .catch((e) => console.warn('[capture] host warm failed:', e && e.message));
    // 悬浮球：按 floatBallEnabled 初始化（v2.2 默认开）
    floatBall.initFloatBall(
      getMainWindow,
      () => ({
        playback: state.playback,
        hotkey: state.hotkey,
        hotkeyOk: state.hotkeyOk,
      }),
      ensureWindow
    );
    state.floatBallRef = floatBall;
    // 剪贴板「复制即读」：clipboardAuto===true 时启动监视（v2.3.1 默认开，基线 P1-9 低视力刚需；
    // 监视内部带 1.5s 尾沿节流 + 2 万字长度上限，用户连复制多段不会疯狂朗读）
    if (state.clipboardAuto) {
      state.stopClipboard = startClipboardMonitor(getMainWindow, () => state.clipboardAuto);
    }

    try {
      warmupVoiceSetup();
    } catch (e) {
      /* 容错，运行时再报 */
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // 放行 close 拦截：只有从这里开始的关闭才是「真退出」
    state.quitting = true;
    if (state.stopClipboard) {
      state.stopClipboard();
      state.stopClipboard = null;
    }
    if (state.zoomRef && typeof state.zoomRef.stop === 'function') {
      state.zoomRef.stop(); // v2.3：停渲染循环 + 拆钩子/热键 + 销毁覆盖层
      state.zoomRef = null;
    }
    if (hotkeyRef && typeof hotkeyRef.dispose === 'function') hotkeyRef.dispose();
    floatBall.dispose();
  });
}

bootstrap();

// W-WIN1：导出给探针（scripts/tmp_probe_WWIN1_frame.js）验证窗口参数/菜单/IPC 行为。
// 注意：不能用 require.main === module 做「是否启动」的判断 —— Electron 用 Module._load
// 载入主入口，require.main 为 undefined、module.parent 也不为 null（实测 electron 32），
// 所以这里照常 bootstrap；探针按真实启动路径加载本文件，再读导出函数断言。
module.exports = {
  getWindowOptions,
  installAppMenu,
  attachDevShortcuts,
  attachMaximizeSync,
  registerWindowControlIpc,
  windowControlHandlers,
  getMainWindow,
};
