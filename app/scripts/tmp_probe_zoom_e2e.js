// α2 实跑验证探针：LensZoom 真实 E2E —— 真启动 Electron、真全局热键、真 xdotool 鼠标、真截图。
// 用法：DISPLAY=:91 node_modules/.bin/electron --no-sandbox scripts/tmp_probe_zoom_e2e.js
// 截图写 deliverables/qa-v26-zoom-*.png；日志写 scripts/tmp_probe_zoom_e2e.txt
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, screen, BrowserWindow } = require('electron');

const { createZoomController, ZOOM_DEFAULTS } = require('../src/main/zoomController');

const OUT = path.join(__dirname, 'tmp_probe_zoom_e2e.txt');
const SHOT_DIR = path.join(__dirname, '..', '..', 'deliverables');
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
  zoomMax: 32,
  zoomSmoothing: 0.5,
  zoomFollowMode: 'fixed',
  zoomFollowSmoothing: 0, // 测原始管线延迟用 0；平滑单独测
  zoomShowHud: true,
  zoomEdgeEnhance: 0.35,
  zoomOutline: 0.4,
  zoomOutlineColor: '#ffff00',
  zoomContrast: 0.2,
  zoomColorMode: 'normal',
  zoomCrosshair: 'full',
  zoomFocusRing: true,
  zoomAnnounce: true,
};

function xdo(...args) {
  try {
    execFileSync('xdotool', args, { stdio: 'ignore' });
    return true;
  } catch (e) {
    log(`  [xdotool 失败] ${args.join(' ')} -> ${e.message}`);
    return false;
  }
}

let contentWin = null;
let ov = null;
const shots = [];

/** overlay 懒查找：按 URL 匹配（title 在 loadFile 完成前为空，不能用来找窗口） */
function getOverlay() {
  try {
    return (
      BrowserWindow.getAllWindows().find((w) => {
        try {
          return (w.webContents.getURL() || '').indexOf('zoom-overlay.html') !== -1;
        } catch (e) {
          return false;
        }
      }) || null
    );
  } catch (e) {
    return null;
  }
}

async function shotOverlay(name) {
  ov = getOverlay();
  if (!ov) {
    log(`  [截图失败] overlay 未找到: ${name}`);
    return;
  }
  try {
    await sleep(260); // 等视频帧与 DOM 辅助层稳定
    const img = await ov.webContents.capturePage();
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, img.toPNG());
    shots.push(name);
    log(`  [截图] ${name} (${img.getSize().width}x${img.getSize().height})`);
  } catch (e) {
    log(`  [截图失败] ${name}: ${e.message}`);
  }
}

async function shotWindow(win, name) {
  try {
    await sleep(200);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name), img.toPNG());
    shots.push(name);
    log(`  [截图] ${name} (${img.getSize().width}x${img.getSize().height})`);
  } catch (e) {
    log(`  [截图失败] ${name}: ${e.message}`);
  }
}

async function overlayTransform() {
  ov = getOverlay();
  if (!ov) return 'no-overlay';
  return ov.webContents.executeJavaScript(
    "(function(){var v=document.getElementById('screen');return (v.style.transform||'')+' @ '+(v.style.transformOrigin||'');})()"
  );
}

/** 等 overlay 的 video transform 稳定（3 次相同读数），返回耗时 ms */
async function measureSettle(maxMs = 1500) {
  const t0 = Date.now();
  let last = await overlayTransform();
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(16);
    const tr = await overlayTransform();
    if (tr === last && Date.now() - t0 > 90) {
      stable += 1;
      if (stable >= 3) break;
    } else {
      stable = 0;
    }
    last = tr;
  }
  return { ms: Date.now() - t0, transform: last };
}

async function waitFor(fn, timeout = 4000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return Date.now() - t0;
    await sleep(step);
  }
  return -1;
}

app.whenReady().then(async () => {
  try {
    log('== 环境 ==');
    log('DISPLAY=' + process.env.DISPLAY);
    log('屏幕: ' + JSON.stringify(screen.getAllDisplays().map((d) => ({ id: d.id, ...d.bounds }))));

    // ---- 内容窗口（给缩放提供可放大的真实内容）----
    contentWin = new BrowserWindow({
      x: 60, y: 50, width: 1100, height: 760,
      title: 'LensZoom-Content',
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: false },
    });
    contentWin.loadFile(path.join(__dirname, 'tmp_zoom_content.html'));
    await new Promise((r) => contentWin.webContents.once('did-finish-load', r));
    contentWin.show();
    contentWin.focus();
    await sleep(600);
    await shotWindow(contentWin, 'qa-v26-zoom-content.png');
    log('内容窗口已就绪（标题/正文/按钮/输入框/棋盘格/细线/色块）');

    // ---- 启动缩放控制器（热键模式）----
    const ctl = createZoomController({
      getSettings: () => settings,
      saveSettings: () => {},
      getMainWindow: () => contentWin,
    });
    ctl.start();
    log(`控制器启动: trigger=${ctl.state.trigger} zoomHotkeyOk=${ctl.state.zoomHotkeyOk}`);

    // ========== ① 唤起：真热键 Ctrl+Alt+= ==========
    log('\n== ① 唤起（真热键 Ctrl+Alt+=） ==');
    xdo('key', 'ctrl+alt+equal');
    const tAct = await waitFor(() => ctl.state.active, 2500);
    if (tAct < 0) {
      log('  热键未触发（沙箱 XGrabKey 限制），退走内部 API nudge(true) 等价路径');
      ctl.nudge(true);
      await waitFor(() => ctl.state.active, 2000);
    } else {
      log(`  热键生效，active=true（${tAct}ms 内）`);
    }
    ov = getOverlay();
    log(`  overlay 窗口: ${ov ? '找到' : '未找到'}`);
    await waitFor(() => ctl.state.zoom >= 1.98, 2000);
    await sleep(250);
    log(`  状态: active=${ctl.state.active} zoom=${ctl.state.zoom.toFixed(2)} target=${ctl.state.targetZoom} fps=${Math.round(ctl.state.fps)}`);
    await shotOverlay('qa-v26-zoom-2x.png');

    // ========== ② 快速循环：真热键 Ctrl+Alt+Q → 4x → 8x ==========
    log('\n== ② 倍率快速循环（真热键 Ctrl+Alt+Q） ==');
    xdo('key', 'ctrl+alt+q');
    await waitFor(() => ctl.state.targetZoom === 4, 1500);
    await waitFor(() => ctl.state.zoom >= 3.98, 2500);
    await sleep(200);
    log(`  Q 第一次: target=${ctl.state.targetZoom} zoom=${ctl.state.zoom.toFixed(2)}`);
    await shotOverlay('qa-v26-zoom-4x.png');
    xdo('key', 'ctrl+alt+q');
    await waitFor(() => ctl.state.targetZoom === 8, 1500);
    await waitFor(() => ctl.state.zoom >= 7.98, 2500);
    await sleep(200);
    // 8x 下采样 FPS
    let fpsSum = 0;
    for (let i = 0; i < 6; i++) {
      await sleep(180);
      fpsSum += ctl.state.fps;
    }
    log(`  Q 第二次: target=${ctl.state.targetZoom} zoom=${ctl.state.zoom.toFixed(2)} 平均FPS≈${Math.round(fpsSum / 6)}`);
    await shotOverlay('qa-v26-zoom-8x.png');

    // ========== ③ 跟随策略（fixed，真鼠标移动） ==========
    log('\n== ③ 跟随（fixed 模式，xdotool 移动真鼠标） ==');
    xdo('mousemove', '300', '300');
    let m = await measureSettle();
    log(`  移到(300,300): 稳定耗时 ${m.ms}ms | ${m.transform}`);
    await shotOverlay('qa-v26-zoom-follow-a.png');
    xdo('mousemove', '1000', '600');
    m = await measureSettle();
    log(`  移到(1000,600): 稳定耗时 ${m.ms}ms | ${m.transform}`);
    await shotOverlay('qa-v26-zoom-follow-b.png');
    const t3 = ctl._buildTransform(screen.getPrimaryDisplay());
    log(`  fixed 不变点校验: cursor=(${t3.cursorX},${t3.cursorY}) origin=(${t3.originX.toFixed(0)},${t3.originY.toFixed(0)})（应相等）`);

    // 跟随平滑（zoomFollowSmoothing>0 时画面拖着走）
    settings.zoomFollowSmoothing = 0.6;
    xdo('mousemove', '400', '400');
    await sleep(60);
    const mid = await overlayTransform();
    await sleep(450);
    const end = await overlayTransform();
    log(`  平滑跟随(0.6): 移动后60ms=${mid} → 510ms=${end}（应逐渐逼近，非瞬移）`);
    settings.zoomFollowSmoothing = 0;

    // ========== ④ 方向键平移（真热键 Ctrl+Alt+Right/Left） ==========
    log('\n== ④ 平移（真热键 Ctrl+Alt+方向键） ==');
    xdo('mousemove', '700', '500');
    await sleep(250);
    const before = await overlayTransform();
    xdo('key', 'ctrl+alt+Right');
    await sleep(250);
    const afterRight = await overlayTransform();
    log(`  panX=${ctl.state.panX.toFixed(0)}（8x 下半视口=2560/8/2=160）`);
    log(`  平移前: ${before}`);
    log(`  平移后: ${afterRight}`);
    await shotOverlay('qa-v26-zoom-pan-right.png');
    // 连按 Left 6 次应回到 0 附近（且不溢出为负后无效果——clamp）
    for (let i = 0; i < 6; i++) {
      xdo('key', 'ctrl+alt+Left');
      await sleep(60);
    }
    await sleep(200);
    const afterBack = await overlayTransform();
    log(`  Left×6 后: panX=${ctl.state.panX.toFixed(0)} | ${afterBack}`);
    // 极端：再按 20 次 Left，origin 应钳在 0，不出 NaN/不穿屏
    for (let i = 0; i < 20; i++) {
      xdo('key', 'ctrl+alt+Left');
    }
    await sleep(250);
    const clamped = await overlayTransform();
    log(`  Left×20 钳制后: panX=${ctl.state.panX.toFixed(0)} | ${clamped}（origin 应=0 无 NaN）`);
    xdo('key', 'ctrl+alt+Right');
    xdo('key', 'ctrl+alt+Right');
    await sleep(200);

    // ========== ⑤ paused 冻结 ==========
    log('\n== ⑤ paused 冻结 ==');
    xdo('mousemove', '600', '450');
    await sleep(250);
    const prePause = await overlayTransform();
    const paused = ctl.togglePause();
    await sleep(150);
    const hudPaused = await ov.webContents.executeJavaScript(
      "(function(){var h=document.getElementById('hud');return h.style.display+':'+h.textContent.replace(/\\n/g,' | ');})()"
    );
    log(`  togglePause -> paused=${paused}; HUD: ${hudPaused}`);
    xdo('mousemove', '300', '300'); // 冻结后移动鼠标
    await sleep(400);
    const duringPause1 = await overlayTransform();
    await sleep(250);
    const duringPause2 = await overlayTransform();
    log(`  冻结中移动鼠标: 画面1=${duringPause1}`);
    log(`  冻结中画面2(250ms后): ${duringPause2}（应与画面1完全一致=真冻结）`);
    log(`  冻结不变校验: ${prePause === duringPause1 ? 'PASS（定格）' : 'FAIL（仍在动）'}`);
    await shotOverlay('qa-v26-zoom-paused.png');
    // 冻结态下方向键仍可平移（定格画面查看）
    xdo('key', 'ctrl+alt+Right');
    await sleep(200);
    const panWhilePaused = await overlayTransform();
    log(`  冻结中平移: ${panWhilePaused}（应已移动）`);
    // 恢复
    ctl.togglePause();
    await sleep(200);
    xdo('mousemove', '500', '500');
    const afterResume = await measureSettle();
    log(`  恢复后移动鼠标: ${afterResume.ms}ms 稳定 | ${afterResume.transform}（应恢复跟随）`);

    // ========== ⑥ 放大态可操作性（点击穿透 + 输入） ==========
    log('\n== ⑥ 放大态可操作性（zoomClickThrough=true） ==');
    const btnRect = await contentWin.webContents.executeJavaScript(
      "(function(){var r=document.getElementById('btnPlay').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()"
    );
    const br = JSON.parse(btnRect);
    const bx = Math.round(60 + br.x + br.w / 2);
    const by = Math.round(50 + 44 + br.y + br.h / 2);
    xdo('mousemove', String(bx), String(by));
    await sleep(300);
    xdo('click', '1');
    await sleep(300);
    const clickInfo = await contentWin.webContents.executeJavaScript(
      "document.getElementById('clickInfo').textContent"
    );
    log(`  8x 放大态点击「开始朗读」按钮@(${bx},${by}) -> ${clickInfo}（非 0 = 点击穿透生效，放大态可操作）`);
    const inputRect = await contentWin.webContents.executeJavaScript(
      "(function(){var r=document.getElementById('txt').getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()"
    );
    const ir = JSON.parse(inputRect);
    const ix = Math.round(60 + ir.x + ir.w / 2);
    const iy = Math.round(50 + 44 + ir.y + ir.h / 2);
    xdo('mousemove', String(ix), String(iy));
    await sleep(200);
    xdo('click', '1');
    await sleep(200);
    const focused = await contentWin.webContents.executeJavaScript('document.hasFocus()');
    xdo('type', 'LensZoomOK');
    await sleep(300);
    const typed = await contentWin.webContents.executeJavaScript(
      "document.getElementById('txt').value"
    );
    log(`  放大态输入: 内容窗口焦点=${focused} 输入框值="${typed}"（LensZoomOK = 放大态可输入）`);

    // ========== ⑦ 色彩模式（反色 / 高对比灰度） ==========
    log('\n== ⑦ 色彩模式 ==');
    xdo('mousemove', '300', '300');
    await sleep(250);
    settings.zoomColorMode = 'invert';
    await sleep(500);
    await shotOverlay('qa-v26-zoom-8x-invert.png');
    log('  反色截图完成');
    settings.zoomColorMode = 'hicontrast';
    await sleep(500);
    await shotOverlay('qa-v26-zoom-8x-hicontrast.png');
    log('  高对比灰度截图完成');
    settings.zoomColorMode = 'normal';
    await sleep(300);

    // ========== ⑧ 缩回 1x 平滑退出（真热键 Ctrl+Alt+0） ==========
    log('\n== ⑧ 缩回 1x 自动退出（真热键 Ctrl+Alt+0） ==');
    const tExit0 = Date.now();
    xdo('key', 'ctrl+alt+0');
    await waitFor(() => ctl.state.exiting, 1500);
    await sleep(120);
    log(`  退出中: exiting=${ctl.state.exiting} zoom=${ctl.state.zoom.toFixed(2)} target=${ctl.state.targetZoom}`);
    const tDeact = await waitFor(() => !ctl.state.active, 5000);
    const exitMs = Date.now() - tExit0;
    log(`  缩回 1x 完成: active=${ctl.state.active} zoom=${ctl.state.zoom.toFixed(2)} 全程 ${exitMs}ms（平滑退出）`);
    const wins = BrowserWindow.getAllWindows();
    log(`  残留窗口检查: 窗口数=${wins.length}（应=1 仅内容窗口）overlay.isVisible()=${ov && !ov.isDestroyed() ? ov.isVisible() : 'n/a'}`);
    await sleep(300);
    await shotWindow(contentWin, 'qa-v26-zoom-exited.png');
    log('  退出后桌面截图完成（应无 overlay 残留）');

    // ========== ⑨ 语音播报能力检查 ==========
    log('\n== ⑨ 语音播报（speechSynthesis） ==');
    try {
      const voice = await ov.webContents.executeJavaScript(
        "(function(){try{return JSON.stringify({has:('speechSynthesis' in window),voices:speechSynthesis.getVoices().length});}catch(e){return 'ERR '+e.message;}})()"
      );
      log(`  overlay speechSynthesis: ${voice}（沙箱无语音引擎时 voices=0，代码静默降级；真机 Windows 走 SAPI）`);
    } catch (e) {
      log('  语音检查失败: ' + e.message);
    }

    ctl.stop();
    log('\n== 探针结束 ==');
    log('截图清单: ' + shots.join(', '));
  } catch (e) {
    log('probe failed: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }
  setTimeout(() => app.exit(0), 400);
});
setTimeout(() => app.exit(1), 90000);
