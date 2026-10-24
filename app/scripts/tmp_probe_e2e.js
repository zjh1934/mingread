// 端到端有声验证探针（沙箱专用，tmp_probe_* 命名，不进入产品）：
//   node scripts/tmp_probe_e2e.js
//
// 验证链路（全部走真实组件，无 mock）：
//   真实渲染进程(CDP 注入) → window.api.a11y.cue/announce（preload → ipcMain）
//     → a11yFeedback.js（隐藏音频窗口 Web Audio）
//     → ttsBridge 引擎链（SAPI 不可用 → espeak 合成 WAV）
//     → decodeAudioData + AudioContext 播放 → pulseaudio null sink → parecord 录音
//   另走真实全局热键：xdotool 发 Ctrl+Alt+R → globalShortcut → firePressCue → 出声
//
// 取证方式：pulseaudio null sink + parecord 全程录音，事后按能量切分声音段，
// 用「录音时间轴」反推 按键/调用 → 可听声音 的真实延迟。没有声卡的沙箱里，
// 这段录音就是"声音确实产生了"的直接证据（数字零静音 + 实测 peak/rms）。
'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'dist', 'probe');
const REC = '/tmp/ldn-e2e-rec.wav';
const PULSE_SERVER = 'unix:/run/pulse/native';
const DISPLAY_NUM = '99';
const CDP_PORT = 9222;
const REPORT = path.join(OUT, 'e2e-report.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.log('[e2e]', ...a);
}

// ---- pulseaudio 准备 ----
function ensurePulse() {
  try {
    execFileSync('pactl', ['info'], { env: { ...process.env, PULSE_SERVER }, stdio: 'pipe' });
  } catch (e) {
    log('pulseaudio 未就绪，启动 system 模式 + null sink');
    execFileSync('pulseaudio', ['-k'], { stdio: 'ignore' });
    fs.writeFileSync(
      '/tmp/ldn-pa.pa',
      '.nofail\nload-module module-native-protocol-unix auth-anonymous=1\n' +
        'load-module module-null-sink sink_name=ldnprobe sink_properties=device.description=LDN_Probe_Sink\n' +
        'set-default-sink ldnprobe\n'
    );
    execFileSync('pulseaudio', ['--system', '--disallow-exit', '--disallow-module-loading=false', '-n', '--file=/tmp/ldn-pa.pa', '-D'], { stdio: 'pipe' });
    for (let i = 0; i < 20; i += 1) {
      try {
        execFileSync('pactl', ['info'], { env: { ...process.env, PULSE_SERVER }, stdio: 'pipe' });
        return;
      } catch (e2) {
        execFileSync('sleep', ['0.3']);
      }
    }
    throw new Error('pulseaudio 启动失败');
  }
}

// ---- 录音分析：按 10ms 窗 RMS 切分声音段 ----
function analyzeRecording(file, t0epoch) {
  const b = fs.readFileSync(file);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12;
  let dataOff = 44;
  let bits = 16;
  let ch = 2;
  let sr = 44100;
  while (off + 8 <= b.length) {
    const id = b.slice(off, off + 4).toString('ascii');
    const sz = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      ch = dv.getUint16(off + 10, true);
      sr = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    }
    if (id === 'data') {
      dataOff = off + 8;
      break;
    }
    off += 8 + sz + (sz % 2);
  }
  const pcm = b.slice(dataOff);
  const bytesPerFrame = ch * (bits / 8);
  const frames = Math.floor(pcm.length / bytesPerFrame);
  const winFrames = Math.floor(sr * 0.01); // 10ms
  const wins = [];
  for (let w = 0; w < frames; w += winFrames) {
    const n = Math.min(winFrames, frames - w);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      const f = (w + i) * bytesPerFrame;
      const v = pcm.readInt16LE(f) / 32768; // 左声道
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    wins.push({ tMs: Math.round((w / sr) * 1000), rms: Math.sqrt(sum / Math.max(1, n)), peak });
  }
  const TH = 0.001;
  const segs = [];
  let cur = null;
  for (const w of wins) {
    const snd = w.rms > TH;
    if (snd && !cur) cur = { startMs: w.tMs, endMs: w.tMs + 10, peak: w.peak, rms: w.rms };
    else if (snd && cur) {
      cur.endMs = w.tMs + 10;
      cur.peak = Math.max(cur.peak, w.peak);
      cur.rms = Math.max(cur.rms, w.rms);
    } else if (!snd && cur) {
      if (cur.endMs - cur.startMs >= 25) segs.push(cur);
      cur = null;
    }
  }
  if (cur && cur.endMs - cur.startMs >= 25) segs.push(cur);
  const allPeak = wins.reduce((m, w) => Math.max(m, w.peak), 0);
  const allRms = Math.sqrt(wins.reduce((s, w) => s + w.rms * w.rms, 0) / Math.max(1, wins.length));
  return {
    file,
    bytes: b.length,
    sampleRate: sr,
    channels: ch,
    durationMs: Math.round((frames / sr) * 1000),
    peak: +allPeak.toFixed(4),
    rms: +allRms.toFixed(4),
    segments: segs,
    t0epoch,
  };
}

/** 录音时间轴(ms) → epoch */
const recToEpoch = (rec, ms) => rec.t0epoch + ms;

// ---- CDP ----
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function cdpEval(ws, expression, timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), timeoutMs);
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      } catch (e) {
        /* 非 JSON 帧忽略 */
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { ok: false, steps: {}, notes: [] };
  const env = { ...process.env, PULSE_SERVER, DISPLAY: `:${DISPLAY_NUM}` };

  // 0. pulse
  ensurePulse();
  log('pulseaudio null sink 就绪');

  // 1. Xvfb
  let xvfb = null;
  try {
    execFileSync('xdpyinfo', ['-display', `:${DISPLAY_NUM}`], { stdio: 'pipe' });
    log(`Xvfb :${DISPLAY_NUM} 已在运行`);
  } catch (e) {
    xvfb = spawn('Xvfb', [`:${DISPLAY_NUM}`, '-screen', '0', '1280x800x24'], { stdio: 'ignore', detached: false });
    await sleep(1500);
    log(`Xvfb :${DISPLAY_NUM} 已启动`);
  }

  // 2. 录音（全程）
  const rec = spawn('parecord', ['-d', 'ldnprobe.monitor', '--file-format=wav', REC], { env });
  const tRec = Date.now();
  log(`录音开始 t0=${tRec}`);
  await sleep(500);

  // 3. 启动真实 Electron 应用（加载构建产物）
  try {
    execFileSync('pkill', ['-x', 'electron'], { stdio: 'ignore' });
  } catch (e) {
    /* 没有残留进程 */
  }
  await sleep(500);
  const devUrl = `file://${path.join(APP, 'dist', 'renderer', 'index.html')}`;
  const logs = [];
  const el = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  el.stdout.on('data', (c) => logs.push(String(c)));
  el.stderr.on('data', (c) => logs.push(String(c)));
  log('electron 启动中…');

  // 4. 等 CDP 页面目标（主窗口 index.html）
  let target = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      target = list.find((t) => t.type === 'page' && String(t.url || '').includes('index.html'));
      if (target) break;
    } catch (e) {
      /* CDP 未起 */
    }
  }
  if (!target) {
    report.error = '未找到主窗口 CDP 目标';
    report.logs = logs.join('');
    console.error(JSON.stringify(report, null, 2));
    try { el.kill(); } catch (e) { /* noop */ }
    try { rec.kill(); } catch (e) { /* noop */ }
    process.exit(2);
  }
  log(`主窗口就绪 url=${target.url}`);

  // 5. 连 CDP
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });
  log('CDP 已连接');

  // 6. 等渲染进程桥就绪
  let bridgeReady = false;
  for (let i = 0; i < 30; i += 1) {
    const r = await cdpEval(ws, `(() => { try { return !!(window.api && window.api.a11y && typeof window.api.a11y.cue === 'function'); } catch (e) { return false; } })()`, 10000);
    if (r) { bridgeReady = true; break; }
    await sleep(500);
  }
  report.steps.bridgeReady = bridgeReady;
  if (!bridgeReady) {
    report.error = 'window.api.a11y 未就绪';
    report.logs = logs.join('');
    console.error(JSON.stringify(report, null, 2));
    try { el.kill(); } catch (e) { /* noop */ }
    try { rec.kill(); } catch (e) { /* noop */ }
    process.exit(2);
  }

  // 7. 应用自身引擎状态（真实 getBridge）
  const voiceStatus = await cdpEval(ws, `window.langdu.voice.getStatus()`, 30000);
  report.steps.appVoiceStatus = voiceStatus
    ? {
        engineId: voiceStatus.engine && voiceStatus.engine.id,
        engineLabel: voiceStatus.engine && voiceStatus.engine.label,
        ready: voiceStatus.engine && voiceStatus.engine.ready,
        degraded: voiceStatus.degraded,
        fallback: voiceStatus.fallback ? { from: voiceStatus.fallback.from, to: voiceStatus.fallback.to, reason: voiceStatus.fallback.reason } : null,
        voices: (voiceStatus.voices || []).map((v) => v.id),
        chain: voiceStatus.chain,
      }
    : null;
  log('应用引擎状态:', JSON.stringify(report.steps.appVoiceStatus));

  // 8. cue('press') 端到端延迟 ×3（先热身一次建音频窗口）
  await cdpEval(ws, `window.api.a11y.cue({ type: 'press' })`, 30000);
  await sleep(1500);
  const cueRuns = [];
  for (let i = 0; i < 3; i += 1) {
    const tCall = Date.now();
    const r = await cdpEval(
      ws,
      `(async () => { const t0 = performance.now(); const res = await window.api.a11y.cue({ type: 'press' }); return { ms: Math.round(performance.now() - t0), res }; })()`,
      30000
    );
    cueRuns.push({ i, callAt: tCall, uiToAckMs: r && r.ms, ok: !!(r && r.res && r.res.ok) });
    await sleep(1500);
  }
  report.steps.cueRuns = cueRuns;
  log('cue 延迟:', JSON.stringify(cueRuns));

  // 9. announce 全链（UI → ipc → ttsBridge → espeak → 隐藏窗口播放）
  const tAnn = Date.now();
  const ann = await cdpEval(
    ws,
    `(async () => { const t0 = performance.now(); const res = await window.api.a11y.announce({ text: '端到端播报验证：如果你能听到这句话，说明从界面到语音引擎的链路已经真正打通。', priority: 'high' }); return { ms: Math.round(performance.now() - t0), res }; })()`,
    90000
  );
  report.steps.announce = {
    callAt: tAnn,
    uiToDoneMs: ann && ann.ms,
    ok: !!(ann && ann.res && ann.res.ok),
    via: ann && ann.res && ann.res.via,
    format: ann && ann.res && ann.res.format,
    durationMs: ann && ann.res && ann.res.durationMs,
    message: ann && ann.res && ann.res.message,
  };
  log('announce:', JSON.stringify(report.steps.announce));
  await sleep(3000);

  // 10. 真实全局热键 Ctrl+Alt+R（xdotool → X → globalShortcut → firePressCue + 选区读取 → 播报）
  const tHot = Date.now();
  await new Promise((resolve) => {
    execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+alt+r'], { env }, () => resolve());
  });
  log(`全局热键 Ctrl+Alt+R 已发出 t=${tHot}`);
  await sleep(9000); // 等抓选区 + noSelection 播报播完
  const hotkeyLogs = logs.join('').split('\n').filter((l) => l.includes('[hotkey]'));
  report.steps.hotkey = {
    sentAt: tHot,
    logs: hotkeyLogs.slice(0, 12),
  };
  log('热键日志:', JSON.stringify(hotkeyLogs.slice(0, 8), null, 1));

  await sleep(2000);
  try { rec.kill('SIGINT'); } catch (e) { /* noop */ }
  await sleep(800);
  try { el.kill(); } catch (e) { /* noop */ }
  if (xvfb) {
    try { xvfb.kill(); } catch (e) { /* noop */ }
  }

  // 11. 录音分析
  if (!fs.existsSync(REC)) {
    report.error = '录音文件不存在';
    console.error(JSON.stringify(report, null, 2));
    process.exit(2);
  }
  const rec0 = analyzeRecording(REC, tRec);
  const mapSeg = (ms) => ({ at: recToEpoch(rec0, ms), startMs: ms, endMs: ms });
  report.steps.recording = {
    file: REC,
    bytes: rec0.bytes,
    sampleRate: rec0.sampleRate,
    channels: rec0.channels,
    durationMs: rec0.durationMs,
    peak: rec0.peak,
    rms: rec0.rms,
    segments: rec0.segments,
  };

  // 12. 派生指标
  const onsetAfter = (epoch) => rec0.segments.find((s) => recToEpoch(rec0, s.startMs) >= epoch - 50);
  const cueOnsets = cueRuns.map((c) => {
    const s = onsetAfter(c.callAt);
    return { i: c.i, uiToAckMs: c.uiToAckMs, soundOnsetAt: s ? recToEpoch(rec0, s.startMs) : null, callToSoundMs: s ? recToEpoch(rec0, s.startMs) - c.callAt : null, peak: s ? +s.peak.toFixed(4) : null };
  });
  const annSeg = onsetAfter(tAnn);
  const hotSeg = onsetAfter(tHot);
  const hotkeyLog = hotkeyLogs.map((l) => l.trim()).find((l) => l.includes('press cue ok'));
  const tookMatch = hotkeyLog ? /tookMs=(\d+)/.exec(hotkeyLog) : null;
  const atMatch = hotkeyLog ? /at=(\d+)/.exec(hotkeyLog) : null;
  report.steps.derived = {
    cueCallToSound: cueOnsets,
    announceCallToSoundMs: annSeg ? recToEpoch(rec0, annSeg.startMs) - tAnn : null,
    announceSegmentMs: annSeg ? annSeg.endMs - annSeg.startMs : null,
    hotkeySendToSoundMs: hotSeg ? recToEpoch(rec0, hotSeg.startMs) - tHot : null,
    hotkeyMainTookMs: tookMatch ? Number(tookMatch[1]) : null,
    hotkeyKeyEventAt: atMatch ? Number(atMatch[1]) : null,
    hotkeyKeyEventToSoundMs: atMatch && hotSeg ? recToEpoch(rec0, hotSeg.startMs) - Number(atMatch[1]) : null,
  };
  report.logs = logs.join('').slice(-4000);

  // 13. 判定
  const checks = {
    recordingHasEnergy: rec0.peak > 0.01 && rec0.rms > 0.001,
    appEngineIsEspeak: report.steps.appVoiceStatus && report.steps.appVoiceStatus.engineId === 'espeak',
    appDegradedReasonVisible: !!(report.steps.appVoiceStatus && report.steps.appVoiceStatus.degraded && report.steps.appVoiceStatus.fallback),
    cuePlayed: cueOnsets.every((c) => c.callToSoundMs != null && c.peak > 0.01),
    cueAckFast: cueOnsets.every((c) => c.uiToAckMs != null && c.uiToAckMs <= 200),
    announcePlayed: report.steps.announce.ok && report.steps.announce.via === 'tts' && report.steps.announce.format === 'wav' && annSeg != null,
    announceAudioLongEnough: annSeg != null && annSeg.endMs - annSeg.startMs >= 1000,
    hotkeyPlayed: hotSeg != null,
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n===== E2E 报告 =====');
  console.log(JSON.stringify({ ok: report.ok, checks, derived: report.steps.derived, recording: { bytes: rec0.bytes, peak: rec0.peak, rms: rec0.rms, segments: rec0.segments.length } }, null, 2));
  console.log(`报告已写入 ${REPORT}`);
  process.exit(report.ok ? 0 : 3);
})().catch((e) => {
  console.error('[e2e] 探针自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
