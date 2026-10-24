// α QA 探针：LensZoom 状态机真机验证（指标 D）。
// 用法：xvfb-run -a ./node_modules/.bin/electron --no-sandbox scripts/alpha_probe_zoom.js
// 结果写 scripts/alpha_probe_zoom.txt（不依赖 stdout）。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, screen } = require('electron');

const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');
const OUT = path.join(__dirname, 'alpha_probe_zoom.txt');
const rows = [];
const log = (s) => {
  rows.push(String(s));
  fs.writeFileSync(OUT, rows.join('\n') + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const settings = {
  ...ZOOM_DEFAULTS,
  zoomTrigger: 'hotkey',
  zoomMin: 1,
  zoomMax: 24,
  zoomSmoothing: 0.65,
  zoomFollowMode: 'fixed',
  zoomEdgeEnhance: 0.3,
  zoomOutline: 0.5,
  zoomOutlineColor: '#ffff00',
  zoomContrast: 0.15,
  zoomColorMode: 'invert',
  zoomCrosshair: 'full',
  zoomFocusRing: true,
  zoomFollowSmoothing: 0.3,
};

app.whenReady().then(async () => {
  try {
    const ctl = createZoomController({
      getSettings: () => settings,
      saveSettings: () => {},
      getMainWindow: () => null,
    });
    ctl.start();
    log(`start: trigger=${ctl.state.trigger} zoomHotkeyOk=${ctl.state.zoomHotkeyOk}`);
    const snap = (label) =>
      log(
        `${label}: active=${ctl.state.active} zoom=${Number(ctl.state.zoom).toFixed(3)} ` +
          `target=${ctl.state.targetZoom} exiting=${ctl.state.exiting} fps=${Math.round(ctl.state.fps)}`
      );

    // 1) 唤起
    ctl.activate();
    await sleep(450);
    snap('① 唤起后 450ms');

    // 2) 放大
    ctl.nudge(true);
    await sleep(450);
    snap('② 放大一档后 450ms');

    // 3) 跟随（几何：origin/cursor/新字段）
    const d = screen.getPrimaryDisplay();
    const t = ctl._buildTransform(d);
    log(
      `③ transform: zoom=${t.zoom} origin=(${t.originX.toFixed(0)},${t.originY.toFixed(0)}) ` +
        `cursor=(${t.cursorX.toFixed(0)},${t.cursorY.toFixed(0)}) display=${t.displayId}`
    );
    log(
      `③ 视觉增强字段: edgeEnhance=${t.edgeEnhance} outline=${t.outline} outlineColor=${t.outlineColor} ` +
        `contrast=${t.contrast} colorMode=${t.colorMode} crosshair=${t.crosshair} focusRing=${t.focusRing} ` +
        `hudFont=${t.hudFont} followSmoothing(设)=${settings.zoomFollowSmoothing}`
    );
    const want = [
      'zoom', 'originX', 'originY', 'width', 'height', 'cursorX', 'cursorY', 'displayId',
      'showHud', 'fps', 'integer', 'backend',
      'edgeEnhance', 'outline', 'outlineColor', 'contrast', 'colorMode', 'crosshair', 'focusRing', 'hudFont', 'exiting',
    ];
    const missing = want.filter((k) => !(k in t));
    log(`③ 契约字段缺失: ${missing.length ? missing.join(',') : '无'}`);

    // 4) 缩回 1x 退出
    ctl.reset();
    await sleep(120);
    snap('④ reset 后 120ms（缩回中）');
    await sleep(1800);
    snap('④ reset 后 1920ms（应已退出）');

    const pass =
      ctl.state.active === false &&
      ctl.state.zoom <= 1.001 &&
      !missing.length &&
      t.edgeEnhance > 0 &&
      t.crosshair === 'full' &&
      t.focusRing === true;
    log(`指标 D 自检：${pass ? 'PASS' : 'FAIL'}（唤起重叠 → 放大 → 跟随 → 缩回 1x 退出 + 视觉增强字段齐全）`);

    // 覆盖层截图（尽力而为：沙箱里 desktopCapturer 可能取不到屏幕源）
    try {
      const { BrowserWindow: BW } = require('electron');
      ctl.activate();
      await sleep(900);
      const ov = BW.getAllWindows().find((x) => (x.getTitle() || '').indexOf('zoom') !== -1);
      if (ov) {
        const img = await ov.webContents.capturePage();
        fs.writeFileSync(
          path.join(__dirname, '..', '..', 'deliverables', 'qa-v24-zoom-overlay.png'),
          img.toPNG()
        );
        log(`覆盖层截图已保存（捕获源 ${ov.getBounds().width}x${ov.getBounds().height}）`);
      } else {
        log('覆盖层窗口未找到');
      }
      ctl.reset();
    } catch (e) {
      log('overlay capture failed: ' + e.message);
    }

    ctl.stop();
  } catch (e) {
    log('probe failed: ' + (e && e.stack ? e.stack.split('\n')[0] : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});
setTimeout(() => app.exit(1), 30000);
