// η-QA v2.6 探针：次级弹层在 2.0x + HC（及 2.0x 浅色对照）下的逐个真点开验证。
// 用法：LDN_SCEN=hc2x|2x xvfb-run -a npx electron scripts/probe-qa-v26-panels.js
// 全部交互走真实输入事件（sendInputEvent 鼠标/键盘），不走合成 click。
// 流程：真启动 Electron → 等挂载 → 起一次朗读拿句列表 → 依次验证
//   ① 句列表展开态 ② 音色弹层 ③ 定时弹层 ④ 语调音量弹层
//   每个弹层：真实点击打开 → 布局探针（rect vs 视口 / 文本裁切 / 目标尺寸）
//   → 真实 Escape 键盘逃逸 + 焦点归位验证 → 截图
// 结果写 deliverables/qa-v26-panel-*.png，日志写 scripts/probe-qa-v26-panels.txt
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app } = require('electron');

const OUT_DIR = path.join(__dirname, '..', '..', 'deliverables'); // 交接包/deliverables
const LOG = [];
const SCEN = process.env.LDN_SCEN || 'hc2x';

const SCENARIOS = {
  hc2x: { fontScale: 2, theme: 'hc', tag: 'hc2x' },
  '2x': { fontScale: 2, theme: 'light', tag: '2x' },
};
const cfg = SCENARIOS[SCEN] || SCENARIOS.hc2x;
const P = `qa-v26-panel-${cfg.tag}`;

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, 'probe-qa-v26-panels.txt'), LOG.join('\n') + '\n');
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnqa26-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ fontScale: cfg.fontScale, floatBallSize: 112, floatBallEnabled: false }, null, 2)
  );
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${cfg.fontScale} theme=${cfg.theme}`);
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
    setTimeout(run, 1200);
  });
});

// ---- 探针片段（在渲染进程执行）----

// 弹层布局探针：rect vs 视口、可见文本裁切、按钮数量与尺寸
const PROBE_POPOVER = `(function(){
  var paper = document.querySelector('.MuiPopover-paper');
  if (!paper) return JSON.stringify({error:'no .MuiPopover-paper'});
  var r = paper.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  var clipped = [];
  paper.querySelectorAll('*').forEach(function(el){
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return;
    if (el.closest('.MuiSlider-valueLabel')) return; // 滑块悬停气泡，隐藏态误报
    if (el.closest('.MuiSlider-thumb')) return; // 滑块 thumb 内隐藏 range input 的触摸热区，非视觉裁切
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      var er = el.getBoundingClientRect();
      clipped.push(el.tagName + ' "' + (el.textContent||'').trim().slice(0,18) + '" sw=' + el.scrollWidth + ' cw=' + el.clientWidth + ' @' + Math.round(er.left) + ',' + Math.round(er.top));
    }
  });
  var out = {
    rect: {l:Math.round(r.left), t:Math.round(r.top), r:Math.round(r.right), b:Math.round(r.bottom), w:Math.round(r.width), h:Math.round(r.height)},
    viewport: {w:vw, h:vh},
    withinViewport: r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1,
    clipped: clipped.slice(0, 6)
  };
  var btns = paper.querySelectorAll('button');
  out.buttonCount = btns.length;
  out.buttonSizes = [];
  btns.forEach(function(b){ var br=b.getBoundingClientRect(); out.buttonSizes.push((b.textContent||b.getAttribute('aria-label')||'?').trim().slice(0,8)+':'+Math.round(br.width)+'x'+Math.round(br.height)); });
  return JSON.stringify(out);
})()`;

// 主页面探针：横向溢出 / TopBar 溢出与文本裁切 / 字号与 HC 生效确认
const PROBE_MAIN = `(function(){
  var de = document.documentElement;
  var out = {
    scale: getComputedStyle(de).getPropertyValue('--ldn-scale').trim(),
    hc: de.getAttribute('data-theme-hc'),
    overflowX: de.scrollWidth - de.clientWidth,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    topbar: null
  };
  var bar = document.querySelector('header');
  if (bar) {
    var over = [], clipped = [];
    bar.querySelectorAll('*').forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) over.push(el.tagName + '.' + String(el.className).slice(0,30) + ' l=' + Math.round(r.left) + ' r=' + Math.round(r.right));
      if (el.children.length === 0 && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) clipped.push('"' + (el.textContent||'').trim().slice(0,20) + '" sw=' + el.scrollWidth + ' cw=' + el.clientWidth);
    });
    out.topbar = {h: Math.round(bar.getBoundingClientRect().height), overflow: over.slice(0,5), clippedText: clipped.slice(0,5)};
  }
  return JSON.stringify(out);
})()`;

// 句列表展开态探针：句行按钮（aria-label="第 N 句，共 M 句"）的父容器即滚动盒
const PROBE_SENTENCES = `(function(){
  var row = document.querySelector('[aria-label^="第 "][aria-label*="句，共"]');
  if (!row) return JSON.stringify({error:'no sentence row (list empty or not expanded)'});
  var box = row.parentElement;
  var r = box.getBoundingClientRect();
  var rows = box.querySelectorAll('[aria-label^="第 "]');
  var out = {
    rect: {l:Math.round(r.left), t:Math.round(r.top), r:Math.round(r.right), b:Math.round(r.bottom), w:Math.round(r.width), h:Math.round(r.height)},
    viewport: {w: window.innerWidth, h: window.innerHeight},
    withinViewport: r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
    internalScroll: box.scrollHeight > box.clientHeight,
    scrollH: box.scrollHeight, clientH: box.clientHeight,
    rowCount: rows.length
  };
  var rr = row.getBoundingClientRect();
  out.firstRow = {w: Math.round(rr.width), h: Math.round(rr.height), fs: getComputedStyle(row).fontSize};
  return JSON.stringify(out);
})()`;

// 焦点探针：当前焦点元素是谁
const PROBE_FOCUS = `(function(){
  var a = document.activeElement;
  if (!a || a === document.body) return 'body/none';
  var r = a.getBoundingClientRect();
  return a.tagName + ' "' + ((a.getAttribute('aria-label') || a.textContent || '').trim().slice(0,24)) + '" ' + Math.round(r.width) + 'x' + Math.round(r.height);
})()`;

// ---- 工具函数 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function js(code) {
  return mainWin.webContents.executeJavaScript(code);
}

async function shot(name) {
  const img = await mainWin.webContents.capturePage();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, img.toPNG());
  log(`captured ${name} ${img.getSize().width}x${img.getSize().height}`);
}

// 真实鼠标点击：先滚动到视口中央，取元素中心坐标，发 mouseDown/mouseUp
async function realClick(elExpr, tag) {
  const pt = await js(
    `(function(){var el=${elExpr}; if(!el) return null; el.scrollIntoView({block:'center'}); var r=el.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height)})})()`
  );
  if (!pt) {
    log(`realClick[${tag}] element not found`);
    return false;
  }
  const { x, y, w, h } = JSON.parse(pt);
  mainWin.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  mainWin.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  await sleep(40);
  mainWin.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  log(`realClick[${tag}] at (${x},${y}) size ${w}x${h}`);
  return true;
}

// 真实键盘 Escape
async function realEscape() {
  mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(30);
  mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
}

async function waitMounted() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const ok = await js(
        `!!document.querySelector('button') && document.querySelectorAll('button').length >= 6`
      );
      if (ok) return true;
    } catch (e) {
      /* 忽略单次探测失败 */
    }
    await sleep(150);
  }
  return false;
}

async function waitFor(cond, tries = 40, gap = 150) {
  for (let i = 0; i < tries; i += 1) {
    try {
      if (await js(cond)) return true;
    } catch (e) {
      /* 忽略 */
    }
    await sleep(gap);
  }
  return false;
}

// 完整弹层验证：真实点击打开 → 布局探针 + 截图 → 真实 Escape → 关闭与焦点归位
async function verifyPopover(elExpr, tag, shotName) {
  const opened = await realClick(elExpr, tag);
  if (!opened) return;
  await sleep(800);
  log(`${tag} probe: ` + (await js(PROBE_POPOVER)));
  log(`${tag} focusAfterOpen: ` + (await js(PROBE_FOCUS)));
  await shot(shotName);
  await realEscape();
  const closed = await waitFor(`!document.querySelector('.MuiPopover-paper')`, 20, 100);
  await sleep(300);
  log(`${tag} escapeClosed: ${closed} | focusAfterEscape: ` + (await js(PROBE_FOCUS)));
  await shot(`${shotName.replace('.png', '')}-after-esc.png`);
}

async function run() {
  await waitMounted();
  await sleep(600);

  // 0) 主界面基线（hc2x）：TopBar 是否溢出/裁切
  log('--- step0 main baseline');
  log('main probe: ' + (await js(PROBE_MAIN)));
  await shot(`${P}-main.png`);

  // 1) 起一次朗读，拿句列表数据（splitSentences 是主进程纯函数，不需要真出声）
  log('--- step1 start playback for sentences');
  const started = await realClick(
    `[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('开始朗读')!==-1})[0]`,
    '开始朗读'
  );
  log('click 开始朗读: ' + started);
  const gotSentences = await waitFor(
    `(function(){var t=[].slice.call(document.querySelectorAll('*')).filter(function(e){return e.children.length===0 && /第 \\d+ \\/ \\d+ 句/.test(e.textContent||'')})[0]; return !!t})()`,
    60,
    250
  );
  log('sentences populated: ' + gotSentences);
  await sleep(400);

  // 2) 句列表展开态（真实点击 toggle）
  log('--- step2 sentence list expanded');
  const LIST_TOGGLE = `[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('句列表')!==-1})[0]`;
  const openedList = await realClick(LIST_TOGGLE, '句列表');
  log('click 句列表: ' + openedList);
  await sleep(800);
  log('sentences probe: ' + (await js(PROBE_SENTENCES)));
  await shot(`${P}-sentences.png`);
  // 收起回去，避免影响后续弹层截图
  await realClick(LIST_TOGGLE, '句列表-collapse');
  await sleep(500);

  // 3) 音色弹层
  log('--- step3 voice popover');
  await verifyPopover(
    `[].slice.call(document.querySelectorAll('button')).filter(function(b){return b.textContent.indexOf('音色')!==-1})[0]`,
    'voice',
    `${P}-voice.png`
  );

  // 4) 定时弹层
  log('--- step4 timer popover');
  await verifyPopover(`document.querySelector('button[aria-label="定时关闭"]')`, 'timer', `${P}-timer.png`);

  // 5) 语调/音量弹层
  log('--- step5 tuning popover');
  await verifyPopover(`document.querySelector('button[aria-label="更多朗读参数"]')`, 'tuning', `${P}-tuning.png`);

  // 6) 收尾：整体一张
  await shot(`${P}-final.png`);
  log('--- done');
  setTimeout(() => app.quit(), 300);
}

seedUserData();

// 绕过单实例锁：沙箱里可能并行跑着其他 QA 实例
try {
  app.requestSingleInstanceLock = () => true;
} catch (e) {
  /* 旧版本无此方法时忽略 */
}

require('../src/main/index.js');

app.on('window-all-closed', () => app.quit());
setTimeout(() => {
  log('timeout guard: quitting');
  app.quit();
}, 120000);
