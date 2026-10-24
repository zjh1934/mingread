// W-FIX3 探针：悬浮球右键菜单「打开以后收不回去」。
//
// 用法（必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 会退化成纯 node 直接报错）：
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/tmp_probe_WFIX3_menu.js
//
// 做两段验证：
//   A. 主进程：用假 electron（桩记录 setFocusable/focus/blur/bounds），走真实 floatBall.js
//   B. 渲染层：把 public/floatball.html 装进真 BrowserWindow，用假桥 + DOM 事件驱动，
//      桥把每次调用经 ipcRenderer 转回主进程交给同一份 floatBall.js 处理，
//      因此「主进程收到 focusable=true/false」是真的走通了整条链路。
//
// 结论同时写 scripts/tmp_probe_WFIX3_menu.txt（stdout 在部分终端会被吞）。
'use strict';

delete process.env.ELECTRON_RUN_AS_NODE; // 别让后续子进程继承（会变成纯 node）

const fs = require('fs');
const path = require('path');
const Module = require('module');
const electron = require('electron');
const { app, ipcMain } = electron;

const OUT = path.join(__dirname, 'tmp_probe_WFIX3_menu.txt');
const rows = [];
function log(s) {
  rows.push(String(s));
  try {
    fs.writeFileSync(OUT, rows.join('\n') + '\n');
  } catch (e) {
    /* 写盘失败不影响结论 */
  }
  console.log(s);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: !!ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   |  ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 桩记录
const rec = {
  focusable: [], // 每次 setFocusable 的入参，按调用顺序
  focusCount: 0,
  blurCount: 0,
  focused: false,
  bounds: [],
  positions: [], // setPosition 调用（拖拽走的是这条）
  readCalls: 0, // selectionReader.readSelection 调用次数
  bridge: [], // 渲染层假桥发出的消息（顺序即 IPC 顺序）
};

function resetRec() {
  rec.focusable.length = 0;
  rec.focusCount = 0;
  rec.blurCount = 0;
  rec.bounds.length = 0;
  rec.positions.length = 0;
  rec.bridge.length = 0;
}

const lastFocusable = () => rec.focusable[rec.focusable.length - 1];

// ---------------------------------------------------------------- 假 BrowserWindow
class FakeBrowserWindow {
  constructor(opts) {
    const o = opts || {};
    this.opts = o;
    this._bounds = {
      x: typeof o.x === 'number' ? o.x : 900,
      y: typeof o.y === 'number' ? o.y : 600,
      width: o.width || 56,
      height: o.height || 56,
    };
    this._focusable = o.focusable !== false;
    this._focused = false;
    this._destroyed = false;
    this._visible = false;
    this._events = {};
    this.webContents = { send: () => true };
    FakeBrowserWindow.instances.push(this);
  }
  loadFile() {
    return Promise.resolve();
  }
  on(ev, cb) {
    (this._events[ev] = this._events[ev] || []).push(cb);
    return this;
  }
  emit(ev) {
    const a = Array.prototype.slice.call(arguments, 1);
    (this._events[ev] || []).forEach((f) => f.apply(null, a));
  }
  show() {
    this._visible = true;
  }
  hide() {
    this._visible = false;
  }
  isVisible() {
    return this._visible;
  }
  isDestroyed() {
    return this._destroyed;
  }
  destroy() {
    this._destroyed = true;
    this._focused = false;
  }
  setVisibleOnAllWorkspaces() {}
  setPosition(x, y) {
    this._bounds.x = x;
    this._bounds.y = y;
    rec.positions.push([x, y]);
  }
  getPosition() {
    return [this._bounds.x, this._bounds.y];
  }
  setBounds(b) {
    this._bounds = Object.assign({}, this._bounds, b);
    rec.bounds.push(Object.assign({}, this._bounds));
  }
  getBounds() {
    return Object.assign({}, this._bounds);
  }
  setFocusable(v) {
    this._focusable = !!v;
    rec.focusable.push(!!v);
  }
  isFocusable() {
    return this._focusable;
  }
  focus() {
    rec.focusCount++;
    rec.focused = true;
    this._focused = true;
  }
  blur() {
    rec.blurCount++;
    this._focused = false;
    rec.focused = false;
    this.emit('blur');
  }
  isFocused() {
    return this._focused;
  }
}
FakeBrowserWindow.instances = [];

const WA = { x: 0, y: 0, width: 1920, height: 1040 };
const fakeElectron = {
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ workArea: WA }),
    getDisplayNearestPoint: () => ({ workArea: WA }),
  },
  ipcMain: { on: () => {} }, // floatBall.js 自己不注册 IPC（复用 ipc.js 的 floatBall:cmd）
};

const STUBS = {
  './selectionReader': {
    readSelection: async () => {
      rec.readCalls++;
      return { ok: true, text: 'probe', source: 'selection', code: 'OK', tookMs: 1 };
    },
  },
  './a11yFeedback': { cue: () => {} },
  './settingsStore': {
    getSettings: () => ({ floatBallSize: 56, floatBallPos: { x: 900, y: 600 }, floatBallEnabled: true }),
    saveSettings: () => {},
  },
  './zoomController': { getZoomController: () => null },
};

/** 用假 electron 加载真实 floatBall.js（只在本进程内临时替换模块解析） */
function loadFloatBall() {
  const file = require.resolve('../src/main/floatBall.js');
  const orig = Module._load;
  delete require.cache[file];
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return orig.call(this, request, parent, isMain);
  };
  try {
    return require(file);
  } finally {
    Module._load = orig;
  }
}

// ---------------------------------------------------------------- A. 主进程段
async function mainSection(floatBall) {
  floatBall.initFloatBall(() => null, () => ({}));
  const win = FakeBrowserWindow.instances[0];
  if (!win) throw new Error('floatBall 未创建窗口（initFloatBall 失败）');
  check('A0 初始：窗口 focusable=false（不抢前台）', win.isFocusable() === false && !win.isFocused());

  // A1 菜单打开 → 临时夺焦 + 扩窗
  resetRec();
  await floatBall.handleCmd({ cmd: 'menu', open: true, width: 176, height: 268 });
  check(
    'A1 菜单打开 → 主进程 setFocusable(true)',
    win.isFocusable() === true && lastFocusable() === true,
    `calls=[${rec.focusable.join(',')}]`,
  );
  check('A1 菜单打开 → 主进程 focus() 被调用', rec.focusCount === 1 && win.isFocused(), `focusCount=${rec.focusCount}`);
  check('A1 菜单打开 → 窗口扩到菜单尺寸', win.getBounds().width > 56 && win.getBounds().height > 56, JSON.stringify(win.getBounds()));

  // A2 菜单关闭 → 立刻收回 focusable
  resetRec();
  await floatBall.handleCmd({ cmd: 'menu', open: false });
  check(
    'A2 菜单关闭 → 主进程 setFocusable(false)',
    win.isFocusable() === false && lastFocusable() === false,
    `calls=[${rec.focusable.join(',')}]`,
  );
  check('A2 菜单关闭 → 先把焦点还回去（blur 1 次）', rec.blurCount === 1 && !win.isFocused(), `blur=${rec.blurCount}`);
  check('A2 菜单关闭 → 窗口收回球体尺寸', win.getBounds().width === 56 && win.getBounds().height === 56, JSON.stringify(win.getBounds()));

  // A3 关闭幂等：重复 close 不报错、不重复夺焦
  resetRec();
  await floatBall.handleCmd({ cmd: 'menu', open: false });
  check('A3 重复 close 幂等（不再动窗口/焦点）', rec.focusable.length === 0 && win.isFocusable() === false);

  // A4 拖拽段：不能吞掉拖拽，也不能留下可聚焦窗口
  resetRec();
  floatBall.handleDragStart();
  floatBall.handleDragMove({ dx: 30, dy: 12 });
  floatBall.handleDragEnd();
  check('A4 拖拽：窗口跟随（setPosition 有更新）', rec.positions.length >= 1, `pos=${JSON.stringify(win.getPosition())}`);
  check('A4 拖拽结束 → focusable 仍为 false', win.isFocusable() === false && lastFocusable() === false);
  check('A4 拖拽不触发 read', rec.readCalls === 0, `readCalls=${rec.readCalls}`);
  check('A4 拖拽不夺焦（focus 未被调用）', rec.focusCount === 0 && !win.isFocused());

  // A5 隐藏时不留可聚焦后台窗口
  resetRec();
  await floatBall.handleCmd({ cmd: 'menu', open: true, width: 176, height: 268 });
  await floatBall.handleCmd({ cmd: 'hide' });
  check('A5 菜单里「隐藏悬浮球」→ focusable=false 且窗口隐藏', win.isFocusable() === false && win.isVisible() === false);
  check('A5 隐藏前已收回扩大窗口（不留透明挡板）', win.getBounds().width === 56 && win.getBounds().height === 56, JSON.stringify(win.getBounds()));
  win.show();

  // A5b 托盘「显示/隐藏悬浮球」也不能把可聚焦状态遗留在后台
  resetRec();
  await floatBall.handleCmd({ cmd: 'menu', open: true, width: 176, height: 268 });
  floatBall.toggle();
  check('A5b 托盘 toggle 隐藏 → focusable=false 且窗口隐藏', win.isFocusable() === false && win.isVisible() === false);
  check('A5b 托盘隐藏前已收回扩大窗口', win.getBounds().width === 56, JSON.stringify(win.getBounds()));
  win.show();
}

// ---------------------------------------------------------------- B. 渲染层段
async function domSection(floatBall) {
  const w = new electron.BrowserWindow({
    width: 420,
    height: 360,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, backgroundThrottling: false },
  });
  await w.loadFile(path.join(__dirname, '..', 'public', 'floatball.html'));

  // 假桥：记录调用 + 原样转给主进程（走真实 IPC，因此断言的是"主进程真的收到了"）
  await w.webContents.executeJavaScript(`
    (function () {
      window.__probe = [];
      var send = function (m) {
        try { require('electron').ipcRenderer.send('probe:bridge', m); } catch (e) {}
      };
      window.langdu = {
        floatBall: {
          cmd: function (p) { window.__probe.push(p); send({ kind: 'cmd', payload: p }); },
          dragStart: function () { window.__probe.push('dragStart'); send({ kind: 'dragStart' }); },
          dragMove: function (d) { window.__probe.push({ dragMove: d }); send({ kind: 'dragMove', payload: d }); },
          dragEnd: function () { window.__probe.push('dragEnd'); send({ kind: 'dragEnd' }); },
          onState: function (cb) { return function () {}; }
        }
      };
      true;
    })();
  `);

  const win = FakeBrowserWindow.instances[0];
  const js = (code) => w.webContents.executeJavaScript(code);
  const act = async (code, wait) => {
    await js(code);
    await sleep(wait || 150);
  };
  const menuShown = () => js(`!!document.getElementById('ctx-menu')`);
  const openMenuJs = `(function () {
    var b = document.getElementById('ball');
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 2 }));
    return true;
  })()`;

  // ---- B1 打开菜单 → 主进程收到 focusable=true
  resetRec();
  await act(openMenuJs);
  check('B1 右键 → 菜单 DOM 出现', (await menuShown()) === true);
  check(
    'B1 右键 → 主进程收到 setFocusable(true)',
    win.isFocusable() === true && lastFocusable() === true,
    `calls=[${rec.focusable.join(',')}]`,
  );
  check('B1 右键 → 主进程 focus() 被调用', rec.focusCount === 1, `focusCount=${rec.focusCount}`);
  check('B1 右键 → 窗口已扩大（菜单不被裁切）', win.getBounds().width > 56, JSON.stringify(win.getBounds()));

  // ---- B2 模拟 window.blur（= 用户点桌面/别的程序）→ 菜单消失 + focusable=false
  resetRec();
  await act(`(window.dispatchEvent(new Event('blur')), true)`);
  check('B2 window.blur → 菜单 DOM 消失', (await menuShown()) === false);
  check(
    'B2 window.blur → 主进程收到 setFocusable(false)',
    win.isFocusable() === false && lastFocusable() === false,
    `calls=[${rec.focusable.join(',')}]`,
  );
  check(
    'B2 window.blur → 主进程收到 menu:false',
    rec.bridge.some((m) => m.kind === 'cmd' && m.payload && m.payload.cmd === 'menu' && m.payload.open === false),
  );
  check('B2 window.blur → 窗口收回球体尺寸', win.getBounds().width === 56, JSON.stringify(win.getBounds()));

  // ---- B3 Esc 关闭
  resetRec();
  await act(openMenuJs);
  const openedEsc = (await menuShown()) === true;
  await act(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true)`);
  check('B3 Esc → 菜单 DOM 消失', openedEsc && (await menuShown()) === false);
  check('B3 Esc → 主进程收到 setFocusable(false)', win.isFocusable() === false && lastFocusable() === false);

  // ---- B4 再点一次球（mousedown 到球上 → 文档捕获阶段收菜单）
  resetRec();
  await act(openMenuJs);
  const openedBall = (await menuShown()) === true;
  await act(`(function () {
    var b = document.getElementById('ball');
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20, screenX: 20, screenY: 20 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, screenX: 20, screenY: 20 }));
    return true;
  })()`);
  check('B4 再点一次球 → 菜单 DOM 消失', openedBall && (await menuShown()) === false);
  check('B4 再点一次球 → 主进程收到 setFocusable(false)', win.isFocusable() === false && lastFocusable() === false);

  // ---- B5 菜单项点击关闭（且"先关菜单再发指令"：朗读要能打到原窗口）
  resetRec();
  await act(openMenuJs);
  const itemCount = await js(`document.querySelectorAll('#ctx-menu .ctx-item').length`);
  await act(`(document.querySelectorAll('#ctx-menu .ctx-item')[1].click(), true)`); // 第 2 项「播放」
  const idxMenuOff = rec.bridge.findIndex((m) => m.kind === 'cmd' && m.payload && m.payload.cmd === 'menu' && m.payload.open === false);
  const idxPlay = rec.bridge.findIndex((m) => m.kind === 'cmd' && m.payload && m.payload.cmd === 'play');
  check('B5 菜单项点击 → 菜单 DOM 消失', itemCount > 1 && (await menuShown()) === false);
  check('B5 菜单项点击 → 主进程收到 setFocusable(false)', win.isFocusable() === false && lastFocusable() === false);
  check('B5 菜单项点击 → 指令仍送达（cmd=play）', idxPlay > -1);
  check('B5 顺序正确：先 menu:false 再 cmd', idxMenuOff > -1 && idxMenuOff < idxPlay, `menuOff=${idxMenuOff} play=${idxPlay}`);

  // ---- B6 拖拽不被 focusable 影响，且不触发 read
  resetRec();
  const readBeforeDrag = rec.readCalls; // B4 单击球本就该 read，这里只看增量
  await act(`(function () {
    var b = document.getElementById('ball');
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 20, screenX: 100, screenY: 100 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, screenX: 140, screenY: 118 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, screenX: 140, screenY: 118 }));
    return true;
  })()`);
  const sawDragMove = rec.bridge.some((m) => m.kind === 'dragMove' && m.payload && Math.abs(m.payload.dx) > 5);
  const sawDragEnd = rec.bridge.some((m) => m.kind === 'dragEnd');
  const sawRead = rec.bridge.some((m) => m.kind === 'cmd' && m.payload && m.payload.cmd === 'read');
  check('B6 拖拽未被吞（dragMove>5px + dragEnd 都到主进程）', sawDragMove && sawDragEnd);
  check('B6 拖拽结束 → 主进程 focusable 仍为 false', win.isFocusable() === false && lastFocusable() === false);
  check(
    'B6 拖拽后没有触发 read',
    sawRead === false && rec.readCalls === readBeforeDrag,
    `readCalls +${rec.readCalls - readBeforeDrag}`,
  );
  check('B6 拖拽全程没夺焦', rec.focusCount === 0 && !win.isFocused());

  w.destroy();
}

// ---------------------------------------------------------------- 入口
app.whenReady().then(async () => {
  let floatBall = null;
  try {
    floatBall = loadFloatBall();
    ipcMain.on('probe:bridge', (_e, msg) => {
      if (!msg || !msg.kind) return;
      rec.bridge.push(msg);
      if (msg.kind === 'cmd') floatBall.handleCmd(msg.payload);
      else if (msg.kind === 'dragStart') floatBall.handleDragStart();
      else if (msg.kind === 'dragMove') floatBall.handleDragMove(msg.payload);
      else if (msg.kind === 'dragEnd') floatBall.handleDragEnd();
    });

    await mainSection(floatBall);
    await domSection(floatBall);
  } catch (e) {
    log('PROBE ERROR: ' + ((e && e.stack) || e));
    results.push({ name: 'probe 未抛异常', ok: false });
  }

  const bad = results.filter((r) => !r.ok);
  log('');
  log(bad.length ? `RESULT: FAIL ${bad.length}/${results.length}` : `RESULT: ALL PASS ${results.length}/${results.length}`);
  try {
    if (floatBall) floatBall.dispose();
  } catch (e) {
    /* noop */
  }
  app.exit(bad.length ? 1 : 0);
});
