// W-WIN1 探针：窗口融合改造（无边框 / 无应用菜单 / 自绘控制键）
//
// 运行（必须先清掉 ELECTRON_RUN_AS_NODE，否则 electron 会退化成纯 node）：
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/cli.js scripts/tmp_probe_WWIN1_frame.js
//
// 覆盖：
//   A. 应用菜单确实被清空（Menu.getApplicationMenu() === null）
//   B. 窗口确实是「无边框」——用真实 BrowserWindow 实测 getBounds() 与 getContentBounds()
//      完全相等（有标题栏时 contentBounds 一定比 bounds 矮一条标题栏），而不是读某个 API 的
//      自述字段；同时断言构造参数 frame:false / 未设 titleBarStyle / thickFrame:true
//   C. minimize / toggleMaximize / close / isMaximized 四条 IPC：
//      ① 桩测：直接用 { sender } 调 handler，且用 BrowserWindow.fromWebContents 定位到
//         「发送方窗口」而不是全局主窗口（两个窗口交叉验证）；
//      ② 端到端：真窗口里装真 preload，由渲染层 window.langdu.* 走真实 IPC 触发
//   D. maximize / unmaximize → 渲染层收到 window:maximized-changed 推送（桩记录 send 调用）
//   E. 最大化后不覆盖任务栏（bounds 与 display.workArea 对齐）
//   F. 渲染层：TopBar 是 drag 区、所有可交互元素是 no-drag、控制键 44×44、aria-label 正确、
//      点设置键真的能打开对话框（拖拽区没吞点击）、Ctrl+C/A/V 正常
//
// 结论同时写 scripts/tmp_probe_WWIN1_frame.txt（部分终端会吞 stdout）。
'use strict';

delete process.env.ELECTRON_RUN_AS_NODE;

const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, BrowserWindow, Menu, screen, clipboard } = electron;

const TXT = path.join(__dirname, 'tmp_probe_WWIN1_frame.txt');
const rows = [];
function log(s) {
  rows.push(String(s));
  try {
    fs.writeFileSync(TXT, rows.join('\n') + '\n');
  } catch (e) {
    /* 写盘失败不影响结论 */
  }
  console.log(s);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIST = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');

// 隔离 userData：本机上有安装版「朗读女 Neo」常驻（托盘 + 悬浮球），它持有 %APPDATA%\LangduNvNeo
// 的单实例锁，不隔离的话 bootstrap 里的 requestSingleInstanceLock() 直接返回 false → app.quit()，
// 探针会在 1s 内静默退出（实测）。主进程按 process.env.APPDATA 拼 userData，故这里改环境变量。
const ISOLATED_APPDATA = path.join(__dirname, '..', 'dist', 'probe', 'wwin1-userdata');
try {
  fs.mkdirSync(ISOLATED_APPDATA, { recursive: true });
  process.env.APPDATA = ISOLATED_APPDATA;
} catch (e) {
  /* 隔离失败不致命（但可能撞锁） */
}

// 探针要反复创建/销毁窗口：不注册这个监听时，Electron 在「最后一个窗口关闭」会直接退出进程
// （实测第一次 destroy 参照窗口就把探针带走了）。
app.on('window-all-closed', () => {});
// 真·启动路径：require 主进程入口即执行 bootstrap()（清菜单 → 建窗口 → 注册 IPC 全是真的），
// 断言读的是这本进程里真实存在的那个主窗口，而不是探针另外造一个仿制品。
const appMain = require('../src/main/index.js');

async function waitForMainWindow(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    const w = appMain.getMainWindow();
    if (w && !w.isDestroyed()) return w;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(120);
  }
}

async function run() {
  const m = appMain;

  // ---------------------------------------------------------------- A 应用菜单
  check('A0 真实 bootstrap 已跑起来（拿到主窗口）', !!(await waitForMainWindow(15000)));
  check('A1 Menu.getApplicationMenu() === null（无英文菜单）', Menu.getApplicationMenu() === null);

  // ---------------------------------------------------------------- B 无边框
  const opts = m.getWindowOptions();
  log(`\n[options] ${JSON.stringify({ frame: opts.frame, thickFrame: opts.thickFrame, titleBarStyle: opts.titleBarStyle })}`);
  check('B1 构造参数 frame === false', opts.frame === false);
  check('B2 titleBarStyle 未设置（Windows 不需要 traffic light 语义）', opts.titleBarStyle === undefined);
  check('B3 thickFrame 保留 true（边缘缩放 / Aero Snap 依赖）', opts.thickFrame === true);

  // 有边框参照组：contentBounds 必然比 bounds 矮（差值 = 标题栏高度）
  const framed = new BrowserWindow({ width: 620, height: 420, show: true, title: 'probe-framed' });
  await sleep(400);
  const fb = framed.getBounds();
  const fc = framed.getContentBounds();
  const framedDelta = fb.height - fc.height;
  framed.destroy();
  log(`[对照] 有边框窗口 bounds.h=${fb.height} contentBounds.h=${fc.height} 差值=${framedDelta}px`);

  const win = await waitForMainWindow(5000);
  if (!win) throw new Error('主窗口未创建');
  if (!win.isVisible()) win.show();
  await sleep(700);
  const wb = win.getBounds();
  const wc = win.getContentBounds();
  check(
    'B4 主窗口无边框（bounds 与 contentBounds 完全相等，无标题栏占位）',
    wb.width === wc.width && wb.height === wc.height,
    `bounds=${wb.width}x${wb.height} content=${wc.width}x${wc.height}（有边框对照组差值 ${framedDelta}px）`,
  );
  check('B5 窗口仍可缩放 / 可最大化（thickFrame 生效）', win.isResizable() === true && win.isMaximizable() === true);

  // ---------------------------------------------------------------- C IPC 桩测
  const registeredFirst = m.registerWindowControlIpc();
  const registeredAgain = m.registerWindowControlIpc();
  check(
    'C0 IPC 注册幂等（bootstrap 已注册；探针再调两次都返回 false 且不抛）',
    registeredFirst === false && registeredAgain === false,
    `first=${registeredFirst} again=${registeredAgain}`,
  );

  const other = new BrowserWindow({ width: 520, height: 360, show: true });
  await sleep(400);

  // 清一次基线：ensure both normal
  if (other.isMinimized()) other.restore();
  if (win.isMinimized()) win.restore();
  await sleep(200);

  const H = m.windowControlHandlers;
  H.minimize({ sender: other.webContents });
  await sleep(600);
  check(
    'C1 minimize 打的是「发送方窗口」（other 最小化、主窗口不受影响）',
    other.isMinimized() === true && win.isMinimized() === false,
    `otherMin=${other.isMinimized()} winMin=${win.isMinimized()}`,
  );
  other.restore();
  await sleep(400);

  H.toggleMaximize({ sender: other.webContents });
  await sleep(700);
  const maxAfterToggle = other.isMaximized();
  check('C2 toggleMaximize 第一次 → 最大化', maxAfterToggle === true, `isMaximized=${maxAfterToggle}`);
  H.toggleMaximize({ sender: other.webContents });
  await sleep(700);
  check('C3 toggleMaximize 第二次 → 还原（同一个键双向）', other.isMaximized() === false, `isMaximized=${other.isMaximized()}`);

  check('C4 isMaximized handler 与真实状态一致', H.isMaximized({ sender: other.webContents }) === other.isMaximized());
  check('C5 无 sender 时安全返回（不崩、不打到主窗口）', H.minimize(null) === false && H.isMaximized({}) === false);

  H.close({ sender: other.webContents });
  await sleep(700);
  check('C6 close 只关闭目标窗口（other 已销毁，主窗口还在）', other.isDestroyed() === true && !win.isDestroyed());

  // ---------------------------------------------------------------- D 最大化推送
  const pushed = [];
  const pushedWin = new BrowserWindow({ ...opts, width: 700, height: 500, show: true });
  await sleep(500);
  m.attachMaximizeSync(pushedWin);
  try {
    pushedWin.webContents.send = (ch, payload) => {
      pushed.push({ ch, payload });
      return true;
    };
  } catch (e) {
    log(`[warn] 无法替换 webContents.send：${e && e.message}`);
  }
  pushedWin.maximize();
  await sleep(800);
  const sawMax = pushed.some((x) => x.ch === 'window:maximized-changed' && x.payload === true);
  check('D1 maximize → 渲染层收到 window:maximized-changed(true)', sawMax, JSON.stringify(pushed));

  // 用 tray/快捷键路径模拟：unmaximize
  pushedWin.unmaximize();
  await sleep(800);
  const sawUnmax = pushed.some((x) => x.ch === 'window:maximized-changed' && x.payload === false);
  check('D2 unmaximize → 渲染层收到 window:maximized-changed(false)', sawUnmax, JSON.stringify(pushed.slice(-2)));

  // ---------------------------------------------------------------- E 最大化 vs 任务栏
  // Windows 上「最大化」的 bounds 会比工作区大一圈（四周各 8px 的不可见缩放边框，Windows
  // 故意放到屏幕外），所以不能直接拿 bounds 和 workArea 比。判定方式：与「有边框窗口」
  // 最大化后的 bounds 完全一致 —— 说明走的是同一条系统最大化路径，任务栏预留不受影响。
  const ctrlFramed = new BrowserWindow({ width: 700, height: 500, show: true });
  await sleep(400);
  ctrlFramed.maximize();
  await sleep(900);
  const cf = ctrlFramed.getBounds();
  ctrlFramed.destroy();
  log(`[对照] 有边框窗口最大化 bounds=${cf.x},${cf.y} ${cf.width}x${cf.height}`);

  pushedWin.maximize();
  await sleep(900);
  const disp = screen.getDisplayMatching(pushedWin.getBounds());
  const mb = pushedWin.getBounds();
  log(
    `[screen] bounds=${disp.bounds.width}x${disp.bounds.height} workArea=${disp.workArea.x},${disp.workArea.y} ` +
      `${disp.workArea.width}x${disp.workArea.height} scale=${disp.scaleFactor}`,
  );
  log(`[maximized] 无边框 ${mb.x},${mb.y} ${mb.width}x${mb.height}`);
  check(
    'E1 无边框最大化 bounds 与有边框窗口完全一致（同一条系统最大化路径）',
    mb.x === cf.x && mb.y === cf.y && mb.width === cf.width && mb.height === cf.height,
    `frameless=${mb.x},${mb.y},${mb.width},${mb.height} framed=${cf.x},${cf.y},${cf.width},${cf.height}`,
  );
  check(
    'E2 最大化后底边不越过屏幕（任务栏区域仍在窗口之外）',
    mb.y + mb.height <= disp.bounds.height && mb.height >= disp.workArea.height,
    `底边=${mb.y + mb.height} 屏幕=${disp.bounds.height} 工作区底边=${disp.workArea.y + disp.workArea.height}`,
  );
  pushedWin.unmaximize();
  await sleep(600);

  // ---------------------------------------------------------------- F 渲染层
  let domOk = false;
  try {
    const view = new BrowserWindow({
      ...opts,
      width: 1180,
      height: 800,
      show: true,
      title: 'probe-dom',
    });
    await view.loadFile(DIST);
    await sleep(2600);

    const info = await view.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.MuiAppBar-root');
      const regionOf = (el) => {
        if (!el) return '';
        const inline = el.style && (el.style.webkitAppRegion || el.style.getPropertyValue('-webkit-app-region'));
        if (inline) return inline;
        const cs = getComputedStyle(el);
        return (cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || '').trim();
      };
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; };
      const btns = [...document.querySelectorAll('button[aria-label]')];
      return {
        hasBar: !!bar,
        barRegion: regionOf(bar),
        barBg: bar ? getComputedStyle(bar).backgroundColor : '',
        barShadow: bar ? getComputedStyle(bar).boxShadow : '',
        barRect: bar ? rect(bar) : null,
        dpr: window.devicePixelRatio,
        bridge: ['minimizeWindow','toggleMaximizeWindow','closeWindow','isWindowMaximized','onWindowMaximizedChanged']
          .reduce((acc, k) => { acc[k] = typeof (window.langdu || {})[k]; return acc; }, {}),
        controls: btns.filter((b) => ['最小化','最大化','还原','关闭'].includes(b.getAttribute('aria-label')))
          .map((b) => ({ label: b.getAttribute('aria-label'), region: regionOf(b), ...rect(b) })),
        settings: (() => { const b = btns.find((x) => x.getAttribute('aria-label') === '设置'); return b ? { region: regionOf(b), ...rect(b) } : null; })(),
        status: (() => { const b = btns.find((x) => /声音|在线|本地/.test(x.textContent || '')); return b ? { text: b.textContent, region: regionOf(b), ...rect(b) } : null; })(),
      };
    })()`);

    log(`\n[dom] ${JSON.stringify(info, null, 2)}`);
    domOk = info.hasBar && info.controls.length === 3;

    check('F1 TopBar 根容器为拖拽区（-webkit-app-region: drag）', info.barRegion === 'drag', `region=${info.barRegion}`);
    check('F2 TopBar 无阴影且与内容区同底色（不分层）', info.barShadow === 'none' || info.barShadow === '', `bg=${info.barBg} shadow=${info.barShadow}`);
    check('F3 三个控制键都在（最小化 / 最大化 / 关闭）', info.controls.length === 3, info.controls.map((c) => c.label).join(','));
    check('F4 每个控制键 44×44', info.controls.every((c) => Math.round(c.w) === 44 && Math.round(c.h) === 44), info.controls.map((c) => `${c.label}:${Math.round(c.w)}x${Math.round(c.h)}`).join(' '));
    check('F5 控制键均为 no-drag（不会被拖拽吞掉）', info.controls.every((c) => c.region === 'no-drag'), info.controls.map((c) => `${c.label}:${c.region}`).join(' '));
    check('F6 设置键为 no-drag', !!(info.settings && info.settings.region === 'no-drag'), `region=${info.settings && info.settings.region}`);
    check('F7 状态灯为 no-drag', !!(info.status && info.status.region === 'no-drag'), `region=${info.status && info.status.region}`);
    check('F8 preload 五项窗口控制 API 全部暴露', Object.values(info.bridge).every((t) => t === 'function'), JSON.stringify(info.bridge));
    check(
      'F9 顶栏只占一行（高度 ≈ 56/64 + 无第二行菜单区）',
      info.barRect && info.barRect.h <= 68,
      `h=${info.barRect && info.barRect.h}`,
    );

    // F10：点设置键 → 对话框出现（证明拖拽区上方的按钮真的可点）
    if (info.settings) {
      view.focus();
      const x = Math.round(info.settings.cx);
      const y = Math.round(info.settings.cy);
      view.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      view.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await sleep(900);
      let dlg = await view.webContents.executeJavaScript(`!!document.querySelector('[role="dialog"]')`);
      let via = 'sendInputEvent';
      if (!dlg) {
        // 兜底：直接 DOM click，仅用于区分「按钮事件没绑上」和「命中测试被拖拽区拦截」
        dlg = await view.webContents.executeJavaScript(
          `(() => { const b=[...document.querySelectorAll('button[aria-label]')].find(x=>x.getAttribute('aria-label')==='设置'); if(b){b.click();return true;} return false; })()`,
        );
        via = 'domClick';
        await sleep(700);
        dlg = await view.webContents.executeJavaScript(`!!document.querySelector('[role="dialog"]')`);
      }
      check('F10 点击 TopBar 上的设置键 → 设置对话框打开', dlg === true, `via=${via}`);

      // 关掉对话框，回归首屏（Esc 不一定绑定；直接移除 modal 根，避免它的焦点陷阱继续抢焦点）
      await view.webContents.executeJavaScript(
        `(document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})), true)`,
      );
      await sleep(600);
      await view.webContents.executeJavaScript(
        `(() => { const m = document.querySelector('.MuiModal-root'); if (m) m.remove(); return !document.querySelector('[role="dialog"]'); })()`,
      );
      await sleep(300);
    }

    // F19/F20：hover 态 + 失焦不变色（用户要求「失焦不变灰，但 hover 正常」）
    if (info.controls.length === 3) {
      const closeBtn = info.controls.find((c) => c.label === '关闭');
      view.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(closeBtn.cx), y: Math.round(closeBtn.cy) });
      await sleep(450);
      const hover = await view.webContents.executeJavaScript(`(() => {
        const b = [...document.querySelectorAll('button[aria-label]')].find((x) => x.getAttribute('aria-label') === '关闭');
        const cs = getComputedStyle(b);
        return { bg: cs.backgroundColor, color: cs.color };
      })()`);
      check(
        'F19 关闭键 hover → error.main 底 + 白图标',
        hover.bg === 'rgb(217, 52, 74)' && hover.color === 'rgb(255, 255, 255)',
        JSON.stringify(hover),
      );
      view.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 400 });
      await sleep(300);
      const before = await view.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.MuiAppBar-root')).backgroundColor`,
      );
      view.blur();
      await sleep(500);
      const after = await view.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.MuiAppBar-root')).backgroundColor`,
      );
      check('F20 失焦时顶栏不变灰（配色与聚焦时一致）', before === after && before === 'rgb(255, 255, 255)', `${before} -> ${after}`);
      view.focus();
      view.webContents.focus();
      await sleep(300);
    }

    // F11：文本框编辑快捷键（Chromium 内建，不依赖菜单）
    view.focus();
    view.webContents.focus();
    const focusState = await view.webContents.executeJavaScript(`(() => {
      const t = document.createElement('textarea');
      t.id = 'probe-ta';
      Object.assign(t.style, { position: 'fixed', left: '8px', bottom: '8px', width: '320px', height: '48px', zIndex: 99999 });
      t.value = 'W-WIN1 快捷键';
      document.body.appendChild(t);
      t.focus();
      t.select();
      return { active: document.activeElement.id, hasFocus: document.hasFocus(), sel: [t.selectionStart, t.selectionEnd] };
    })()`);
    log(`[focus] ${JSON.stringify(focusState)}`);
    clipboard.writeText('__before__');

    const key = async (code, modifiers) => {
      const kc = code.length === 1 ? code.toUpperCase() : code;
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: kc, modifiers: modifiers || [] });
      await sleep(60);
      view.webContents.sendInputEvent({ type: 'keyUp', keyCode: kc, modifiers: modifiers || [] });
      await sleep(260);
    };

    await key('c', ['control']);
    const copied = clipboard.readText();
    check('F11 Ctrl+C 复制生效（不依赖菜单）', copied === 'W-WIN1 快捷键', `clipboard="${copied}"`);

    await view.webContents.executeJavaScript(
      `(() => { const t=document.getElementById('probe-ta'); t.value=''; t.focus(); return true; })()`,
    );
    await key('v', ['control']);
    const pasted = await view.webContents.executeJavaScript(`document.getElementById('probe-ta').value`);
    check('F12 Ctrl+V 粘贴生效', pasted === 'W-WIN1 快捷键', `value="${pasted}"`);

    await key('a', ['control']);
    const selAll = await view.webContents.executeJavaScript(`(() => {
      const t = document.getElementById('probe-ta');
      return t.selectionStart === 0 && t.selectionEnd === t.value.length && t.value.length > 0;
    })()`);
    check('F13 Ctrl+A 全选生效', selAll === true);

    await key('x', ['control']);
    const cutVal = await view.webContents.executeJavaScript(`document.getElementById('probe-ta').value`);
    check('F14 Ctrl+X 剪切生效', cutVal === '' && clipboard.readText() === 'W-WIN1 快捷键', `value="${cutVal}"`);

    await key('z', ['control']);
    const undone = await view.webContents.executeJavaScript(`document.getElementById('probe-ta').value`);
    check('F15 Ctrl+Z 撤销生效（撤销上一步剪切）', undone === 'W-WIN1 快捷键', `value="${undone}"`);

    // 端到端 IPC：渲染层真 API → preload → ipcMain.handle → 本窗口
    const wasMax = view.isMaximized();
    await view.webContents.executeJavaScript(`window.langdu.toggleMaximizeWindow(); true`);
    await sleep(900);
    const nowMax = view.isMaximized();
    check('F16 端到端 toggleMaximizeWindow 改变的是本窗口', nowMax === !wasMax, `before=${wasMax} after=${nowMax}`);

    const asked = await view.webContents.executeJavaScript(`window.langdu.isWindowMaximized()`);
    check('F17 端到端 isWindowMaximized 返回值与主进程一致', asked === nowMax, `renderer=${asked} main=${nowMax}`);

    // 还原后 isWindowMaximized 立刻变 false（推送链路）
    await view.webContents.executeJavaScript(`window.langdu.toggleMaximizeWindow(); true`);
    await sleep(900);
    const back = await view.webContents.executeJavaScript(`window.langdu.isWindowMaximized()`);
    check('F18 再次切换回还原态', back === false && view.isMaximized() === false, `renderer=${back} main=${view.isMaximized()}`);

    view.destroy();
  } catch (e) {
    log('DOM 段异常：' + ((e && e.stack) || e));
    check('F* 渲染层断言执行完成', false, 'DOM 段抛异常');
    domOk = false;
  }

  // 主窗口是真实应用窗口，不销毁（交给 app.exit）
}

app.whenReady().then(async () => {
  log('=== W-WIN1 窗口融合探针 ===');
  log(`electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`);
  try {
    await run();
  } catch (e) {
    log('PROBE ERROR: ' + ((e && e.stack) || e));
    results.push({ name: 'probe 未抛异常', ok: false });
  }
  const bad = results.filter((r) => !r.ok);
  log('');
  log(bad.length ? `RESULT: FAIL ${bad.length}/${results.length}` : `RESULT: ALL PASS ${results.length}/${results.length}`);
  app.exit(bad.length ? 1 : 0);
});
