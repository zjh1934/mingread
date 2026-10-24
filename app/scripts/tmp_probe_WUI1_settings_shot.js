// W-UI1 临时探针：真启动 Electron（加载 dist 构建产物）→ 打开设置面板 → 截图 + 量无障碍指标。
// 用法：
//   node node_modules/electron/cli.js scripts/tmp_probe_WUI1_settings_shot.js --scen=1x
//   node node_modules/electron/cli.js scripts/tmp_probe_WUI1_settings_shot.js --scen=2x
// 说明：electron 会以第一个非 flag 参数作为入口脚本，因此脚本自己解析 --scen。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const SCEN = (process.argv.find((a) => a.startsWith('--scen=')) || '--scen=1x').split('=')[1];
const IS_2X = SCEN === '2x';
const SCALE = IS_2X ? 2 : 1;
const OUT_DIR = path.join(__dirname, '..', 'dist', 'probe');
const LOG = [];

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, `tmp_probe_WUI1_${SCEN}.txt`), LOG.join('\n') + '\n');
  console.log(s);
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnwui1-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        fontScale: SCALE,
        floatBallSize: IS_2X ? 112 : 56,
        floatBallEnabled: true,
        clipboardAuto: true,
        hotkey: 'F1',
      },
      null,
      2
    )
  );
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${SCALE}`);
}

const seedLocalStorage = () =>
  `localStorage.setItem('langdu-neo-settings', JSON.stringify({state:{themeMode:'light',voiceId:'edge:xiaoxiao',rate:0,pitch:0,volume:0},version:1}));`;

try {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
} catch (e) {
  log('isPackaged override failed: ' + e.message);
}
app.commandLine.appendSwitch('no-sandbox');

let mainWin = null;
let seeded = false;
let finished = false;

const MEASURE = `(function(){
  var dialog = document.querySelector('.MuiDialog-paper');
  var content = dialog ? dialog.querySelector('.MuiDialogContent-root') : null;
  var tabs = [].slice.call(document.querySelectorAll('[role="tab"]'));
  var tabHeights = tabs.map(function(t){ return Math.round(t.getBoundingClientRect().height); });
  var rows = [].slice.call(document.querySelectorAll('.MuiDialog-paper .MuiSwitch-root, .MuiDialog-paper .MuiButtonBase-root, .MuiDialog-paper .MuiChip-root'));
  var small = rows.filter(function(el){ var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5; })
                  .map(function(el){ return (el.getAttribute('aria-label')||el.textContent||el.className).slice(0,42) + ' h=' + Math.round(el.getBoundingClientRect().height); });
  return JSON.stringify({
    scale: getComputedStyle(document.documentElement).getPropertyValue('--ldn-scale').trim(),
    htmlFont: getComputedStyle(document.documentElement).fontSize,
    dialogW: dialog ? Math.round(dialog.getBoundingClientRect().width) : -1,
    dialogH: dialog ? Math.round(dialog.getBoundingClientRect().height) : -1,
    contentScrollW: content ? content.scrollWidth : -1,
    contentClientW: content ? content.clientWidth : -1,
    overflowX: content ? content.scrollWidth - content.clientWidth : -1,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    tabs: tabs.map(function(t){ return t.textContent.trim(); }),
    tabHeights: tabHeights,
    selectedTab: (document.querySelector('[role="tab"][aria-selected="true"]')||{}).textContent || null,
    panelRole: (document.querySelector('[role="tabpanel"]')||{}).tagName || null,
    smallTargets: small,
    chain: (function(){
      if (!content) return [];
      var cr = content.getBoundingClientRect();
      var worst = null;
      [].slice.call(content.querySelectorAll('*')).forEach(function(el){
        var r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > cr.right + 0.5) {
          if (!worst || r.right > worst.right) worst = el;
        }
      });
      if (!worst) return [];
      var out = [];
      var n = worst;
      for (var i = 0; i < 6 && n; i += 1) {
        var rr = n.getBoundingClientRect();
        out.push(n.tagName + ' w=' + Math.round(rr.width) + ' right=' + Math.round(rr.right) +
          ' pad=' + getComputedStyle(n).paddingLeft + '/' + getComputedStyle(n).paddingRight +
          ' minW=' + getComputedStyle(n).minWidth + ' flex=' + getComputedStyle(n).flex);
        n = n.parentElement;
      }
      out.push('content right=' + Math.round(cr.right) + ' pad=' + getComputedStyle(content).paddingLeft + '/' + getComputedStyle(content).paddingRight);
      return out;
    })(),
    overflowing: (function(){
      if (!content) return [];
      var cr = content.getBoundingClientRect();
      return [].slice.call(content.querySelectorAll('*')).filter(function(el){
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.right > cr.right + 0.5;
      }).slice(0, 6).map(function(el){
        return (el.tagName + '.' + String(el.className).slice(0, 40) + ' right=' + Math.round(el.getBoundingClientRect().right) + ' vs ' + Math.round(cr.right));
      });
    })()
  });
})()`;

async function shoot(win, name, extras) {
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, img.toPNG());
  const size = img.getSize();
  log(`captured ${name} ${size.width}x${size.height}${extras ? ' ' + extras : ''}`);
  return p;
}

app.on('browser-window-created', (_e, w) => {
  if (mainWin) return;
  const title = w.getTitle() || '';
  if (title.indexOf('悬浮球') !== -1) return;
  mainWin = w;
  log(`window created ${w.getBounds().width}x${w.getBounds().height}`);
  w.webContents.on('console-message', (_e2, level, message) => {
    if (level >= 2) log(`[console:${level}] ${message}`);
  });

  w.webContents.on('did-finish-load', async () => {
    if (!seeded) {
      try {
        await w.webContents.executeJavaScript(seedLocalStorage());
        seeded = true;
        w.webContents.reload();
      } catch (e) {
        log('seed failed: ' + e.message);
      }
      return;
    }
    if (finished) return;
    finished = true;
    {
      try {
        await new Promise((r) => setTimeout(r, 2200));
        const opened = await w.webContents.executeJavaScript(
          `(function(){var b=document.querySelector('[aria-label="设置"]'); if(b){b.click(); return true;} return false;})()`
        );
        log('open settings: ' + opened);
        await new Promise((r) => setTimeout(r, 1500));
        log('measure[' + SCEN + ']: ' + (await w.webContents.executeJavaScript(MEASURE)));
        await shoot(w, `settings-${SCEN}.png`, `tab=${SCEN === '2x' ? '常用' : '常用'}`);

        if (!IS_2X) {
          for (const [label, file] of [['朗读', 'settings-1x-read.png'], ['缩放', 'settings-1x-zoom.png'], ['无障碍', 'settings-1x-a11y.png'], ['关于', 'settings-1x-about.png']]) {
            const okx = await w.webContents.executeJavaScript(
              `(function(){var ts=[].slice.call(document.querySelectorAll('[role="tab"]'));
                var t=ts.filter(function(x){return x.textContent.indexOf(${JSON.stringify(label)})!==-1})[0];
                if(t){t.click();return true}return false})()`
            );
            await new Promise((r) => setTimeout(r, 800));
            await shoot(w, file, 'tab=' + label + ' clicked=' + okx);
          }
          const backOk = await w.webContents.executeJavaScript(
            `(function(){var ts=[].slice.call(document.querySelectorAll('[role="tab"]'));
              var t=ts.filter(function(x){return x.textContent.indexOf('常用')!==-1})[0];
              if(t){t.click();return true}return false})()`
          );
          log('back to 常用: ' + backOk);
        }

        // 额外证据：2.0x 下切到「无障碍」分区（字号档位 / 对比度 / 语音提示 / 悬浮球同屏）
        if (IS_2X) {
          const ok = await w.webContents.executeJavaScript(
            `(function(){var ts=[].slice.call(document.querySelectorAll('[role="tab"]'));
              var t=ts.filter(function(x){return x.textContent.indexOf('无障碍')!==-1})[0];
              if(t){t.click();return true}return false})()`
          );
          log('switch to 无障碍: ' + ok);
          await new Promise((r) => setTimeout(r, 900));
          log('measure[2x-a11y]: ' + (await w.webContents.executeJavaScript(MEASURE)));
          await shoot(w, 'settings-2x-a11y.png', 'tab=无障碍');

          const okZoom = await w.webContents.executeJavaScript(
            `(function(){var ts=[].slice.call(document.querySelectorAll('[role="tab"]'));
              var t=ts.filter(function(x){return x.textContent.indexOf('缩放')!==-1})[0];
              if(t){t.click();return true}return false})()`
          );
          log('switch to 缩放: ' + okZoom);
          await new Promise((r) => setTimeout(r, 900));
          log('measure[2x-zoom]: ' + (await w.webContents.executeJavaScript(MEASURE)));
          await shoot(w, 'settings-2x-zoom.png', 'tab=缩放');
        }

        // 键盘：Esc 应关闭对话框（无障碍红线）
        const esc = await w.webContents.executeJavaScript(
          `(function(){var d=document.querySelector('.MuiDialog-root'); return !!d;})()`
        );
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await new Promise((r) => setTimeout(r, 700));
        const closed = await w.webContents.executeJavaScript(
          `(function(){var p=document.querySelector('.MuiDialog-paper'); return !p || p.getBoundingClientRect().width === 0;})()`
        );
        log(`dialogPresentBeforeEsc=${esc} closedAfterEsc=${closed}`);

        // 方向键切换分区（在 Tab 上按 →，aria-selected 应移动）
        const reopened = await w.webContents.executeJavaScript(
          `(function(){var b=document.querySelector('[aria-label="设置"]'); if(b){b.click();return true}return false})()`
        );
        await new Promise((r) => setTimeout(r, 800));
        const tabFocus = await w.webContents.executeJavaScript(
          `(function(){var t=document.querySelector('[role="tab"][aria-selected="true"]'); if(!t)return 'no-selected';
            t.focus(); var before=t.textContent.trim(); t.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
            return before;})()`
        );
        await new Promise((r) => setTimeout(r, 400));
        const afterArrow = await w.webContents.executeJavaScript(
          `(function(){var t=document.querySelector('[role="tab"][aria-selected="true"]');
            var focused=document.activeElement && document.activeElement.textContent ? document.activeElement.textContent.trim() : '';
            return JSON.stringify({selected:t?t.textContent.trim():null, focused:focused});})()`
        );
        log(`reopen=${reopened} arrowFrom=${tabFocus} arrowResult=${afterArrow}`);
      } catch (e) {
        log('probe failed: ' + e.message);
      }
      setTimeout(() => app.quit(), 300);
    }
  });
});

process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack)));

seedUserData();
try {
  log('before require, hasLock=' + app.requestSingleInstanceLock());
  require('../src/main/index.js');
  log('after require, isReady=' + app.isReady());
} catch (e) {
  log('require main failed: ' + (e && e.stack));
}
app.on('ready', () => log('app ready fired'));

setTimeout(() => {
  log('timeout guard: quitting');
  app.quit();
}, 45000);
