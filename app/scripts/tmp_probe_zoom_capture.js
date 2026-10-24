// 诊断探针：overlay 的 desktopCapturer 视频流在沙箱里到底捕获到了什么。
// 用 canvas 抽取视频帧的粗像素网格，直接看内容。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, screen, BrowserWindow } = require('electron');
const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_capture.txt');
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
  zoomShowHud: true,
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
    ctl.nudge(true); ctl.nudge(true); ctl.nudge(true); ctl.nudge(true); ctl.nudge(true); ctl.nudge(true); // → 8x
    xdo('mousemove', '300', '300');
    await sleep(2500);

    const ov = getOverlay();
    log('overlay: ' + (ov ? 'found' : 'MISSING'));
    const diag = await ov.webContents.executeJavaScript(`(function(){
      var v = document.getElementById('screen');
      var w = document.getElementById('wait');
      var out = {
        waitDisplay: w ? w.style.display : 'n/a',
        waitText: document.getElementById('waitText') ? document.getElementById('waitText').textContent : '',
        readyState: v.readyState,
        videoWidth: v.videoWidth, videoHeight: v.videoHeight,
        hasSrcObject: !!v.srcObject,
        trackCount: v.srcObject ? v.srcObject.getTracks().length : 0,
        trackSettings: v.srcObject && v.srcObject.getVideoTracks()[0] ? JSON.stringify(v.srcObject.getVideoTracks()[0].getSettings()) : '',
        paused: v.paused,
      };
      // 抽视频帧像素：32x16 网格均值（字符画）
      try {
        var c = document.createElement('canvas');
        c.width = 32; c.height = 16;
        var ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, 32, 16);
        var d = ctx.getImageData(0, 0, 32, 16).data;
        var chars = '';
        var nonBlack = 0;
        for (var i = 0; i < 32 * 16; i++) {
          var r = d[i*4], g = d[i*4+1], b = d[i*4+2];
          var lum = (r + g + b) / 3;
          if (lum > 24) nonBlack++;
          chars += lum < 16 ? '.' : lum < 64 ? ':' : lum < 128 ? '*' : lum < 200 ? 'O' : '#';
          if ((i + 1) % 32 === 0) chars += '\\n';
        }
        out.grid = chars;
        out.nonBlackFrac = (nonBlack / (32 * 16)).toFixed(2);
      } catch (e) { out.gridErr = e.message; }
      return JSON.stringify(out);
    })()`);
    const d = JSON.parse(diag);
    log('wait.display=' + d.waitDisplay + ' waitText="' + d.waitText + '"');
    log('video readyState=' + d.readyState + ' size=' + d.videoWidth + 'x' + d.videoHeight + ' paused=' + d.paused);
    log('srcObject=' + d.hasSrcObject + ' tracks=' + d.trackCount + ' settings=' + d.trackSettings);
    log('非黑像素占比=' + d.nonBlackFrac + ' gridErr=' + (d.gridErr || '无'));
    log('视频帧字符画（.=黑 :=暗 *=中 O=亮 #=白）:\n' + (d.grid || ''));

    // 对照：隐藏内容窗口后再抽一帧
    contentWin.hide();
    await sleep(600);
    const diag2 = await ov.webContents.executeJavaScript(`(function(){
      var v = document.getElementById('screen');
      var c = document.createElement('canvas'); c.width = 32; c.height = 16;
      var ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 32, 16);
      var dd = ctx.getImageData(0, 0, 32, 16).data;
      var nonBlack = 0, sum = 0;
      for (var i = 0; i < 32 * 16; i++) { var l = (dd[i*4]+dd[i*4+1]+dd[i*4+2])/3; sum += l; if (l > 24) nonBlack++; }
      return JSON.stringify({ nonBlackFrac: (nonBlack/(32*16)).toFixed(2), meanLum: (sum/(32*16)).toFixed(1) });
    })()`);
    log('隐藏内容窗口后视频帧: ' + diag2);
    contentWin.show();
    await sleep(500);
    const diag3 = await ov.webContents.executeJavaScript(`(function(){
      var v = document.getElementById('screen');
      var c = document.createElement('canvas'); c.width = 32; c.height = 16;
      var ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 32, 16);
      var dd = ctx.getImageData(0, 0, 32, 16).data;
      var nonBlack = 0, sum = 0;
      for (var i = 0; i < 32 * 16; i++) { var l = (dd[i*4]+dd[i*4+1]+dd[i*4+2])/3; sum += l; if (l > 24) nonBlack++; }
      return JSON.stringify({ nonBlackFrac: (nonBlack/(32*16)).toFixed(2), meanLum: (sum/(32*16)).toFixed(1) });
    })()`);
    log('恢复内容窗口后视频帧: ' + diag3);

    ctl.stop();
  } catch (e) {
    log('diag failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 40000);
