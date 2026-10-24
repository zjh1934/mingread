// W-UI2 自检探针：悬浮球改视觉后，四个既有行为必须一个都不能坏——
//   ① 拖拽（dragStart/dragMove/dragEnd） ② 右键菜单（自绘菜单 + 命令） 
//   ③ 状态气泡（title/caption + 角标）     ④ 单击朗读（cmd read）
// 做法：载入构建产物 dist/renderer/floatball.html，用假桥记录所有调用，
// 再用合成 MouseEvent 走完真实的 mousedown/mousemove/mouseup/contextmenu 路径。
// 用法：electron scripts/tmp_probe_WUI2_floatball.js（Windows 需先 unset ELECTRON_RUN_AS_NODE）
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain } = require('electron');

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_DIR, '..', 'deliverables');
const LOG_PATH = path.join(__dirname, 'tmp_probe_WUI2_floatball.txt');
const LOG = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cmds = [];

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(LOG_PATH, LOG.join('\n') + '\n', 'utf8');
}
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);

ipcMain.on('probe:cmd', (_e, c) => cmds.push(c));

const BALL_HTML = path.join(APP_DIR, 'dist', 'renderer', 'floatball.html');

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  // 0. 产物一致性：public 源文件与 dist 拷贝必须相同（vite build 会复制 public）
  const srcHash = sha(path.join(APP_DIR, 'public', 'floatball.html'));
  const distHash = sha(BALL_HTML);
  log(`floatball.html sha public=${srcHash} dist=${distHash} ${srcHash === distHash ? 'same' : 'DIFF'}`);

  const win = new BrowserWindow({
    width: 56,
    height: 56,
    frame: false,
    transparent: false,
    backgroundColor: '#eef0f6', // 仅截图底色（真实窗口是透明）；深色/浅色壁纸下都要看得见
    webPreferences: {
      preload: path.join(__dirname, 'tmp_probe_WUI2_floatball_preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) log(`[console:${level}] ${msg}`);
  });
  await win.loadFile(BALL_HTML);
  await wait(1400);

  const p = (s) => win.webContents.executeJavaScript(s);
  const state = async (s) => {
    win.webContents.send('probe:state', s);
    await wait(200);
  };
  const shot = async (name) => {
    let img = await win.webContents.capturePage();
    for (let i = 0; i < 8 && img.getSize().width === 0; i++) {
      // 首帧还没合成时先强制一次 resize 触发重绘，再重试
      const b = win.getBounds();
      win.setBounds({ ...b, width: b.width + 1 });
      await wait(150);
      win.setBounds(b);
      await wait(350);
      img = await win.webContents.capturePage();
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
    log(`captured ${name} ${img.getSize().width}x${img.getSize().height}`);
  };
  const resetCmds = () => {
    cmds.length = 0;
  };

  // 合成鼠标事件：坐标用 screenX/screenY（页面逻辑判断拖拽阈值就看这两个字段）
  const dispatch = (type, opts) =>
    p(`(() => {
      const t = ${JSON.stringify(opts.target || '#ball')};
      const el = document.querySelector(t) || document;
      el.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, {
        bubbles: true, cancelable: true, view: window,
        button: ${opts.button || 0}, buttons: ${opts.buttons || 0},
        clientX: ${opts.x || 0}, clientY: ${opts.y || 0},
        screenX: ${opts.sx || 0}, screenY: ${opts.sy || 0}
      }));
      return true;
    })()`);

  try {
    // 1. 结构 & 视觉 token 落到了计算样式上
    log('dom: ' + (await p(`(() => {
      const b = document.getElementById('ball');
      const cs = getComputedStyle(b);
      return JSON.stringify({
        cls: b.className,
        title: b.title,
        size: Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height),
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundImage,
        shadow: cs.boxShadow,
        svg: cs ? (() => { const s = getComputedStyle(b.querySelector('svg')); return s.width + '/' + s.color + '/' + s.fill; })() : 'n/a',
      });
    })()`)));
    await shot('qa-wui2-floatball-idle-56.png');

    // 1b. 最小档位的菜单：44px 保底下 8 项仍远小于 600px 钳位
    win.setBounds({ x: 100, y: 100, width: 300, height: 460 });
    await wait(400);
    await dispatch('contextmenu', { sx: 120, sy: 120, x: 10, y: 10, button: 2 });
    await wait(250);
    log('menu@56: ' + (await p(`(() => {
      const m = document.getElementById('ctx-menu');
      if (!m) return JSON.stringify({ menu: 'MISSING' });
      return JSON.stringify({
        itemMinH: getComputedStyle(m.querySelector('.ctx-item')).minHeight,
        menuH: Math.round(m.getBoundingClientRect().height),
        fitsMainClamp: Math.round(m.getBoundingClientRect().height) + 2 <= 600,
      });
    })()`)));
    win.setBounds({ x: 100, y: 100, width: 56, height: 56 });
    await p(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(200);

    // 2. 状态气泡：title + 图标 + 角标（三种状态逐个核）
    log('--- state ---');
    await state({ isPlaying: true });
    log('st-playing: ' + (await p(`(() => {
      const b = document.getElementById('ball');
      return JSON.stringify({
        cls: b.className, title: b.title,
        speaker: getComputedStyle(b.querySelector('.icon-speaker')).display,
        pause: getComputedStyle(b.querySelector('.icon-pause')).display,
        badge: getComputedStyle(document.getElementById('badge')).display,
        bg: getComputedStyle(b).backgroundImage,
      });
    })()`)));
    await state({ isPlaying: false, buffering: true });
    log('st-buffering: ' + (await p(`(() => {
      const b = document.getElementById('ball');
      const s = getComputedStyle(b.querySelector('svg'));
      return JSON.stringify({ cls: b.className, title: b.title, svgColor: s.color, svgFill: s.fill, bg: getComputedStyle(b).backgroundImage });
    })()`)));
    await state({ hotkeyOk: false, hotkey: 'F1' });
    log('st-conflict: ' + (await p(`(() => {
      const b = document.getElementById('ball');
      return JSON.stringify({
        cls: b.className, title: b.title,
        badge: getComputedStyle(document.getElementById('badge')).display,
        badgeBg: getComputedStyle(document.getElementById('badge')).backgroundColor,
        pause: getComputedStyle(b.querySelector('.icon-pause')).display,
      });
    })()`)));
    await state({ hotkeyOk: true, isPlaying: false, buffering: false, size: 112 });
    log('size-112: ' + (await p(`(() => {
      const b = document.getElementById('ball');
      const r = b.getBoundingClientRect();
      return JSON.stringify({
        cssVar: getComputedStyle(document.documentElement).getPropertyValue('--ball').trim(),
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        body: document.body.getBoundingClientRect().width,
      });
    })()`)));

    // 3. 单击朗读（无位移 → 只发 read）
    win.setBounds({ x: 100, y: 100, width: 112, height: 112 });
    await wait(300);
    resetCmds();
    await dispatch('mousedown', { sx: 500, sy: 500, x: 20, y: 20, button: 0, buttons: 1 });
    await dispatch('mouseup', { sx: 500, sy: 500, x: 20, y: 20, button: 0 });
    await wait(200);
    log('--- click ---');
    log('click cmds: ' + JSON.stringify(cmds));
    await shot('qa-wui2-floatball-playing-112.png');

    // 4. 拖拽（位移 80,40 > 阈值 5 → 只发 drag*，不发 read）
    resetCmds();
    await dispatch('mousedown', { sx: 500, sy: 500, x: 20, y: 20, button: 0, buttons: 1 });
    await dispatch('mousemove', { target: 'body', sx: 520, sy: 505, x: 40, y: 25, buttons: 1 });
    await dispatch('mousemove', { target: 'body', sx: 580, sy: 540, x: 100, y: 60, buttons: 1 });
    await dispatch('mouseup', { target: 'body', sx: 580, sy: 540, x: 100, y: 60 });
    await wait(200);
    log('--- drag ---');
    log('drag cmds: ' + JSON.stringify(cmds));

    // 5. 右键菜单：打开 → 项数/样式 → 点「朗读选中文字」发 read 并关闭
    log('--- context menu ---');
    // 主进程在收到 menu 提示时会把球窗口临时放大到能装下菜单；探针这里手动模拟同样尺寸
    win.setBounds({ x: 100, y: 100, width: 430, height: 640 });
    await wait(400);
    resetCmds();
    await dispatch('contextmenu', { sx: 120, sy: 120, x: 10, y: 10, button: 2 });
    await wait(250);
    log('menu open: ' + (await p(`(() => {
      const m = document.getElementById('ctx-menu');
      if (!m) return JSON.stringify({ menu: 'MISSING' });
      const cs = getComputedStyle(m);
      return JSON.stringify({
        menu: 'present',
        items: m.querySelectorAll('.ctx-item').length,
        seps: m.querySelectorAll('hr').length,
        labels: [].map.call(m.querySelectorAll('.ctx-item'), (b) => b.textContent),
        bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius,
        border: cs.borderTopWidth + ' ' + cs.borderTopColor,
        shadow: cs.boxShadow.slice(0, 60),
        itemMinH: getComputedStyle(m.querySelector('.ctx-item')).minHeight,
        menuH: Math.round(m.getBoundingClientRect().height),
        menuW: Math.round(m.getBoundingClientRect().width),
        // 主进程把菜单窗口高度钳在 600px：菜单必须放得下，否则最后几项会被裁掉
        fitsMainClamp: Math.round(m.getBoundingClientRect().height) + 2 <= 600,
      });
    })()`)));
    await shot('qa-wui2-floatball-menu.png');
    await p(`(() => { const b = [].filter.call(document.querySelectorAll('.ctx-item'), (x) => x.textContent === '朗读选中文字')[0]; if (b) { b.click(); return true; } return false; })()`);
    await wait(250);
    log('after menu click: cmds=' + JSON.stringify(cmds) + ' menu=' + (await p(`!!document.getElementById('ctx-menu')`)));

    // 菜单关闭路径：点空白处 / Esc 都要关掉
    await dispatch('contextmenu', { sx: 150, sy: 150, x: 40, y: 40, button: 2 });
    await wait(200);
    await p(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
    await wait(200);
    log('menu closed by outside mousedown: ' + (await p(`!document.getElementById('ctx-menu')`)));
    await dispatch('contextmenu', { sx: 150, sy: 150, x: 40, y: 40, button: 2 });
    await wait(200);
    await p(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await wait(200);
    log('menu closed by Escape: ' + (await p(`!document.getElementById('ctx-menu')`)));

    // 6. 右键菜单里的缩放 / 隐藏命令是否仍然发出（菜单项 → cmd 透传）
    resetCmds();
    await dispatch('contextmenu', { sx: 150, sy: 150, x: 40, y: 40, button: 2 });
    await wait(200);
    await p(`(() => { [].filter.call(document.querySelectorAll('.ctx-item'), (x) => x.textContent === '放大一档')[0].click(); return true; })()`);
    await wait(200);
    log('menu zoomIn cmd: ' + JSON.stringify(cmds));

    // 7. 冲突态 112px 视觉
    await state({ hotkeyOk: false, hotkey: 'F1', size: 112 });
    win.setBounds({ x: 100, y: 100, width: 112, height: 112 });
    await wait(400);
    await shot('qa-wui2-floatball-conflict-112.png');
    await state({ hotkeyOk: true, size: 112, isPlaying: true });
    await wait(300);
    await shot('qa-wui2-floatball-playing-112.png');

    // 8. 桥缺失时不影响静态渲染（模拟 web 预览）
    log('--- no bridge ---');
    const win2 = new BrowserWindow({ width: 56, height: 56, frame: false, backgroundColor: '#eef0f6', webPreferences: { contextIsolation: true } });
    await win2.loadFile(BALL_HTML);
    await wait(400);
    log('no-bridge dom: ' + (await win2.webContents.executeJavaScript(
      `JSON.stringify({ ball: !!document.getElementById('ball'), cls: document.getElementById('ball').className })`
    )));
    win2.destroy();
  } catch (e) {
    log('FAILED: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});

setTimeout(() => {
  log('TIMEOUT');
  app.exit(1);
}, 90000);
