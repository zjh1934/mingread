// W-L1 探针：划词抓取延迟（常驻宿主 vs 一次性兜底）
//   PowerShell 里跑： $env:ELECTRON_RUN_AS_NODE=$null; .\node_modules\electron\dist\electron.exe scripts/tmp_probe_WL1_capture.js
//
// 真实验证路径：本脚本起一个真实 BrowserWindow，在 textarea 里 select() 出选区，
// 再把窗口顶到前台，然后走真实 captureSelection（宿主内 WScript.Shell.SendKeys('^c')），
// 与"一次性 powershell + Node 轮询"的旧路径做同条件对照。
'use strict';

const { app, BrowserWindow, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { initCaptureHost, resetCaptureHost, getCaptureHost } = require('../src/main/platform/captureHost');
const { captureSelection, captureSelectionOneShot } = require('../src/main/platform/keystroke');
const { readSelection } = require('../src/main/selectionReader');

const ROUNDS = 10;
const ONESHOT_ROUNDS = 3;
const TIMEOUT_MS = 1200;
const POLL_MS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const pick = (q) => (s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : null);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s.length ? s[0] : null,
    p50: pick(0.5),
    p95: pick(0.95),
    max: s.length ? s[s.length - 1] : null,
    avg: s.length ? +(sum / s.length).toFixed(1) : null,
  };
}

function html(text) {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `data:text/html;charset=utf-8,${encodeURIComponent(
    `<html><body style="margin:0;background:#fff"><textarea id="t" style="width:96vw;height:80vh;font-size:18px">${safe}</textarea></body></html>`
  )}`;
}

async function selectAll(win, text) {
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.webContents.focus();
  await win.webContents.executeJavaScript(
    `(() => { const t = document.getElementById('t'); t.value = ${JSON.stringify(text)}; t.focus(); t.select(); return document.activeElement === t && t.selectionEnd === t.value.length; })()`
  );
  await sleep(60); // 让焦点切换在系统层落地（SendKeys 打到前台窗口）
}

async function deselect(win) {
  win.focus();
  win.webContents.focus();
  await win.webContents.executeJavaScript(
    `(() => { const t = document.getElementById('t'); t.focus(); t.setSelectionRange(0, 0); return true; })()`
  );
  await sleep(60);
}

(async () => {
  const report = { ok: false, checks: {}, samples: {}, stats: {}, oneshot: {}, e2e: {}, notes: [] };
  let win = null;
  try {
    await app.whenReady();
    win = new BrowserWindow({ width: 700, height: 260, show: true, title: 'WL1-capture-probe' });
    await win.loadURL(html('初始文本'));
    win.setAlwaysOnTop(true);
    win.focus();
    await sleep(300);

    // 0) 预热（幂等）：应用启动时调用一次，把 PowerShell 冷启动支付掉
    const warm = await initCaptureHost();
    const tIdem = Date.now();
    const warmAgain = await initCaptureHost();
    report.warm = { ...warm, secondCallMs: Date.now() - tIdem, sameInstance: getCaptureHost().isRunning };
    report.checks.warmOk = !!warm.ok && !!warmAgain.ok;
    report.checks.warmIdempotent = report.warm.secondCallMs < 5;

    // 1) 常驻宿主：连续 10 次真抓取
    const hostSamples = [];
    let hostAllMatch = true;
    for (let i = 1; i <= ROUNDS; i += 1) {
      const text = `W-L1-宿主样本-${String(i).padStart(2, '0')}-朗读女Neo划词延迟探针`;
      await selectAll(win, text);
      const before = clipboard.readText() || '';
      const t0 = Date.now();
      const r = await captureSelection({ before, timeoutMs: TIMEOUT_MS, pollMs: POLL_MS, readClipboard: () => clipboard.readText() || '' });
      const wall = Date.now() - t0;
      const trimmed = (r.text || '').trim();
      const match = !!r.ok && trimmed === text;
      if (!match) hostAllMatch = false;
      hostSamples.push({ i, ok: r.ok, via: r.via, tookMs: r.tookMs, wallMs: wall, sendTookMs: r.sendTookMs, match, got: trimmed.slice(0, 24), timedOut: r.timedOut, stage: r.stage });
      await sleep(30);
    }
    report.samples.host = hostSamples;
    report.stats.host = stats(hostSamples.filter((s) => s.ok).map((s) => s.tookMs));
    report.stats.hostWall = stats(hostSamples.filter((s) => s.ok).map((s) => s.wallMs));
    // 稳态（排除第 1 次）：首次抓取还要付 SendKeys 的首次互操作开销，属于一次性成本
    report.stats.hostSteady = stats(hostSamples.slice(1).filter((s) => s.ok).map((s) => s.tookMs));
    report.checks.hostAllHit = hostAllMatch;
    report.checks.hostAllViaHost = hostSamples.every((s) => s.via === 'host');
    report.checks.hostP95Under150 = report.stats.host.p95 != null && report.stats.host.p95 <= 150;

    // 2) 一次性兜底对照（同条件，3 次就够：每次都要付 PowerShell 冷启动）
    const oneSamples = [];
    for (let i = 1; i <= ONESHOT_ROUNDS; i += 1) {
      const text = `W-L1-兜底样本-${String(i).padStart(2, '0')}-一次性进程对照`;
      await selectAll(win, text);
      const before = clipboard.readText() || '';
      const t0 = Date.now();
      const r = await captureSelectionOneShot({ before, timeoutMs: TIMEOUT_MS, pollMs: 15, readClipboard: () => clipboard.readText() || '' });
      oneSamples.push({ i, ok: r.ok, via: r.via, tookMs: r.tookMs, wallMs: Date.now() - t0, sendTookMs: r.sendTookMs, match: !!r.ok && (r.text || '').trim() === text });
      await sleep(30);
    }
    report.oneshot.samples = oneSamples;
    report.oneshot.stats = stats(oneSamples.filter((s) => s.ok).map((s) => s.tookMs));
    report.checks.oneshotAllHit = oneSamples.every((s) => s.match);

    // 3) 真实入口（热键 → readSelection），含备份/还原
    const originalClip = 'W-L1-原始剪贴板-应被原样还原';
    const e2e = [];
    for (let i = 1; i <= 3; i += 1) {
      const text = `W-L1-入口样本-${i}-热键路径`;
      clipboard.writeText(originalClip);
      await selectAll(win, text);
      const t0 = Date.now();
      const r = await readSelection({ timeoutMs: TIMEOUT_MS });
      const wall = Date.now() - t0;
      e2e.push({
        i,
        code: r.code,
        source: r.source,
        ok: r.ok,
        tookMs: r.tookMs,
        wallMs: wall,
        via: r.detail && r.detail.via,
        sendTookMs: r.detail && r.detail.sendTookMs,
        match: r.ok && (r.text || '').trim() === text,
        clipboardRestored: (clipboard.readText() || '') === originalClip,
      });
      await sleep(30);
    }
    report.e2e.samples = e2e;
    report.e2e.stats = stats(e2e.filter((s) => s.ok).map((s) => s.tookMs));
    report.checks.e2eAllHit = e2e.every((s) => s.match);
    report.checks.e2eClipboardRestored = e2e.every((s) => s.clipboardRestored);

    // 4) 语义红线：没有选区时必须 NO_SELECTION，绝不把旧剪贴板读出来
    clipboard.writeText('W-L1-旧剪贴板-不许被当成选区');
    await deselect(win);
    const rNo = await readSelection({ timeoutMs: 700 });
    report.semantic = {
      code: rNo.code,
      source: rNo.source,
      stale: rNo.stale,
      ok: rNo.ok,
      len: (rNo.text || '').length,
      tookMs: rNo.tookMs,
      via: rNo.detail && rNo.detail.via,
      clipboardAfter: clipboard.readText() || '',
    };
    report.checks.noSelectionNotSilent = rNo.code === 'NO_SELECTION' && !rNo.ok && rNo.source === 'none' && (rNo.text || '') === '';

    // 5) 宿主被外部杀掉后能否自动重建（防"退化成永久一次性通道"）
    const h = getCaptureHost();
    const pidBefore = h._proc ? h._proc.pid : -1;
    if (h._proc) h._proc.kill();
    await sleep(400);
    report.rebuild = { pidBefore, aliveAfterKill: h.isRunning };
    await selectAll(win, 'W-L1-重建样本-宿主被杀后自动重建');
    const rRb = await captureSelection({ before: clipboard.readText() || '', timeoutMs: TIMEOUT_MS, pollMs: POLL_MS, readClipboard: () => clipboard.readText() || '' });
    report.rebuild.after = { ok: rRb.ok, via: rRb.via, tookMs: rRb.tookMs, sendTookMs: rRb.sendTookMs, pidAfter: h._proc ? h._proc.pid : -1, match: !!rRb.ok && (rRb.text || '').trim() === 'W-L1-重建样本-宿主被杀后自动重建' };
    report.checks.hostAutoRebuild = report.rebuild.after.ok && report.rebuild.after.via === 'host' && report.rebuild.after.pidAfter !== pidBefore;

    // 6) 宿主起不来时是否自动回退一次性通道（注入一个 start 必失败的宿主）
    const brokenHost = {
      capture: async () => {
        const e = new Error('抓取通道启动失败（模拟）：spawn ENOENT');
        e.stage = 'start';
        throw e;
      },
    };
    await selectAll(win, 'W-L1-回退样本-宿主不可用回退一次性');
    const tFb = Date.now();
    const rFb = await captureSelection({
      before: clipboard.readText() || '',
      timeoutMs: TIMEOUT_MS,
      readClipboard: () => clipboard.readText() || '',
      host: brokenHost,
    });
    report.fallback = {
      ok: rFb.ok,
      via: rFb.via,
      tookMs: rFb.tookMs,
      wallMs: Date.now() - tFb,
      hostError: rFb.hostError || '',
      match: !!rFb.ok && (rFb.text || '').trim() === 'W-L1-回退样本-宿主不可用回退一次性',
    };
    report.checks.fallbackToOneshot = report.fallback.ok && report.fallback.via === 'oneshot' && report.fallback.match;

    // 7) 收尾：还原剪贴板 + 关宿主
    clipboard.writeText(originalClip);
    report.checks.hostStillRunning = !!getCaptureHost().isRunning;

    report.ok = Object.values(report.checks).every(Boolean);
  } catch (e) {
    report.error = (e && e.stack) || String(e);
  } finally {
    try {
      resetCaptureHost();
    } catch (e) {
      /* noop */
    }
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (e) {
      /* noop */
    }
  }

  console.log('\n===== WL1 capture probe =====');
  console.log(JSON.stringify(report, null, 2));
  try {
    const out = path.join(__dirname, '..', 'dist', 'probe');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'wl1-capture.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('[wl1] report -> dist/probe/wl1-capture.json');
  } catch (e) {
    console.error('[wl1] 写报告失败:', e && e.message);
  }
  app.exit(report.ok ? 0 : 3);
})();
