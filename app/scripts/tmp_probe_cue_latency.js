// E2E 探针 F：热键按下 → 反馈音延迟（基线指标 E：≤200ms）
//   node scripts/tmp_probe_cue_latency.js
//
// 测法（pulseaudio null sink + parecord 全程录音，10ms 窗 RMS 能量切段）：
//   A. 管道基准：CDP 直调 cue('press')，tCallA(node 时钟) → 录音 onset，得到取证管道偏移
//      （含 pulse monitor 采集延迟；真实用户声卡无此段，数字偏保守）。
//   B. 热键：xdotool key ctrl+alt+r → globalShortcut → 主进程热键回调第一行 firePressCue
//      → a11yFeedback.cue('press') 在常驻隐藏音频窗口播放 → 录音 onset。
//      主进程日志同时给出 tookMs（回调入口 → cue IPC 完成）与 at=（按键事件到达 epoch）。
// 报告：发键→可闻、事件到达→可闻（扣基准）、主进程处理耗时。
'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'dist', 'probe');
const REC = '/tmp/ldn-cue-rec.wav';
const PULSE_SERVER = 'unix:/run/pulse/native';
const DISPLAY_NUM = process.env.PROBE_DISPLAY || '77';
const CDP_PORT = 9225;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[cue-latency]', ...a);

const spawned = [];
function spawnTracked(cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, detached: true });
  spawned.push(p);
  return p;
}
function killTracked() {
  for (const p of spawned) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { try { p.kill('SIGKILL'); } catch (e2) { /* noop */ } }
  }
  spawned.length = 0;
}

function pulseReady() {
  try {
    execFileSync('pactl', ['info'], { env: { ...process.env, PULSE_SERVER }, stdio: 'pipe' });
    return true;
  } catch (e) { return false; }
}

function analyzeRecording(file, t0epoch) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let dataOff = 44;
  let ch = 2;
  let sr = 44100;
  while (off + 8 <= b.length) {
    const id = b.slice(off, off + 4).toString('ascii');
    const sz = dv.getUint32(off + 4, true);
    if (id === 'fmt ') { ch = dv.getUint16(off + 10, true); sr = dv.getUint32(off + 12, true); }
    if (id === 'data') { dataOff = off + 8; break; }
    off += 8 + sz + (sz % 2);
  }
  const pcm = b.slice(dataOff);
  const bytesPerFrame = ch * 2;
  const frames = Math.floor(pcm.length / bytesPerFrame);
  const winFrames = Math.floor(sr * 0.01);
  const wins = [];
  for (let w = 0; w < frames; w += winFrames) {
    const n = Math.min(winFrames, frames - w);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = pcm.readInt16LE((w + i) * bytesPerFrame) / 32768;
      sum += v * v;
    }
    wins.push({ tMs: Math.round((w / sr) * 1000), rms: Math.sqrt(sum / Math.max(1, n)) });
  }
  const TH = 0.001;
  const segs = [];
  let cur = null;
  for (const w of wins) {
    const snd = w.rms > TH;
    if (snd && !cur) cur = { startMs: w.tMs, endMs: w.tMs + 10 };
    else if (snd && cur) cur.endMs = w.tMs + 10;
    else if (!snd && cur) { if (cur.endMs - cur.startMs >= 25) segs.push(cur); cur = null; }
  }
  if (cur && cur.endMs - cur.startMs >= 25) segs.push(cur);
  return { segs, t0epoch, toEpoch: (ms) => t0epoch + ms };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpEval(ws, expression, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error('CDP 超时')), timeoutMs);
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      } catch (e) { /* 非 JSON */ }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

function xdo(args) {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { env: { ...process.env, DISPLAY: `:${DISPLAY_NUM}` } }, (e, so, se) => {
      if (e) reject(new Error(String(se || e.message))); else resolve(String(so || '').trim());
    });
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, DISPLAY: `:${DISPLAY_NUM}` };
  const report = { ok: false, steps: {} };
  const hasPulse = pulseReady();
  log('pulseaudio 就绪:', hasPulse);

  // external 程序：提供真实选区（热键走 source=selection 成功路径，避免 NO_SELECTION
  // 失败播报占用录音时间轴、干扰 press cue 段切分）
  const ext = spawnTracked(path.join(APP, 'node_modules', '.bin', 'electron'), [path.join('scripts', 'probe-e2e-external.js'), '--no-sandbox', '--disable-gpu'], {
    cwd: APP, env, stdio: 'ignore',
  });
  await sleep(3500);
  const extWid = await xdo(['search', '--name', 'external-text']);
  if (!extWid) { console.error('未找到 external 窗口'); killTracked(); process.exit(2); }
  const geo = await xdo(['getwindowgeometry', '--shell', extWid]);
  const gx = Number(/X=(\d+)/.exec(geo)[1]);
  const gy = Number(/Y=(\d+)/.exec(geo)[1]);
  await xdo(['windowactivate', extWid]);
  await sleep(500);
  await xdo(['mousemove', String(gx + 25), String(gy + 36), 'mousedown', '1', 'mousemove', '--sync', String(gx + 400), String(gy + 36), 'mouseup', '1']);
  log(`external 选区就绪 wid=${extWid}`);

  const devUrl = `file://${path.join(APP, 'dist', 'renderer', 'index.html')}`;
  const main = spawnTracked(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  main.stdout.on('data', (c) => logs.push(String(c)));
  main.stderr.on('data', (c) => logs.push(String(c)));

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      target = list.find((t) => t.type === 'page' && String(t.url || '').includes('index.html'));
      if (target) break;
    } catch (e) { /* CDP 未起 */ }
  }
  if (!target) { console.error('未找到主窗口 CDP'); killTracked(); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 失败')), { once: true });
  });
  for (let i = 0; i < 20; i += 1) {
    const r = await cdpEval(ws, `!!(window.api && window.api.a11y && window.api.a11y.cue)`, 10000).catch(() => false);
    if (r) break;
    await sleep(500);
  }
  log('主进程就绪，音频窗口预热中');

  // 音频窗口 CDP：注入 __playCue 计数器（仅运行时注入，不改产品文件），
  // 直接证明每次热键 press cue 是否真的到达音频窗口并被调用
  let audioWs = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const at = list.find((t) => t.type === 'page' && String(t.url || '').startsWith('data:text/html'));
      if (at) {
        audioWs = new WebSocket(at.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          audioWs.addEventListener('open', resolve, { once: true });
          audioWs.addEventListener('error', () => reject(new Error('audio ws')), { once: true });
        });
        await cdpEval(audioWs, `window.__cueLog = []; (function () { var o = window.__playCue; window.__playCue = function (t) { window.__cueLog.push({ t: performance.now(), type: t }); return o.apply(this, arguments); }; })(); true`, 10000);
        log('音频窗口计数器已注入');
        break;
      }
    } catch (e) { /* 音频窗口未起 */ }
    await sleep(500);
  }

  let rec = null;
  let tRec = 0;
  if (hasPulse) {
    try { fs.unlinkSync(REC); } catch (e) { /* noop */ }
    rec = spawnTracked('parecord', ['-d', 'ldnprobe.monitor', '--file-format=wav', REC], { env: { ...process.env, PULSE_SERVER } });
    tRec = Date.now();
    log(`录音开始 t0=${tRec}`);
  }
  await sleep(2500); // 等音频窗口/AudioContext 就绪

  // 热身：第一次 cue 建 AudioContext
  await cdpEval(ws, `window.api.a11y.cue({ type: 'press' })`, 30000);
  await sleep(2000);

  // A. 管道基准 ×2
  const baseline = [];
  for (let i = 0; i < 2; i += 1) {
    await sleep(1200);
    const tCall = Date.now();
    await cdpEval(ws, `(async () => { await window.api.a11y.cue({ type: 'press' }); return true; })()`, 30000);
    baseline.push(tCall);
    await sleep(1200);
  }
  report.steps.baselineCalls = baseline;

  // B. 热键 ×4
  const hotRuns = [];
  for (let i = 0; i < 4; i += 1) {
    await sleep(1500);
    await xdo(['windowactivate', extWid]); // 保持焦点在 external（readSelection 的 ctrl+c 要有接收者）
    await xdo(['key', '--clearmodifiers', 'ctrl+alt+r']);
    const tSend = Date.now(); // xdotool 已返回，键已注入
    await sleep(2500);
    let cueLog = null;
    if (audioWs) {
      cueLog = await cdpEval(audioWs, `JSON.stringify({ log: window.__cueLog, state: window.__audioState() })`, 10000).catch(() => null);
    }
    hotRuns.push({ i, tSend, cueLog });
  }
  report.steps.hotkeyRuns = hotRuns;
  report.steps.tRec = tRec;

  if (rec) { try { rec.kill('SIGINT'); } catch (e) { /* noop */ } }
  await sleep(800);
  killTracked();

  // 主进程日志
  const text = logs.join('');
  const cueLines = text.split('\n').filter((l) => l.includes('[hotkey] press cue')).map((l) => l.trim());
  const regLine = text.split('\n').find((l) => l.includes('[hotkey] register'));
  log('热键日志:', JSON.stringify(cueLines, null, 1));
  report.steps.register = regLine ? regLine.trim() : null;
  report.steps.cueLines = cueLines;

  if (!hasPulse || !fs.existsSync(REC)) {
    // 无录音：只报主进程处理耗时
    const tooks = cueLines.map((l) => { const m = /tookMs=(\d+)/.exec(l); return m ? Number(m[1]) : null; }).filter((x) => x != null);
    report.steps.mainTookMs = tooks;
    report.ok = cueLines.length >= 4 && tooks.every((t) => t <= 200);
    fs.writeFileSync(path.join(OUT, 'cue-latency-report.json'), JSON.stringify(report, null, 2));
    console.log('\n===== 反馈音延迟报告（无录音） =====');
    console.log(JSON.stringify({ ok: report.ok, mainTookMs: tooks }, null, 2));
    process.exit(report.ok ? 0 : 3);
  }

  const rec0 = analyzeRecording(REC, tRec);
  const onsetAfter = (epoch) => {
    const s = rec0.segs.find((x) => rec0.toEpoch(x.startMs) >= epoch - 50);
    return s ? rec0.toEpoch(s.startMs) : null;
  };
  // 基准：每次 cue 调用后第一个段
  const baseOnsets = baseline.map((t) => onsetAfter(t)).filter((x) => x != null);
  const baseOffsets = baseline.map((t, i) => (baseOnsets[i] != null ? baseOnsets[i] - t : null)).filter((x) => x != null);
  const pipeOffsetMs = baseOffsets.length ? Math.round(baseOffsets.reduce((a, b) => a + b, 0) / baseOffsets.length) : null;
  log(`取证管道基准（cue 调用→录音 onset）: ${baseOffsets.join(', ')}ms → 均值 ${pipeOffsetMs}ms`);

  const hotResults = hotRuns.map((r, idx) => {
    const onset = onsetAfter(r.tSend);
    const cueLine = cueLines[idx] || '';
    const tookM = /tookMs=(\d+)/.exec(cueLine);
    const atM = /at=(\d+)/.exec(cueLine);
    return {
      i: r.i,
      sendToSoundMs: onset != null ? onset - r.tSend : null,
      keyEventAt: atM ? Number(atM[1]) : null,
      keyEventToSoundMs: onset != null && atM ? onset - Number(atM[1]) : null,
      mainTookMs: tookM ? Number(tookM[1]) : null,
      // 扣除取证管道后的用户可闻延迟估计（按键事件到达主进程 → 声音）
      userAudibleEstMs: onset != null && atM && pipeOffsetMs != null ? onset - Number(atM[1]) - pipeOffsetMs : null,
    };
  });
  report.steps.hotResults = hotResults;
  report.steps.pipeOffsetMs = pipeOffsetMs;

  const sendToSound = hotResults.map((r) => r.sendToSoundMs).filter((x) => x != null);
  const audibleEst = hotResults.map((r) => r.userAudibleEstMs).filter((x) => x != null);
  const tooks = hotResults.map((r) => r.mainTookMs).filter((x) => x != null);
  const checks = {
    hotkeyRegistered: !!regLine && /ok=true/.test(regLine),
    allSendToSoundUnder200: sendToSound.length === hotRuns.length && sendToSound.every((x) => x <= 200),
    allAudibleEstUnder200: audibleEst.length === hotRuns.length && audibleEst.every((x) => x <= 200),
    mainTookFast: tooks.length === hotRuns.length && tooks.every((x) => x <= 100),
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);

  fs.writeFileSync(path.join(OUT, 'cue-latency-report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 反馈音延迟报告 =====');
  console.log(JSON.stringify({
    ok: report.ok,
    checks,
    pipeOffsetMs,
    hotResults,
    maxSendToSoundMs: Math.max(...sendToSound),
    maxAudibleEstMs: audibleEst.length ? Math.max(...audibleEst) : null,
    mainTookMs: tooks,
  }, null, 2));
  process.exit(report.ok ? 0 : 3);
})().catch((e) => {
  console.error('[cue-latency] 探针自身异常：', e && e.stack ? e.stack : e);
  killTracked();
  process.exit(2);
});
