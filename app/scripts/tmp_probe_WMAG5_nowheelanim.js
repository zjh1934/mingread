// 验证滚轮缩放「无动画」：滚一格后 state.zoom 必须立刻等于 targetZoom（不留平滑拖尾）。
'use strict';
const { app } = require('electron');
const results = [];
let failed = 0;
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok: !!ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}${detail !== undefined ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
require('../src/main/index.js');

app.whenReady().then(async () => {
  await sleep(4500);
  // eslint-disable-next-line global-require
  const zc = require('../src/main/zoomController').getZoomController();
  if (!zc) { check('A0', '取到实例', false); app.exit(1); return; }
  zc.activate();
  await sleep(900);

  // 滚一格，立刻读（不等任何延时）
  const before = zc.state.zoom;
  zc.onWheel(120);
  const afterSync = zc.state.zoom;      // 同步读取：应已等于 target
  const target = zc.state.targetZoom;
  check('A1', '滚一格后 zoom 立即等于 target（无平滑拖尾）', Math.abs(afterSync - target) < 1e-6, `zoom=${afterSync.toFixed(4)} target=${target.toFixed(4)}`);
  check('A2', '倍率确实变了', afterSync > before + 0.01, `${before.toFixed(3)} → ${afterSync.toFixed(3)}`);

  await sleep(400);
  check('A3', '400ms 后仍等于 target（没有回弹）', Math.abs(zc.state.zoom - zc.state.targetZoom) < 1e-6, `zoom=${zc.state.zoom.toFixed(4)}`);

  // 连续滚十格：每格都应即时生效
  let allInstant = true;
  for (let i = 0; i < 10; i += 1) {
    zc.onWheel(120);
    if (Math.abs(zc.state.zoom - zc.state.targetZoom) > 1e-6) { allInstant = false; break; }
  }
  check('A4', '连续 10 格每格即时生效', allInstant, `zoom=${zc.state.zoom.toFixed(3)}`);

  zc.reset();
  await sleep(800);
  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} ${results.length - failed}/${results.length}`);
  app.exit(failed === 0 ? 0 : 1);
});
