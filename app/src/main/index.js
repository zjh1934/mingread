// 主进程入口：窗口生命周期、TTS 桥接预热、IPC 注册、剪贴板监视、热键/托盘。
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, nativeImage } = require('electron');

// 固定 ASCII 的产品目录名：避免中文路径影响 NVSA 语音引擎与注册表路径
const APP_DIR_NAME = 'LangduNvNeo';
app.setName(APP_DIR_NAME);
try {
  const asciiUserData =
    process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME)
      : path.join(os.homedir(), '.config', APP_DIR_NAME);
  fs.mkdirSync(asciiUserData, { recursive: true });
  app.setPath('userData', asciiUserData);
} catch (e) {
  /* 保留默认路径 */
}

const { getBridge } = require('./ttsBridge');
const { registerIpc } = require('./ipc');
const { startClipboardMonitor } = require('./clipboardMonitor');
const { registerHotkeyTray } = require('./hotkeyTray');
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
// v2.3.1：默认热键 Ctrl+Alt+R（基线 P2-11，F1 仅留可选预设）；复制即读默认开（基线 P1-9）
const initialSettings = settingsStore.getSettings();
const state = {
  hotkey: initialSettings.hotkey || 'Ctrl+Alt+R',
  hotkeyOk: false,
  playback: { isPlaying: false, buffering: false, hasAudio: false },
  clipboardAuto: !!initialSettings.clipboardAuto,
  stopClipboard: null,
  floatBallRef: null,
};

function getMainWindow() {
  return mainWindow;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: '朗读女 Neo',
    icon: ICON_PATH ? nativeImage.createFromPath(ICON_PATH) : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;

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
      setTimeout(async () => {
        try {
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
      }, 3500);
    });
    return win;
  }

  if (!app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
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
    try {
      getBridge();
    } catch (e) {
      /* 容错，运行时再报 */
    }
    createWindow();
    ipcApi = registerIpc(getMainWindow, state);
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
    hotkeyRef = registerHotkeyTray(getMainWindow, () => state.hotkey, () => floatBall.toggle());
    state.hotkeyRef = hotkeyRef;
    state.hotkeyOk = !!(hotkeyRef && typeof hotkeyRef.isRegistered === 'function' && hotkeyRef.isRegistered());
    // 悬浮球：按 floatBallEnabled 初始化（v2.2 默认开）
    floatBall.initFloatBall(getMainWindow, () => ({
      playback: state.playback,
      hotkey: state.hotkey,
      hotkeyOk: state.hotkeyOk,
    }));
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
