// 独立测试：透明窗口 + desktopCapturer 在 X11 下的行为。
// 问题：不透明黑底 overlay 把自己拍进捕获流 → 放大画面全黑（Droste 稳态）。
// 假设：transparent:true 的 overlay，其透明区域在捕获里能看到下层内容（XComposite/alpha 感知）。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, screen, BrowserWindow, desktopCapturer } = require('electron');

const OUT = path.join(__dirname, 'tmp_probe_transparent.txt');
const rows = [];
const log = (s) => { rows.push(String(s)); fs.writeFileSync(OUT, rows.join('\n') + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    // 1) 内容窗口：白底 + 黑色大字 + 蓝色块
    const contentWin = new BrowserWindow({
      x: 60, y: 50, width: 1100, height: 760, title: 'T-Content',
      backgroundColor: '#ffffff', webPreferences: { contextIsolation: false },
    });
    contentWin.loadURL('data:text/html,' + encodeURIComponent(`
      <body style="margin:0;background:#fff;font-family:sans-serif">
        <div style="height:120px;background:#1e40af;color:#fff;font-size:40px;padding:20px;">CONTENT-WINDOW-HEADER</div>
        <div style="font-size:60px;padding:40px;">透明捕获测试 ABCDEFG 1234567</div>
        <div style="width:300px;height:300px;background:#ef4444;margin:40px;"></div>
      </body>`));
    await new Promise((r) => contentWin.webContents.once('did-finish-load', r));
    contentWin.show();
    await sleep(500);

    // 2) 透明 overlay 窗口：全屏，中间一个不透明红方块，其余透明
    const ov = new BrowserWindow({
      x: 0, y: 0, width: screen.getPrimaryDisplay().bounds.width, height: screen.getPrimaryDisplay().bounds.height,
      frame: false, transparent: true, backgroundColor: '#00000000',
      skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
      webPreferences: { contextIsolation: false },
    });
    ov.loadURL('data:text/html,' + encodeURIComponent(`
      <body style="margin:0;background:transparent">
        <div style="position:fixed;left:900px;top:300px;width:400px;height:300px;background:#00ff00;border:4px solid #ffff00;"></div>
      </body>`));
    await new Promise((r) => ov.webContents.once('did-finish-load', r));
    ov.showInactive();
    await sleep(800);

    // 3) 在 overlay 里捕获屏幕，抽像素看透明区域是否可见下层内容
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const sourceId = sources[0].id;
    const stats = await ov.webContents.executeJavaScript(`(async function(){
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)}, maxFrameRate: 30 } },
      });
      const v = document.createElement('video');
      v.srcObject = stream; v.muted = true; await v.play();
      await new Promise((r) => setTimeout(r, 1200));
      const c = document.createElement('canvas');
      c.width = 64; c.height = 40;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 64, 40);
      const d = ctx.getImageData(0, 0, 64, 40).data;
      // 采样三个点：透明区左上(应看到内容窗口白底/蓝头)、绿方块中心(应看到绿)、透明区右下(应看到黑桌面或内容)
      function px(fx, fy) {
        const x = Math.floor(fx * 64), y = Math.floor(fy * 40);
        const i = (y * 64 + x) * 4;
        return [d[i], d[i+1], d[i+2]];
      }
      return JSON.stringify({
        readyState: v.readyState, vw: v.videoWidth,
        topLeft: px(0.1, 0.1),       // 屏幕(256,102)：内容窗口蓝头下方白区
        greenBox: px(0.5, 0.45),     // 屏幕(1280,460)：绿方块中心
        bottomRight: px(0.9, 0.9),   // 屏幕(2304,922)：黑桌面
      });
    })()`);
    log('透明 overlay 捕获结果: ' + stats);
    log('解读：topLeft 若为白色系(>200,>200,>200)=透明区可见下层内容 ✓；若为黑(0,0,0)=alpha 未被捕获感知 ✗');

    ov.destroy();
    contentWin.destroy();
  } catch (e) {
    log('transparent test failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 40000);
