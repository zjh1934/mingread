// α-视觉增强 QA 探针：真启动 Electron，按场景预置设置 → 截图 → 退出。
// 用法：LDN_SCEN=main|2x|hc|hc2x|settings|settings2x xvfb-run -a npx electron scripts/alpha_qa_shot.js
// 结果写到 deliverables/qa-v24-*.png，并把日志写 scripts/alpha_qa_shot.txt（不依赖 stdout）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', '..', 'deliverables'); // 交接包/deliverables
const LOG = [];
const SCEN = process.env.LDN_SCEN || 'main';

// 场景 → 预置 settings.json（主进程权威源）+ localStorage（zustand 主题）+ 是否打开设置
const SCENARIOS = {
  main: { fontScale: 1, floatBallSize: 56, theme: 'light', openSettings: false, file: 'qa-v24-main.png' },
  '2x': { fontScale: 2, floatBallSize: 112, theme: 'light', openSettings: false, file: 'qa-v24-main-2x.png' },
  hc: { fontScale: 1, floatBallSize: 56, theme: 'hc', openSettings: false, file: 'qa-v24-main-hc.png' },
  hc2x: { fontScale: 1.5, floatBallSize: 112, theme: 'hc', openSettings: true, tab: '缩放', file: 'qa-v24-settings-hc-15x.png' },
  settings: { fontScale: 1.25, floatBallSize: 80, theme: 'light', openSettings: true, tab: '缩放', file: 'qa-v24-settings-125x.png' },
  // 悬浮球档位热切换：56 → 运行时 saveSystemSettings 改 112 → 窗口尺寸应即时跟随
  ball: { fontScale: 1, floatBallSize: 56, theme: 'light', openSettings: false, toggle: true, file: 'qa-v24-ball-112.png' },
};

const cfg = SCENARIOS[SCEN] || SCENARIOS.main;

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, 'alpha_qa_shot.txt'), LOG.join('\n') + '\n');
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnqa-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ fontScale: cfg.fontScale, floatBallSize: cfg.floatBallSize, floatBallEnabled: true }, null, 2)
  );
  // index.js 会强制把 userData 设回 ~/.config/LangduNvNeo，
  // 这里用 settingsStore 的测试注入口把 settings.json 指到临时目录（不动真实用户配置）。
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${cfg.fontScale} floatBallSize=${cfg.floatBallSize}`);
  return dir;
}

const seed = () =>
  `localStorage.setItem('langdu-neo-settings', JSON.stringify({state:{themeMode:${JSON.stringify(
    cfg.theme
  )},voiceId:'edge:xiaoxiao',rate:0,pitch:0,volume:0},version:1}));`;

// 强制走 dist 构建产物：index.js 在 !app.isPackaged 时会 loadURL 开发服务器，
// 但 QA 需要验证的就是构建产物 → 把 isPackaged 置真（避免劫持 loadURL 影响 loadFile 内部实现）。
try {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  log('app.isPackaged=true (force load dist/renderer)');
} catch (e) {
  log('isPackaged override failed: ' + e.message);
}

app.commandLine.appendSwitch('no-sandbox');

let mainWin = null;
let seeded = false;

app.on('browser-window-created', (_e, w) => {
  if (mainWin) return;
  mainWin = w;
  log(`window created ${w.getBounds().width}x${w.getBounds().height}`);
  try {
    w.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      if (level >= 2) log(`[console:${level}] ${message} (${sourceId}:${line})`);
    });
  } catch (e) {
    /* noop */
  }
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (!seeded) {
          seeded = true;
          await w.webContents.executeJavaScript(seed());
          w.webContents.reload();
          return; // reload 后再次进入 did-finish-load（下面重新挂了一次）
        }
      } catch (e) {
        log('seed failed: ' + e.message);
      }
    }, 400);
  });
  w.webContents.on('did-finish-load', () => {
    if (!seeded) return;
    setTimeout(async () => {
      try {
        if (cfg.openSettings) {
          await w.webContents.executeJavaScript(
            `var b=document.querySelector('[aria-label="设置"]'); if(b){b.click(); true} else {false}`
          );
          if (cfg.tab) {
            // 切到指定设置页（如「缩放」），展示视觉增强分区
            setTimeout(() => {
              w.webContents
                .executeJavaScript(
                  `(function(){var ts=[].slice.call(document.querySelectorAll('.MuiTab-root'));
                    var t=ts.filter(function(x){return x.textContent.indexOf(${JSON.stringify(cfg.tab)})!==-1})[0];
                    if(t){t.click();return true}return false})()`
                )
                .catch((e) => log('click tab failed: ' + e.message));
            }, 700);
          }
        }
      } catch (e) {
        log('open settings failed: ' + e.message);
      }
      setTimeout(async () => {
        try {
          if (cfg.toggle) {
            // 运行时热切换：字号档位 + 悬浮球尺寸（验证持久化链路与即时生效）
            const r = await w.webContents.executeJavaScript(
              `window.langdu.saveSystemSettings({fontScale:2,floatBallSize:112}).then(function(x){return JSON.stringify(x&&x.ok)}).catch(function(e){return 'ERR '+e})`
            );
            log('saveSystemSettings(2/112): ' + r);
          }
          const img = await w.webContents.capturePage();
          fs.mkdirSync(OUT_DIR, { recursive: true });
          const p = path.join(OUT_DIR, cfg.file);
          fs.writeFileSync(p, img.toPNG());
          log(`captured ${p} ${img.getSize().width}x${img.getSize().height}`);
          // 顺带读一眼实际生效的缩放变量，证明档位真的落到了 DOM 上
          const probe = await w.webContents.executeJavaScript(
            `JSON.stringify({scale:getComputedStyle(document.documentElement).getPropertyValue('--ldn-scale').trim(),
              htmlFont:getComputedStyle(document.documentElement).fontSize,
              dataAttr:document.documentElement.getAttribute('data-font-scale'),
              hc:document.documentElement.getAttribute('data-theme-hc'),
              root:document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
              btn:(function(){var b=document.querySelector('.MuiButton-root');return b?getComputedStyle(b).minHeight:'none'})(),
              sys:(window.langdu&&window.langdu.getSystemSettings? 'has':'no')})`
          );
          log('dom probe: ' + probe);
          try {
            const sys = await w.webContents.executeJavaScript(
              `window.langdu.getSystemSettings ? window.langdu.getSystemSettings().then(function(s){return JSON.stringify(s)}).catch(function(e){return 'ERR '+e}) : 'no bridge'`
            );
            log('systemSettings: ' + sys);
          } catch (e) {
            log('sys probe failed: ' + e.message);
          }
        } catch (e) {
          log('capture failed: ' + e.message);
        }
        // 悬浮球窗口单独截一张：证明档位真的改了球体尺寸
        if (cfg.toggle) {
          try {
            const { BrowserWindow: BW2 } = require('electron');
            const ballWin = BW2.getAllWindows().find((x) => (x.getTitle() || '').indexOf('悬浮球') !== -1);
            if (ballWin) {
              await new Promise((r) => setTimeout(r, 1200));
              const b = ballWin.getBounds();
              log(`ball bounds after toggle: ${b.width}x${b.height}`);
              const bi = await ballWin.webContents.capturePage();
              fs.writeFileSync(path.join(OUT_DIR, 'qa-v24-ball-112.png'), bi.toPNG());
              log('captured qa-v24-ball-112.png');
            } else {
              log('ball window not found');
            }
          } catch (e) {
            log('ball capture failed: ' + e.message);
          }
        }
        setTimeout(() => app.quit(), 200);
      }, cfg.openSettings ? 1800 : 1500);
    }, 1200);
  });
});

seedUserData();

// 主进程入口：注册完钩子再 require，确保能拿到窗口
require('../src/main/index.js');

// 诊断：确认主进程真的读到了预置的 settings.json + 各窗口实际尺寸（含悬浮球档位）
setTimeout(() => {
  try {
    const s = require('../src/main/settingsStore').getSettings();
    log(`main settings: fontScale=${s.fontScale} floatBallSize=${s.floatBallSize}`);
    const { BrowserWindow: BW } = require('electron');
    BW.getAllWindows().forEach((win) => {
      const b = win.getBounds();
      log(`window[${win.getTitle() || win.id}] ${b.width}x${b.height} at (${b.x},${b.y}) visible=${win.isVisible()}`);
    });
  } catch (e) {
    log('settings probe failed: ' + e.message);
  }
}, 6500);

app.on('window-all-closed', () => app.quit());
setTimeout(() => {
  log('timeout guard: quitting');
  app.quit();
}, 30000);
