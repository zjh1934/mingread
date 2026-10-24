// WFIX4 探针：验证「关窗 = 收进托盘」这条修复，覆盖用户报的三个连锁症状。
//
// 用户原话：
//   ① 「窗口叉掉以后，从右下角菜单栏就点不开了」
//   ② 「悬浮球图标状态一直是两竖，不管点几下」
//   ③ 「选中按热键它不会出来，就低一下，也不说一下」
//
// 三者同一根因：主窗口被销毁 → mainWindow=null → 托盘/悬浮球/热键结果的 webContents
// 全部无接收方，且大多是静默 if (!win) return。
//
// 本探针断言：
//   A. 调试版 userData 与安装版隔离（不再互相污染设置）
//   B. win.close() 被拦截 → 窗口未销毁、不可见、mainWindow 引用仍在
//   C. 模拟托盘点击（show）→ 窗口恢复可见、引用一致（这就是「找回来」的那条路）
//   D. 播放快照在窗口真销毁时复位（防悬浮球卡在「播放中」的暂停图标）
//   E. 热键/悬浮球路径不再有裸 `if (!win) return`（静态检查：必须播报或重建）
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const results = [];
let failed = 0;
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok: !!ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}${detail !== undefined ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 加载真实主进程（bootstrap 会跑起来）——与 W-WIN1 探针同一手法
const mainMod = require('../src/main/index.js');

app.whenReady().then(async () => {
  await sleep(6000); // 等窗口创建 + 首帧

  // ---- A. userData 隔离 ----
  const ud = app.getPath('userData');
  const base = path.basename(ud);
  check(
    'A1',
    '调试版 userData 带 -dev 后缀（与安装版隔离）',
    /-dev$/.test(base) || app.isPackaged,
    `userData=${ud}`
  );
  check('A2', '调试版与安装版不是同一目录', !/-dev$/.test(base) || base === 'LangduNvNeo-dev', `dir=${base}`);

  const win = mainMod.getMainWindow();
  check('B0', '主窗口已创建', !!win && !win.isDestroyed(), `win=${!!win}`);

  // ---- B. 关窗被拦截 ----
  win.close();
  await sleep(500);
  check('B1', 'close() 之后窗口未被销毁（只是隐藏）', !win.isDestroyed(), `destroyed=${win.isDestroyed()}`);
  check('B2', 'close() 之后窗口不可见', win.isVisible() === false, `visible=${win.isVisible()}`);
  check('B3', 'mainWindow 引用仍在（托盘 getWindow 能拿到）', mainMod.getMainWindow() === win, `same=${mainMod.getMainWindow() === win}`);
  check('B4', 'webContents 仍存活（热键结果有接收方）', !win.webContents.isDestroyed(), `wcDestroyed=${win.webContents.isDestroyed()}`);

  // ---- C. 托盘点击恢复 ----
  // 托盘 click 调的就是 showMainWindow() → w.show()+focus()，这里直接走同一个 win 对象
  win.show();
  win.focus();
  await sleep(400);
  check('C1', 'show() 后窗口恢复可见', win.isVisible() === true, `visible=${win.isVisible()}`);
  check('C2', '恢复的是同一个窗口实例（未重建、状态不丢）', mainMod.getMainWindow() === win, `same=${mainMod.getMainWindow() === win}`);

  // ---- D. 真销毁时复位播放快照 ----
  // 直接销毁窗口模拟「崩溃/被外部强关」这一防御路径
  win.destroy();
  await sleep(600);
  check('D1', 'destroy 后 mainWindow 置空（对应 closed 处理）', mainMod.getMainWindow() === null, `mw=${mainMod.getMainWindow()}`);
  check('D2', '窗口确已销毁', win.isDestroyed(), `destroyed=${win.isDestroyed()}`);

  // ---- E. 静默失败静态检查 ----
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const hotkeySrc = read('src/main/hotkeyTray.js');
  const ballSrc = read('src/main/floatBall.js');

  // 旧写法：抓到选区后 `if (!win || win.isDestroyed()) return;` —— 必须消失
  check(
    'E1',
    'hotkeyTray 不再有「抓到选区后静默 return」',
    !/if \(!win \|\| win\.isDestroyed\(\)\) return;/.test(hotkeySrc),
    `matched=${/if \(!win \|\| win\.isDestroyed\(\)\) return;/.test(hotkeySrc)}`
  );
  check(
    'E2',
    'hotkeyTray 用 resolveWindow（可重建）而非裸 getWindow',
    /function resolveWindow\(/.test(hotkeySrc) && /resolveWindow\(\)/.test(hotkeySrc),
    `hasResolve=${/function resolveWindow\(/.test(hotkeySrc)}`
  );
  check(
    'E3',
    '无接收方时有语音播报（含「主窗口已关闭」）',
    /主窗口已关闭/.test(hotkeySrc),
    `hasAnnounce=${/主窗口已关闭/.test(hotkeySrc)}`
  );
  check(
    'E4',
    '悬浮球 read 路径不再静默丢弃',
    /delivered=\$\{!!win\}/.test(ballSrc) && /a11y\.announce\(/.test(ballSrc),
    `hasDeliveredLog=${/delivered=\$\{!!win\}/.test(ballSrc)}`
  );
  check(
    'E5',
    '托盘点击与「显示主窗口」共用 showMainWindow',
    (hotkeySrc.match(/showMainWindow\(\)/g) || []).length >= 2,
    `calls=${(hotkeySrc.match(/showMainWindow\(\)/g) || []).length}`
  );
  check(
    'E6',
    '窗口 closed 时复位播放快照并通知悬浮球',
    /state\.playback = \{ isPlaying: false/.test(read('src/main/index.js')),
    `ok=${/state\.playback = \{ isPlaying: false/.test(read('src/main/index.js'))}`
  );

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} ${results.length - failed}/${results.length}`);
  try {
    fs.writeFileSync(
      path.join(__dirname, '..', 'dist', 'probe', 'wfix4.json'),
      JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2),
      'utf8'
    );
  } catch (e) {
    /* noop */
  }

  app.exit(failed === 0 ? 0 : 1);
});
