// 诊断探针 2（修正版）：等捕获流就绪后再拍 4x/8x 文字可读性截图 + Droste 同时刻对比。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_clean.txt');
const SHOT_DIR = path.join(__dirname, '..', '..', 'deliverables');
const rows = [];
const log = (s) => { rows.push(String(s)); fs.writeFileSync(OUT, rows.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = {
  ...ZOOM_DEFAULTS,
  zoomTrigger: 'hotkey',
  zoomColorMode: 'normal',
  zoomEdgeEnhance: 0.35,
  zoomOutline: 0.4,
  zoomContrast: 0.2,
  zoomCrosshair: 'full',
  zoomFocusRing: true,
  zoomShowHud: true,
  zoomFollowSmoothing: 0,
};

function xdo(...args) { try { execFileSync('xdotool', args, { stdio: 'ignore' }); } catch (e) {} }
function getOverlay() {
  return BrowserWindow.getAllWindows().find((w) => (w.webContents.getURL() || '').indexOf('zoom-overlay.html') !== -1) || null;
}

async function waitStreamReady(ov, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await ov.webContents.executeJavaScript(`(function(){
      var v = document.getElementById('screen');
      var w = document.getElementById('wait');
      var c = document.createElement('canvas'); c.width = 32; c.height = 16;
      var ok = false;
      try {
        c.getContext('2d').drawImage(v, 0, 0, 32, 16);
        var d = c.getImageData(0, 0, 32, 16).data;
        var nb = 0;
        for (var i = 0; i < 32 * 16; i++) if ((d[i*4]+d[i*4+1]+d[i*4+2])/3 > 24) nb++;
        ok = nb / (32 * 16) > 0.5;
      } catch (e) {}
      return JSON.stringify({ wait: w.style.display, readyState: v.readyState, ok: ok });
    })()`);
    const d = JSON.parse(r);
    if (d.wait === 'none' && d.readyState >= 2 && d.ok) return Date.now() - t0;
    await sleep(250);
  }
  return -1;
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
    const tAct = Date.now();
    ctl.activate();
    await sleep(300);
    xdo('key', 'ctrl+alt+q'); // → 4x
    const ov = getOverlay();
    if (!ov) throw new Error('overlay 未找到');
    await sleep(3000); // 纯等待（不轮询 executeJavaScript，避免干扰软件合成下的视频管线）
    const r = await ov.webContents.executeJavaScript(`(function(){
      try {
        var v = document.getElementById('screen');
        var c = document.createElement('canvas'); c.width = 32; c.height = 16;
        c.getContext('2d').drawImage(v, 0, 0, 32, 16);
        var d = c.getImageData(0, 0, 32, 16).data;
        var nb = 0;
        for (var i = 0; i < 32 * 16; i++) if ((d[i*4]+d[i*4+1]+d[i*4+2])/3 > 24) nb++;
        return JSON.stringify({ wait: document.getElementById('wait').style.display, nonBlack: (nb/(32*16)).toFixed(2) });
      } catch (e) { return 'INNER-ERR: ' + e.message; }
    })()`);
    log(`3s 后视频状态: ${r}`);

    // 4x 正文可读性
    xdo('mousemove', '400', '230');
    await sleep(900);
    let img = await ov.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, 'qa-v26-zoom-4x-text.png'), img.toPNG());
    log('4x 正文截图完成');

    // 8x 细字可读性 + 同时刻 video 直帧
    xdo('key', 'ctrl+alt+q'); // → 8x
    await sleep(1200);
    xdo('mousemove', '300', '270');
    await sleep(900);
    img = await ov.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, 'qa-v26-zoom-8x-fine.png'), img.toPNG());
    log('8x 细字截图完成（增强开）');
    const videoDataUrl = await ov.webContents.executeJavaScript(`(function(){
      var v = document.getElementById('screen');
      var c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      return c.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(SHOT_DIR, 'qa-v26-zoom-diag-video.png'), Buffer.from(videoDataUrl.split(',')[1], 'base64'));
    log('video 直帧已保存（同时刻）');

    // 增强关闭对照
    settings.zoomEdgeEnhance = 0;
    settings.zoomOutline = 0;
    settings.zoomContrast = 0;
    await sleep(700);
    img = await ov.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, 'qa-v26-zoom-8x-plain.png'), img.toPNG());
    log('8x 细字截图完成（增强全关，对照）');

    ctl.stop();
  } catch (e) {
    log('diag failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 90000);
