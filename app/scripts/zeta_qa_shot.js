// ζ-主界面信息架构 QA 探针：真启动 Electron，按场景预置设置 → 截图 → 退出。
// 用法：LDN_SCEN=main|2x|hc|hc2x|editor2x xvfb-run -a npx electron scripts/zeta_qa_shot.js
// 结果写到 deliverables/qa-v25-*.png，日志写 scripts/zeta_qa_shot.txt（不依赖 stdout）。
// 场景说明：
//   main     1.0x 浅色（默认态：Editor 收起）
//   2x       2.0x 浅色（极端字号档）
//   hc       1.0x 高对比度（AAA）
//   hc2x     2.0x 高对比度（双极端叠加）
//   editor2x 2.0x 浅色 + 展开文本区（验证展开态不破版）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', '..', 'deliverables'); // 交接包/deliverables
const LOG = [];
const SCEN = process.env.LDN_SCEN || 'main';

const SCENARIOS = {
  main: { fontScale: 1, floatBallSize: 56, theme: 'light', expandEditor: false, file: 'qa-v25-main.png' },
  '2x': { fontScale: 2, floatBallSize: 112, theme: 'light', expandEditor: false, file: 'qa-v25-main-2x.png' },
  hc: { fontScale: 1, floatBallSize: 56, theme: 'hc', expandEditor: false, file: 'qa-v25-main-hc.png' },
  hc2x: { fontScale: 2, floatBallSize: 112, theme: 'hc', expandEditor: false, file: 'qa-v25-main-hc-2x.png' },
  editor2x: { fontScale: 2, floatBallSize: 112, theme: 'light', expandEditor: true, file: 'qa-v25-editor-2x.png' },
  // 次级入口实态：音色弹层 + 句列表展开（1.0x 浅色）
  panels: { fontScale: 1, floatBallSize: 56, theme: 'light', expandEditor: false, openPanels: true, file: 'qa-v25-panels.png' },
};

const cfg = SCENARIOS[SCEN] || SCENARIOS.main;

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, 'zeta_qa_shot.txt'), LOG.join('\n') + '\n');
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnqa25-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ fontScale: cfg.fontScale, floatBallSize: cfg.floatBallSize, floatBallEnabled: true }, null, 2)
  );
  // 用 settingsStore 的测试注入口把 settings.json 指到临时目录（不动真实用户配置）
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${cfg.fontScale} floatBallSize=${cfg.floatBallSize}`);
  return dir;
}

const seed = () =>
  `localStorage.setItem('langdu-neo-settings', JSON.stringify({state:{themeMode:${JSON.stringify(
    cfg.theme
  )},voiceId:'edge:xiaoxiao',rate:0,pitch:0,volume:0},version:1}));`;

// 强制走 dist 构建产物（QA 验证的就是构建产物）
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
          return;
        }
      } catch (e) {
        log('seed failed: ' + e.message);
      }
    }, 400);
  });
  w.webContents.on('did-finish-load', () => {
    if (!seeded) return;
    setTimeout(async () => {
      // 等 React 挂载完成（主按钮出现）再操作 / 截图，避免竞态黑屏
      const waitMounted = async () => {
        for (let i = 0; i < 40; i += 1) {
          try {
            const ok = await w.webContents.executeJavaScript(
              `!!document.querySelector('button') && document.querySelectorAll('button').length >= 6`
            );
            if (ok) return true;
          } catch (e) {
            /* 忽略单次探测失败 */
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        return false;
      };
      await waitMounted();
      try {
        if (cfg.expandEditor) {
          // 展开文本区：验证展开态在 2.0x 下不破版
          await w.webContents.executeJavaScript(
            `var b=document.querySelector('[aria-label="展开文本区"]'); if(b){b.click(); true} else {false}`
          );
          await new Promise((r) => setTimeout(r, 400));
          // 滚到底部，把展开的文本区纳入视口
          await w.webContents.executeJavaScript(`window.scrollTo(0, document.body.scrollHeight)`);
        }
        if (cfg.openPanels) {
          // 展开句列表 + 打开音色弹层：验证次级入口渲染
          await w.webContents.executeJavaScript(
            `(function(){var t=[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('句列表')!==-1})[0]; if(t){t.click();} var v=[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('音色')!==-1})[0]; if(v){v.click();} return true})()`
          );
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) {
        log('expand editor failed: ' + e.message);
      }
      setTimeout(async () => {
        try {
          const img = await w.webContents.capturePage();
          fs.mkdirSync(OUT_DIR, { recursive: true });
          const p = path.join(OUT_DIR, cfg.file);
          fs.writeFileSync(p, img.toPNG());
          log(`captured ${p} ${img.getSize().width}x${img.getSize().height}`);
          // 破版检测：页面是否出现横向溢出 / 关键控件是否被截断
          const probe = await w.webContents.executeJavaScript(
            `(function(){
              var de=document.documentElement;
              var scale=getComputedStyle(de).getPropertyValue('--ldn-scale').trim();
              var hc=de.getAttribute('data-theme-hc');
              var overflowX = de.scrollWidth - de.clientWidth;
              var playBtn=document.querySelector('[aria-label="播放"],[aria-label="暂停"]');
              var startBtn=[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('开始朗读')!==-1})[0];
              var rateBtn=document.querySelector('[aria-label="语速放慢"]');
              var out={scale:scale,hc:hc,overflowX:overflowX,docH:de.scrollHeight,
                playBtn:playBtn?Math.round(playBtn.getBoundingClientRect().width)+'x'+Math.round(playBtn.getBoundingClientRect().height):'none',
                startBtn:startBtn?Math.round(startBtn.getBoundingClientRect().width)+'x'+Math.round(startBtn.getBoundingClientRect().height):'none',
                rateBtn:rateBtn?Math.round(rateBtn.getBoundingClientRect().width)+'x'+Math.round(rateBtn.getBoundingClientRect().height):'none'};
              return JSON.stringify(out);
            })()`
          );
          log('layout probe: ' + probe);
        } catch (e) {
          log('capture failed: ' + e.message);
        }
        setTimeout(() => app.quit(), 200);
      }, cfg.expandEditor ? 1500 : 1500);
    }, 1200);
  });
});

seedUserData();

// 绕过单实例锁：沙箱里可能并行跑着其他 QA 实例（同一 userData），
// 不改动 main 代码，仅在本探针里放行，保证截图场景可随时执行。
try {
  app.requestSingleInstanceLock = () => true;
} catch (e) {
  /* 旧版本无此方法时忽略 */
}

require('../src/main/index.js');

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
