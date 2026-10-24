// 堆叠诊断：激活缩放后 dump X 窗口树（xwininfo -root -tree），看 overlay 与内容窗口的映射/堆叠状态。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_stack.txt');
const SHOT_DIR = path.join(__dirname, '..', '..', 'deliverables');
const rows = [];
const log = (s) => { rows.push(String(s)); fs.writeFileSync(OUT, rows.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = { ...ZOOM_DEFAULTS, zoomTrigger: 'hotkey', zoomCrosshair: 'full', zoomFocusRing: true, zoomShowHud: true, zoomEdgeEnhance: 0.35, zoomOutline: 0.4 };

function sh(cmd) {
  try { return execFileSync('bash', ['-c', cmd], { encoding: 'utf8' }); } catch (e) { return 'ERR: ' + e.message; }
}
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
    for (let i = 0; i < 6; i++) ctl.nudge(true);
    let ov = getOverlay();
    for (let i = 0; i < 40 && !ov; i++) { await sleep(100); ov = getOverlay(); }
    await sleep(3000);

    const tag = process.env.STACK_TAG || 'run';
    log('== overlay 状态 ==');
    log(`isVisible=${ov.isVisible()} isMinimized=${ov.isMinimized()} isFocused=${ov.isFocused()} bounds=${JSON.stringify(ov.getBounds())}`);
    log('== X 窗口树（子窗口自上而下=从顶到底） ==');
    const tree = sh("xwininfo -root -tree | grep -E 'children|0x[0-9a-f]+ ' | head -8");
    log(tree);

    // 直接看 overlay 视频内容（capturePage 后 charmap）
    const img = await ov.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, `qa-v26-zoom-stack-${tag}.png`), img.toPNG());
    log(`capturePage 已保存 qa-v26-zoom-stack-${tag}.png`);

    ctl.stop();
  } catch (e) {
    log('stack diag failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 60000);
