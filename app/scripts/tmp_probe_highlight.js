// 验证悬停高亮层：框真的画在屏幕上（不是"调用了就算成功"）。
// 手法：调 highlight.show() 后在屏幕中间画三个框 → 桌面截屏 → 数紫色描边像素。
// 注意：高亮是透明置顶窗口，capturePage 截不到（只截 Chromium 自己的 surface），
// 必须走 desktopCapturer 抓真实桌面。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, desktopCapturer, screen } = require('electron');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const highlight = require('../src/main/hover/highlight');

  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const cx = Math.round((d.bounds.x + d.bounds.width / 2) * sf);
  const cy = Math.round((d.bounds.y + d.bounds.height / 2) * sf);

  // 三个框：中间一个 + 上方一个 + 下方一个（模拟一段文字的三行）
  const rects = [
    { x: cx - 300, y: cy - 60, w: 600, h: 24 },
    { x: cx - 300, y: cy - 28, w: 520, h: 24 },
    { x: cx - 300, y: cy + 4, w: 440, h: 24 },
  ];

  const ok = highlight.show(rects, 8000);
  check('A1', 'show() 返回成功', ok === true, `ok=${ok}`);
  await sleep(900);

  // 桌面截屏
  let shot = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: d.bounds.width, height: d.bounds.height },
    });
    if (sources && sources.length) shot = sources[0].thumbnail;
  } catch (e) {
    console.log('[hl] 截屏失败: ' + e.message);
  }
  check('A2', '拿到桌面截图', !!(shot && !shot.isEmpty()), shot ? JSON.stringify(shot.getSize()) : 'null');

  if (shot && !shot.isEmpty()) {
    const size = shot.getSize();
    const bmp = shot.toBitmap(); // BGRA
    // 在高亮区域内数紫色描边（#7c6cff 附近：R~124 G~108 B~255）
    const near = (x, y) => {
      const i = (y * size.width + x) * 4;
      const b = bmp[i];
      const g = bmp[i + 1];
      const r = bmp[i + 2];
      return b > 180 && r > 80 && r < 190 && g > 70 && g < 170 && b - r > 40;
    };
    let purple = 0;
    const x0 = Math.max(0, Math.round((rects[0].x) / sf));
    const x1 = Math.min(size.width, Math.round((rects[0].x + rects[0].w) / sf));
    const y0 = Math.max(0, Math.round((rects[0].y) / sf));
    const y1 = Math.min(size.height, Math.round((rects[2].y + rects[2].h) / sf));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (near(x, y)) purple += 1;
      }
    }
    check('A3', '截图里数到紫色描边像素', purple > 200, `紫色像素=${purple}`);

    const out = path.join(__dirname, '..', 'dist', 'probe', 'hover-highlight.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, shot.toPNG());
    console.log('[hl] 截图 -> ' + out);
  }

  // 隐藏
  highlight.hide();
  await sleep(700);
  let shot2 = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: d.bounds.width, height: d.bounds.height },
    });
    if (sources && sources.length) shot2 = sources[0].thumbnail;
  } catch (e) {
    /* 忽略 */
  }
  if (shot2 && !shot2.isEmpty() && shot && !shot.isEmpty()) {
    // 只看中间那一条：隐藏后紫色应该基本消失
    const size = shot2.getSize();
    const bmp = shot2.toBitmap();
    let purple2 = 0;
    const x0 = Math.max(0, Math.round(rects[0].x / sf));
    const x1 = Math.min(size.width, Math.round((rects[0].x + rects[0].w) / sf));
    const y0 = Math.max(0, Math.round(rects[0].y / sf));
    const y1 = Math.min(size.height, Math.round((rects[2].y + rects[2].h) / sf));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * size.width + x) * 4;
        const b = bmp[i];
        const g = bmp[i + 1];
        const r = bmp[i + 2];
        if (b > 180 && r > 80 && r < 190 && g > 70 && g < 170 && b - r > 40) purple2 += 1;
      }
    }
    check('A4', 'hide() 后框已消失', purple2 < 40, `残留紫色像素=${purple2}`);
  }

  highlight.dispose();
  check('A5', 'dispose 不抛异常', true, 'ok');
  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 300);
});
