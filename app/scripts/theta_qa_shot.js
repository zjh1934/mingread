// θ-视觉细节收尾 QA 探针：真启动 Electron，按场景预置设置 → 截图 → 退出。
// 用法：LDN_SCEN=zoom2x|zoom2xhc|log2x|log2xhc|syspref|zoom2xbottom|zoom2xmid xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/theta_qa_shot.js
// 重点验证：2.0x 字号档（+高对比度）下 SettingsDialog / ZoomSettings 不破版、不重叠、不截断；
//           syspref 场景用 CDP 模拟系统偏好（prefers-contrast: more + prefers-reduced-motion: reduce），
//           验证主题自动切 HC、过渡被关闭（基线指标 B / 动效偏好）。
// 结果写到 deliverables/qa-v25-settings-*.png，日志写 scripts/theta_qa_shot.txt。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', '..', 'deliverables');
const LOG = [];
const SCEN = process.env.LDN_SCEN || 'zoom2x';

// 场景 → 预置 settings.json（fontScale 主进程权威）+ localStorage（主题 + 历史记录）
const SCENARIOS = {
  // 设置 → 缩放页（内容最多的页）：2.0x 浅色
  zoom2x: { fontScale: 2, theme: 'light', openSettings: true, tab: '缩放', file: 'qa-v25-settings-2x-light.png' },
  // 设置 → 缩放页：2.0x 高对比度
  zoom2xhc: { fontScale: 2, theme: 'hc', openSettings: true, tab: '缩放', file: 'qa-v25-settings-2x-hc.png' },
  // 设置 → 记录页（错误/状态历史）：2.0x 浅色，预置若干条历史
  log2x: { fontScale: 2, theme: 'light', openSettings: true, tab: '记录', seedHistory: true, file: 'qa-v25-settings-log-2x-light.png' },
  // 设置 → 记录页：2.0x 高对比度
  log2xhc: { fontScale: 2, theme: 'hc', openSettings: true, tab: '记录', seedHistory: true, file: 'qa-v25-settings-log-2x-hc.png' },
  // 系统偏好联动：CDP 模拟 prefers-contrast:more + prefers-reduced-motion:reduce（不开设置框）
  syspref: {
    fontScale: 1,
    theme: 'light',
    emulate: { 'prefers-contrast': 'more', 'prefers-reduced-motion': 'reduce' },
    file: 'qa-v25-syspref-contrast-motion.png',
  },
  // 设置 → 缩放页滚到中部：2.0x 下长选项 Select 换行不截断（基线：看不全）
  zoom2xmid: { fontScale: 2, theme: 'light', openSettings: true, tab: '缩放', scrollTo: 0.34, file: 'qa-v25-settings-2x-zoom-mid.png' },
};

const cfg = SCENARIOS[SCEN] || SCENARIOS.zoom2x;

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, 'theta_qa_shot.txt'), LOG.join('\n') + '\n');
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnqa-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ fontScale: cfg.fontScale, floatBallSize: 112, floatBallEnabled: true }, null, 2)
  );
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${cfg.fontScale}`);
  return dir;
}

// 预置历史记录：模拟真实使用中会沉淀的条目（错误/警告/成功混合）
const HISTORY_SEED = JSON.stringify([
  { id: 's1', time: Date.now() - 3600e3, severity: 'error', source: 'settings', message: '朗读参数保存失败：主进程未接受该偏好' },
  { id: 's2', time: Date.now() - 1800e3, severity: 'warning', source: 'hotkey', message: '热键 Ctrl+Alt+F1 被其他程序占用，选中朗读暂不可用' },
  { id: 's3', time: Date.now() - 600e3, severity: 'success', source: 'settings', message: '复制即读已开启' },
  { id: 's4', time: Date.now() - 60e3, severity: 'error', source: 'runtime', message: '程序出现异常：Cannot read properties of undefined (reading map)' },
]);

const seed = () =>
  `localStorage.setItem('langdu-neo-settings', JSON.stringify({state:{themeMode:${JSON.stringify(
    cfg.theme
  )},voiceId:'edge:xiaoxiao',rate:0,pitch:0,volume:0},version:1}));` +
  (cfg.seedHistory
    ? // 先清掉上一次运行沉淀的记录（含旧探针报错），保证截图里就是预置的 4 条
      // HISTORY_SEED 是 JSON 字符串，必须再 stringify 一次成为 JS 字符串字面量，
      // 否则 setItem 收到数组会被 localStorage 转成 "[object Object],..."
      `localStorage.removeItem('langdu-neo-status-history');localStorage.setItem('langdu-neo-status-history', ${JSON.stringify(
        HISTORY_SEED
      )});`
    : '');

// 强制走 dist 构建产物（验证的就是 vite build 的产物）
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
      try {
        if (cfg.openSettings) {
          await w.webContents.executeJavaScript(
            `var b=document.querySelector('[aria-label="设置"]'); if(b){b.click(); true} else {false}`
          );
          if (cfg.tab) {
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
          // 系统偏好模拟（CDP）：必须在 reload 之后的 did-finish-load 里做
          if (cfg.emulate) {
            try {
              const dbg = w.webContents.debugger;
              dbg.attach();
              await dbg.sendCommand('Emulation.setEmulatedMedia', {
                features: Object.keys(cfg.emulate).map((k) => ({ name: k, value: cfg.emulate[k] })),
              });
              log('emulated: ' + JSON.stringify(cfg.emulate));
              await new Promise((r) => setTimeout(r, 1800)); // 等 matchMedia change → store 切 hc → 重渲染
            } catch (e) {
              log('emulate failed: ' + e.message);
            }
          }
          // 滚动设置框内容：验证密集区在 2.0x 下不截断（scrollTo=滚动比例）
          if (cfg.scrollTo != null || cfg.scrollBottom) {
            try {
              const st = await w.webContents.executeJavaScript(
                `(function(){var d=document.querySelector('.MuiDialogContent-root');if(!d)return 'none';
                  d.scrollTop=${cfg.scrollBottom ? 'd.scrollHeight' : `Math.round(d.scrollHeight*${Number(cfg.scrollTo)})`};
                  return d.scrollTop+'/'+d.scrollHeight})()`
              );
              log('scrolled: ' + st);
              await new Promise((r) => setTimeout(r, 500));
            } catch (e) {
              log('scroll failed: ' + e.message);
            }
          }
          const img = await w.webContents.capturePage();
          fs.mkdirSync(OUT_DIR, { recursive: true });
          const p = path.join(OUT_DIR, cfg.file);
          fs.writeFileSync(p, img.toPNG());
          log(`captured ${p} ${img.getSize().width}x${img.getSize().height}`);
          // DOM 探针：档位 / 主题 / 关键控件尺寸是否真的落到了 DOM 上
          const probe = await w.webContents.executeJavaScript(
            `JSON.stringify({assets:[].slice.call(document.scripts).map(function(s){return (s.src||'').split('/').pop()}).join(','),
              scale:getComputedStyle(document.documentElement).getPropertyValue('--ldn-scale').trim(),
              htmlFont:getComputedStyle(document.documentElement).fontSize,
              hc:document.documentElement.getAttribute('data-theme-hc'),
              tabCount:document.querySelectorAll('.MuiTab-root').length,
              activeTab:(function(){var t=document.querySelector('.MuiTab-root.Mui-selected');return t?t.textContent:'none'})(),
              sliderThumb:(function(){var t=document.querySelector('.MuiSlider-thumb');return t?getComputedStyle(t).width:'none'})(),
              switchTrack:(function(){var t=document.querySelector('.MuiSwitch-track');return t?getComputedStyle(t).backgroundColor+'/'+getComputedStyle(t).borderColor:'none'})(),
              historyCount:(function(){try{return JSON.parse(localStorage.getItem('langdu-neo-status-history')||'[]').length}catch(e){return -1}})(),
              historyRaw:(function(){try{return (localStorage.getItem('langdu-neo-status-history')||'<null>').slice(0,120)}catch(e){return 'ERR'}})(),
              logRows:document.querySelectorAll('.MuiChip-root').length,
              mqContrast:(function(){try{return window.matchMedia('(prefers-contrast: more)').matches}catch(e){return 'err'}})(),
              mqMotion:(function(){try{return window.matchMedia('(prefers-reduced-motion: reduce)').matches}catch(e){return 'err'}})(),
              motionDur:(function(){var b=document.querySelector('.MuiButton-root');return b?getComputedStyle(b).transitionDuration:'none'})(),
              dialogOverflow:(function(){var d=document.querySelector('.MuiDialogContent-root');if(!d)return 'none';return d.scrollHeight+'/'+d.clientHeight})()})`
          );
          log('dom probe: ' + probe);
        } catch (e) {
          log('capture failed: ' + e.message);
        }
        setTimeout(() => app.quit(), 200);
      }, cfg.openSettings ? 2200 : 1500);
    }, 1200);
  });
});

seedUserData();

// 主进程入口：注册完钩子再 require，确保能拿到窗口。
// 延迟 2.5s：避开上一次 QA 实例的单例锁释放窗口（requestSingleInstanceLock 竞争
// 会让新实例静默退出，表现为「日志只有两行、窗口从未创建」）。
setTimeout(() => {
  try {
    require('../src/main/index.js');
  } catch (e) {
    log('require main failed: ' + e.message);
  }
}, 2500);

setTimeout(() => {
  try {
    const s = require('../src/main/settingsStore').getSettings();
    log(`main settings: fontScale=${s.fontScale} floatBallSize=${s.floatBallSize}`);
  } catch (e) {
    log('settings probe failed: ' + e.message);
  }
}, 6500);

app.on('window-all-closed', () => app.quit());
setTimeout(() => {
  log('timeout guard: quitting');
  app.quit();
}, 30000);
