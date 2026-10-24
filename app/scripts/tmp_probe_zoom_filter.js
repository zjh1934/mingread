// 滤镜 A/B 测试：同一会话内切换 edgeEnhance/outline/contrast/colorMode，截图对比视频区明暗。
// 目的：定位 SVG 滤镜链是否在软件合成下把视频渲染为黑色（若是，弱 GPU 用户默认配置会黑屏）。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_filter.txt');
const SHOT_DIR = path.join(__dirname, '..', '..', 'deliverables');
const rows = [];
const log = (s) => { rows.push(String(s)); fs.writeFileSync(OUT, rows.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = {
  ...ZOOM_DEFAULTS,
  zoomTrigger: 'hotkey',
  zoomColorMode: 'normal',
  zoomEdgeEnhance: 0,
  zoomOutline: 0,
  zoomContrast: 0,
  zoomCrosshair: 'off',
  zoomFocusRing: false,
  zoomShowHud: false,
  zoomFollowSmoothing: 0,
};

function xdo(...args) { try { execFileSync('xdotool', args, { stdio: 'ignore' }); } catch (e) {} }
function getOverlay() {
  return BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || '').indexOf('zoom-overlay.html') !== -1) || null;
}

app.whenReady().then(async () => {
  try {
    const contentWin = new BrowserWindow({
      x: 60, y: 50, width: 1100, height: 760, title: 'LensZoom-Content',
      backgroundColor: '#ffffff', webPreferences: { contextIsolation: false },
    });
    contentWin.loadFile(path.join(__dirname, 'tmp_zoom_content.html'));
    await new Promise((r) => contentWin.webContents.once('did-finish-load', r));
    contentWin.show();
    contentWin.focus();
    await sleep(600);

    const ctl = createZoomController({ getSettings: () => settings, saveSettings: () => {}, getMainWindow: () => contentWin });
    ctl.start();
    ctl.activate();
    for (let i = 0; i < 6; i++) ctl.nudge(true); // → 8x
    xdo('mousemove', '300', '300');
    let ov = getOverlay();
    for (let i = 0; i < 40 && !ov; i++) {
      await sleep(100);
      ov = getOverlay();
    }
    if (!ov) throw new Error('overlay 未找到');
    await sleep(3000);

    const cases = [
      { name: 'A-全关(基线)', edge: 0, outline: 0, contrast: 0, mode: 'normal' },
      { name: 'B-仅对比度', edge: 0, outline: 0, contrast: 0.5, mode: 'normal' },
      { name: 'C-仅锐化', edge: 0.35, outline: 0, contrast: 0, mode: 'normal' },
      { name: 'D-仅描边', edge: 0, outline: 0.4, contrast: 0, mode: 'normal' },
      { name: 'E-锐化+描边(默认档)', edge: 0.35, outline: 0.4, contrast: 0, mode: 'normal' },
      { name: 'F-反色', edge: 0, outline: 0, contrast: 0, mode: 'invert' },
    ];
    for (const c of cases) {
      settings.zoomEdgeEnhance = c.edge;
      settings.zoomOutline = c.outline;
      settings.zoomContrast = c.contrast;
      settings.zoomColorMode = c.mode;
      await sleep(900);
      const img = await ov.webContents.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, `qa-v26-zoom-filter-${c.name.slice(0, 1)}.png`), img.toPNG());
      log(`截图 ${c.name}: edge=${c.edge} outline=${c.outline} contrast=${c.contrast} mode=${c.mode}`);
    }
    ctl.stop();
  } catch (e) {
    log('filter test failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 60000);
