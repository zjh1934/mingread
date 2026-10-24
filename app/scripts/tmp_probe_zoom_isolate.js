// 隔离实验：找出 video 帧内容在"白(有内容窗口)"与"黑(无内容窗口)"之间切换的变量。
// 依次采样：A 装饰开/未capturePage → B capturePage后 → C 装饰关 → D 内容窗口隐藏 → E 内容窗口恢复
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_isolate.txt');
const rows = [];
const log = (s) => { rows.push(String(s)); fs.writeFileSync(OUT, rows.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = {
  ...ZOOM_DEFAULTS,
  zoomTrigger: 'hotkey',
  zoomColorMode: 'normal',
  zoomEdgeEnhance: 0, zoomOutline: 0, zoomContrast: 0,
  zoomCrosshair: 'full', zoomFocusRing: true, zoomShowHud: true,
  zoomFollowSmoothing: 0,
};

function xdo(...args) { try { execFileSync('xdotool', args, { stdio: 'ignore' }); } catch (e) {} }
function getOverlay() {
  return BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || '').indexOf('zoom-overlay.html') !== -1) || null;
}

async function sampleVideo(ov, label) {
  const r = await ov.webContents.executeJavaScript(`(function(){
    var v = document.getElementById('screen');
    var w = document.getElementById('wait');
    var c = document.createElement('canvas'); c.width = 32; c.height = 16;
    var ctx = c.getContext('2d');
    try { ctx.drawImage(v, 0, 0, 32, 16); } catch (e) { return JSON.stringify({ err: e.message }); }
    var d = ctx.getImageData(0, 0, 32, 16).data;
    var nonBlack = 0, sum = 0;
    for (var i = 0; i < 32 * 16; i++) { var l = (d[i*4]+d[i*4+1]+d[i*4+2])/3; sum += l; if (l > 24) nonBlack++; }
    return JSON.stringify({ wait: w.style.display, readyState: v.readyState, vw: v.videoWidth,
      nonBlack: (nonBlack/(32*16)).toFixed(2), meanLum: (sum/(32*16)).toFixed(1) });
  })()`);
  log(`${label}: ${r}`);
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
    if (!ov) {
      log('overlay 始终未找到；当前窗口: ' + BrowserWindow.getAllWindows().map((w) => (w.webContents.getURL() || '(no url)').slice(0, 60)).join(' | '));
      throw new Error('no overlay');
    }

    await sleep(2500);
    await sampleVideo(ov, 'A 装饰开·未capturePage（复现 capture-diag 条件）');

    await ov.webContents.capturePage();
    await sleep(800);
    await sampleVideo(ov, 'B capturePage 之后');

    settings.zoomCrosshair = 'off';
    settings.zoomFocusRing = false;
    await sleep(800);
    await sampleVideo(ov, 'C 装饰全关');

    contentWin.hide();
    await sleep(800);
    await sampleVideo(ov, 'D 内容窗口隐藏');

    contentWin.show();
    await sleep(800);
    await sampleVideo(ov, 'E 内容窗口恢复（装饰仍关）');

    settings.zoomCrosshair = 'full';
    settings.zoomFocusRing = true;
    await sleep(800);
    await sampleVideo(ov, 'F 装饰恢复开启');

    ctl.stop();
  } catch (e) {
    log('isolate failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 60000);
