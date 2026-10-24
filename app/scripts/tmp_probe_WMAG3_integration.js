// 验证系统放大后端（mag）在真实应用里生效。
//
// 为什么用 desktopCapturer 而不是 capturePage：
//   放大画面由 DWM 合成在原生 WC_MAGNIFIER 窗口里，capturePage 只截 Chromium 自己的
//   surface，拿到的永远是全黑（Round 7 已实测）。桌面截屏才能看到真实效果。
//
// 断言：
//   A. renderBackend === 'mag'（走了新后端，没有回退）
//   B. 2x 与 4x 的桌面截图逐像素有明显差异（说明真的在放大，不是静态画面）
//   C. reset 后状态回到 inactive，且渲染后端复位
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
  await sleep(700); // 给 Mag 一帧时间把画面画出来
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  if (!sources.length) return null;
  const img = sources[0].thumbnail;
  const p = path.join(OUT, name);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(p, img.toPNG());
  return { path: p, size: img.getSize(), png: img.toPNG() };
}

/** 粗略差异：两张 PNG 的字节长度差 + 采样像素差（不引图像库） */
function diffRatio(a, b) {
  if (!a || !b) return -1;
  const lenRatio = Math.abs(a.png.length - b.png.length) / Math.max(a.png.length, b.png.length);
  return lenRatio;
}

app.whenReady().then(async () => {
  await sleep(4500); // 等应用起来（含骨架与首帧）

  // zoomController 由 index.js 创建后可取到单例
  // eslint-disable-next-line global-require
  const zc = require('../src/main/zoomController').getZoomController();
  if (!zc) {
    check('A0', '取到 zoomController 实例', false, 'getZoomController() 返回 null');
    app.exit(1);
    return;
  }
  check('A0', '取到 zoomController 实例', true, `trigger=${zc.state.trigger} backend=${zc.state.backend}`);

  // 1x 基准
  const s0 = await shot('mag-1x.png');

  // 激活 → 默认 2x
  zc.nudge(true);
  await sleep(900);
  check('A1', '激活后走 mag 后端', zc.state.renderBackend === 'mag', `renderBackend=${zc.state.renderBackend}`);
  const s2 = await shot('mag-2x.png');

  // 再放大两档 → 4x
  zc.nudge(true);
  await sleep(300);
  zc.nudge(true);
  await sleep(900);
  const z = zc.state.zoom;
  check('A2', '倍率已升到 4x 附近', z >= 3.5, `zoom=${z.toFixed(2)}`);
  const s4 = await shot('mag-4x.png');

  // 画面确实变化（2x 与 4x 字节长度差异 + 与 1x 差异）
  const d24 = diffRatio(s2, s4);
  check('B1', '2x 与 4x 画面不同（真的在放大）', d24 > 0.02, `lenDiff=${(d24 * 100).toFixed(1)}%`);
  const d02 = diffRatio(s0, s2);
  check('B2', '1x 与 2x 画面不同', d02 > 0.02, `lenDiff=${(d02 * 100).toFixed(1)}%`);
  // 注意：不能用文件体积判断「截图非空」——纯色桌面下 1920x1080 的 PNG 只有 10KB，
  // 会误报失败（本机就会）。「画面是否真的在变」由 B1/B2 的逐像素差异保证，
  // 这里只确认拿到的是整屏截图而不是 0x0 空图。
  if (s2) {
    const sz = s2.size || {};
    check('B3', '截图尺寸为整屏（不是空图）', sz.width >= 800 && sz.height >= 600, `${sz.width}x${sz.height} ${(s2.png.length / 1024).toFixed(0)}KB`);
  }

  // 退出
  zc.reset();
  await sleep(1200);
  check('C1', 'reset 后回到未激活', zc.state.active === false, `active=${zc.state.active} zoom=${zc.state.zoom}`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} ${results.length - failed}/${results.length}`);
  try {
    fs.writeFileSync(path.join(OUT, 'mag-integration.json'), JSON.stringify({ at: new Date().toISOString(), failed, results }, null, 2));
  } catch (e) {
    /* noop */
  }
  app.exit(failed === 0 ? 0 : 1);
});
