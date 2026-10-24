// 验证「Alt + 滚轮」的连续推进手感（对齐 macOS 的 Ctrl+滚轮）。
//
// 旧行为：每格固定 ×1.16（跳档），滚 3 格就 1.56x，细调困难。
// 新行为：按滚动量做指数缩放（120/格 → ×1.12），触控板的小 delta 自然变成连续微调。
//
// 断言：
//   A. 每格增量 ≈ 1.12 且单调递增（不是跳档）
//   B. 滚 6 格落在 1.9~2.05（1.12^6 ≈ 1.97）
//   C. 反向滚到底会自动退出放大（与 macOS 一致：缩回 1x 即退出）
//   D. 推进后画面确实变化（桌面截屏对比）
//   E. 高精度滚轮的超大 delta 被限幅（不会一次冲到最大倍率）
'use strict';

const fs = require('fs');
const path = require('path');
const { app, desktopCapturer } = require('electron');

const OUT = path.join(__dirname, '..', 'dist', 'probe');
const results = [];
let failed = 0;
function check(id, desc, ok, detail) {
  results.push({ id, desc, ok: !!ok, detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}${detail !== undefined ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require('../src/main/index.js');

async function shot(name) {
  await sleep(650);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  if (!sources.length) return null;
  const png = sources[0].thumbnail.toPNG();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), png);
  return png;
}

app.whenReady().then(async () => {
  await sleep(4500);
  // eslint-disable-next-line global-require
  const zc = require('../src/main/zoomController').getZoomController();
  if (!zc) {
    check('A0', '取到实例', false);
    app.exit(1);
    return;
  }
  check('A0', '取到实例', true, `renderBackend=${zc.state.renderBackend}`);

  zc.activate();
  await sleep(900);
  check('A1', '激活', zc.state.active === true, `zoom=${zc.state.zoom.toFixed(2)}`);

  const before = await shot('wheel-before.png');

  // 连滚 6 格（每格 120），记录 target 与平滑后的值
  // 注意：activate() 的起始倍率是 2（zoomMin<=1 时的设计值），不是 1 —— 断言必须以此为基线
  const z0 = zc.state.targetZoom;
  const seq = [];
  for (let i = 0; i < 6; i += 1) {
    zc.onWheel(120);
    seq.push(Number(zc.state.targetZoom.toFixed(3)));
    await sleep(120);
  }
  await sleep(1000);
  const zAfter = zc.state.zoom;
  console.log(`[wheel] 起始=${z0} 目标序列: ${seq.join(' → ')}`);
  console.log(`[wheel] 平滑后 zoom=${zAfter.toFixed(3)}`);

  // A. 每格比例（第一格相对起始值）
  const ratios = seq.map((v, i) => v / (i === 0 ? z0 : seq[i - 1]));
  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  check('A2', '每格增量约 1.12（连续推进，不是跳档）', Math.abs(avgRatio - 1.12) < 0.03, `avg=${avgRatio.toFixed(3)}`);
  check('A3', '倍率单调递增', seq.every((v, i) => i === 0 || v > seq[i - 1]), seq.join(','));

  // B. 6 格后的理论值
  const expected = z0 * 1.12 ** 6;
  check('B1', `滚 6 格后约 ${expected.toFixed(2)}（起始×1.12^6）`, Math.abs(zAfter - expected) < 0.25, `zoom=${zAfter.toFixed(3)} 期望=${expected.toFixed(3)}`);

  const after = await shot('wheel-after.png');
  const lenDiff = before && after ? Math.abs(after.length - before.length) / Math.max(after.length, before.length) : -1;
  check('D1', '推进后画面变化', lenDiff > 0.02, `lenDiff=${(lenDiff * 100).toFixed(1)}%`);

  // E. 限幅：模拟高精度滚轮一次报 2000
  const zBeforeBig = zc.state.targetZoom;
  zc.onWheel(2000);
  const zAfterBig = zc.state.targetZoom;
  const rr = zAfterBig / zBeforeBig;
  check('E1', '超大 delta 被限幅（≤ ×1.4）', rr <= 1.45, `${zBeforeBig.toFixed(2)} → ${zAfterBig.toFixed(2)} (×${rr.toFixed(2)})`);

  // C. 反向滚到底 → 自动退出
  for (let i = 0; i < 20; i += 1) {
    if (!zc.state.active) break;
    zc.onWheel(-120);
    await sleep(90);
  }
  await sleep(1200);
  check('C1', '反向滚到底自动退出放大', zc.state.active === false, `active=${zc.state.active} zoom=${zc.state.zoom.toFixed(2)}`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} ${results.length - failed}/${results.length}`);
  try {
    fs.writeFileSync(path.join(OUT, 'wheel-probe.json'), JSON.stringify({ at: new Date().toISOString(), failed, seq, zAfter, results }, null, 2));
  } catch (e) {
    /* noop */
  }
  app.exit(failed === 0 ? 0 : 1);
});
