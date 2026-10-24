// E2E 探针 E：复制即读（v2.3.1 基线 P1-9）+ 真实划词热键
//   node scripts/tmp_probe_clip_e2e.js
//
// 全部走真实组件：
//   external（probe-e2e-external.js，Chromium 窗口，Ctrl+C 原生写剪贴板=真实用户复制）
//   → clipboardMonitor（900ms 轮询，默认开）→ clipboard:new(autoRead=true)
//   → renderer 自动朗读（espeak）→ pulseaudio null sink 全程录音取证。
// 另验证：节流（1.5s 内连复制两条 → throttled + trailing flush）、
//         长度上限（>20000 字 → 不朗读 + 语音播报）、
//         真实划词（external 选区 → Ctrl+Alt+R → readSelection source=selection）。
'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'dist', 'probe');
const REC = '/tmp/ldn-clip-rec.wav';
const PULSE_SERVER = 'unix:/run/pulse/native';
const DISPLAY_NUM = process.env.PROBE_DISPLAY || '77';
const MAIN_CDP = 9234;
const EXT_CDP = 9343;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[clip-e2e]', ...a);

// 进程组精确清理（不用 pkill：环境里可能有其他会话的 electron 在跑，误杀会破坏他人验证）
const spawned = [];
function spawnTracked(cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, detached: true });
  spawned.push(p);
  return p;
}
function killTracked() {
  for (const p of spawned) {
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) {
      try { p.kill('SIGKILL'); } catch (e2) { /* noop */ }
    }
  }
  spawned.length = 0;
}

// ---- pulseaudio（与 tmp_probe_e2e 相同准备）----
function ensurePulse() {
  try {
    execFileSync('pactl', ['info'], { env: { ...process.env, PULSE_SERVER }, stdio: 'pipe' });
    return;
  } catch (e) { /* 继续启动 */ }
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
    } catch (e2) { execFileSync('sleep', ['0.3']); }
  }
  throw new Error('pulseaudio 启动失败');
}

// ---- 录音分析（10ms 窗 RMS 切段，同 tmp_probe_e2e）----
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
    if (id === 'data') { dataOff = off + 8; break; }
    off += 8 + sz + (sz % 2);
  }
  const pcm = b.slice(dataOff);
  const bytesPerFrame = ch * (bits / 8);
  const frames = Math.floor(pcm.length / bytesPerFrame);
  const winFrames = Math.floor(sr * 0.01);
  const wins = [];
  for (let w = 0; w < frames; w += winFrames) {
    const n = Math.min(winFrames, frames - w);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      const f = (w + i) * bytesPerFrame;
      const v = pcm.readInt16LE(f) / 32768;
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
    if (snd && !cur) cur = { startMs: w.tMs, endMs: w.tMs + 10, peak: w.peak };
    else if (snd && cur) { cur.endMs = w.tMs + 10; cur.peak = Math.max(cur.peak, w.peak); }
    else if (!snd && cur) { if (cur.endMs - cur.startMs >= 25) segs.push(cur); cur = null; }
  }
  if (cur && cur.endMs - cur.startMs >= 25) segs.push(cur);
  return { segs, t0epoch, toEpoch: (ms) => t0epoch + ms };
}

// ---- CDP ----
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpEval(ws, expression, timeoutMs = 60000) {
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
      } catch (e) { /* 非 JSON 帧 */ }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

async function connectPage(port, match, label) {
  const ok = (t) => t.type === 'page' && (String(t.url || '').includes(match) || String(t.title || '').includes(match));
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      const list = await httpGetJson(`http://127.0.0.1:${port}/json`);
      target = list.find(ok);
      if (target) break;
    } catch (e) { /* CDP 未起 */ }
  }
  if (!target) throw new Error(`未找到 ${label} CDP 目标`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 失败')), { once: true });
  });
  return ws;
}

function xdo(args) {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { env: { ...process.env, DISPLAY: `:${DISPLAY_NUM}` } }, (e, so, se) => {
      if (e) reject(new Error(String(se || e.message)));
      else resolve(String(so || '').trim());
    });
  });
}

/** 在 external 窗口里鼠标拖选一行文字（窗口相对坐标，含 openbox 标题栏偏移） */
async function dragSelectLine(wid, relY, relX1, relX2) {
  const geo = await xdo(['getwindowgeometry', '--shell', wid]);
  const wx = Number(/X=(\d+)/.exec(geo)[1]);
  const wy = Number(/Y=(\d+)/.exec(geo)[1]);
  const y = wy + relY;
  await xdo(['mousemove', String(wx + relX1), String(y), 'mousedown', '1',
    'mousemove', '--sync', String(wx + relX2), String(y), 'mouseup', '1']);
  await sleep(120);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, PULSE_SERVER, DISPLAY: `:${DISPLAY_NUM}` };
  const report = { ok: false, steps: {} };

  killTracked();
  await sleep(500);
  ensurePulse();
  log('pulseaudio null sink 就绪');

  // 1. 全程录音
  try { fs.unlinkSync(REC); } catch (e) { /* noop */ }
  const rec = spawn('parecord', ['-d', 'ldnprobe.monitor', '--file-format=wav', REC], { env });
  const tRec = Date.now();
  log(`录音开始 t0=${tRec}`);
  await sleep(500);

  // 2. external 程序（带 CDP）
  const ext = spawnTracked(path.join(APP, 'node_modules', '.bin', 'electron'), [path.join('scripts', 'probe-e2e-external.js'), '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${EXT_CDP}`], {
    cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extLogs = [];
  ext.stdout.on('data', (c) => extLogs.push(String(c)));
  ext.stderr.on('data', (c) => extLogs.push(String(c)));
  await sleep(3500);
  const extWid = await xdo(['search', '--name', 'external-text']);
  if (!extWid) { console.error('未找到 external 窗口'); try { ext.kill(); } catch (e) { /* noop */ } process.exit(2); }
  await xdo(['windowactivate', extWid]);
  await sleep(800);
  log('external 窗口就绪 wid=' + extWid);

  // 3. 主进程
  const devUrl = `file://${path.join(APP, 'dist', 'renderer', 'index.html')}`;
  const main = spawnTracked(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${MAIN_CDP}`], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mainLogs = [];
  main.stdout.on('data', (c) => mainLogs.push(String(c)));
  main.stderr.on('data', (c) => mainLogs.push(String(c)));
  const mainWs = await connectPage(MAIN_CDP, 'index.html', '主窗口');
  for (let i = 0; i < 20; i += 1) {
    const r = await cdpEval(mainWs, `!!(window.api && window.api.a11y)`, 10000).catch(() => false);
    if (r) break;
    await sleep(500);
  }
  log('主进程就绪');
  await sleep(1000);

  // 4. 复制①（真实 Ctrl+C）：点第一行文字 → shift+Home → ctrl+c
  await xdo(['windowactivate', extWid]);
  await sleep(400);
  await dragSelectLine(extWid, 36, 25, 400);
  const tCopy1 = Date.now();
  await xdo(['key', '--clearmodifiers', 'ctrl+c']);
  log(`复制①已发出 t=${tCopy1}`);
  await sleep(600); // 紧凑：让复制②落在 1.5s 节流窗口内
  report.steps.copy1At = tCopy1;

  // 5. 复制②（节流窗口内连复制）：点第二行 → shift+Home → ctrl+c
  await dragSelectLine(extWid, 70, 25, 400);
  const tCopy2 = Date.now();
  await xdo(['key', '--clearmodifiers', 'ctrl+c']);
  log(`复制②已发出 t=${tCopy2}（与①间隔 ${tCopy2 - tCopy1}ms，应触发节流）`);
  await sleep(3500);
  report.steps.copy2At = tCopy2;

  // 6. 真实划词热键：激活 external → 拖选第一行 → Ctrl+Alt+R
  await xdo(['windowactivate', extWid]);
  await sleep(800);
  await dragSelectLine(extWid, 36, 25, 400);
  await xdo(['windowactivate', extWid]);
  await sleep(500);
  const extWs0 = await connectPage(EXT_CDP, 'data:text/html', 'external-dbg').catch(() => null);
  if (extWs0) {
    const dbg = await cdpEval(extWs0, `JSON.stringify({ focus: document.hasFocus(), sel: window.getSelection().toString().slice(0, 20), active: document.activeElement && document.activeElement.tagName })`, 10000).catch(() => null);
    log('划词前 external 状态:', dbg);
    report.steps.externalBeforeHotkey = dbg;
  }
  const tHot = Date.now();
  await xdo(['key', '--clearmodifiers', 'ctrl+alt+r']);
  log(`划词热键已发出 t=${tHot}`);
  await sleep(6000);
  report.steps.hotkeyAt = tHot;

  // 7. 长度上限：CDP 注入 20001 字 → 点击 → ctrl+a → ctrl+c
  const extWs = await connectPage(EXT_CDP, 'data:text/html', 'external').catch(() => null);
  if (extWs) {
    await cdpEval(extWs, `document.querySelector('#t').textContent = '超长'.repeat(10000) + '尾';`, 30000);
    log('已注入 20001 字段落');
    await xdo(['windowactivate', extWid]);
    await sleep(400);
    await dragSelectLine(extWid, 36, 25, 400);
    await xdo(['key', '--clearmodifiers', 'ctrl+a']);
    await sleep(300);
    const tLong = Date.now();
    await xdo(['key', '--clearmodifiers', 'ctrl+c']);
    log(`超长复制已发出 t=${tLong}`);
    await sleep(5000);
    report.steps.longCopyAt = tLong;
  } else {
    log('external CDP 连接失败，跳过长文本用例');
  }

  // 8. 收尾
  await sleep(1500);
  try { rec.kill('SIGINT'); } catch (e) { /* noop */ }
  await sleep(800);
  try { main.kill(); } catch (e) { /* noop */ }
  try { ext.kill(); } catch (e) { /* noop */ }
  killTracked();

  const mainText = mainLogs.join('');
  const clipLines = mainText.split('\n').filter((l) => l.includes('[clipboard]')).map((l) => l.trim());
  const hotLines = mainText.split('\n').filter((l) => l.includes('[hotkey]')).map((l) => l.trim());
  const extText = extLogs.join('');
  log('--- [clipboard] 日志 ---');
  clipLines.forEach((l) => log(l));
  log('--- [hotkey] 日志 ---');
  hotLines.forEach((l) => log(l));
  log('--- external 复制证据 ---');
  extText.split('\n').filter((l) => l.includes('[external]')).forEach((l) => log(l.trim()));

  // 9. 录音分析
  const rec0 = analyzeRecording(REC, tRec);
  const segAfter = (epoch) => rec0.segs.find((s) => rec0.toEpoch(s.startMs) >= epoch - 50);
  const copy1Seg = segAfter(tCopy1);
  const longSeg = segAfter(report.steps.longCopyAt || Date.now());
  report.steps.recording = {
    segments: rec0.segs.length,
    copy1SoundOnsetMs: copy1Seg ? rec0.toEpoch(copy1Seg.startMs) - tCopy1 : null,
    copy1Peak: copy1Seg ? +copy1Seg.peak.toFixed(4) : null,
    longSoundOnsetMs: longSeg ? rec0.toEpoch(longSeg.startMs) - (report.steps.longCopyAt || 0) : null,
    longPeak: longSeg ? +longSeg.peak.toFixed(4) : null,
  };

  const checks = {
    copy1EmittedAutoRead: clipLines.some((l) => l.includes('autoRead=true') && l.includes('emit=immediate')),
    copy2Throttled: clipLines.some((l) => l.includes('throttled')),
    trailingFlushFired: clipLines.some((l) => l.includes('trailing flush')),
    externalReallyCopied: extText.includes('[external] copied'),
    tooLongSkipped: clipLines.some((l) => l.includes('too long')),
    hotkeyGotSelection: hotLines.some((l) => l.includes('source=selection') && l.includes('code=OK')),
    copy1SoundHeard: copy1Seg != null && copy1Seg.peak > 0.01,
    longAnnounceHeard: longSeg != null && longSeg.peak > 0.01,
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);
  report.logs = { clipLines, hotLines, external: extText.split('\n').filter((l) => l.includes('[external]')).map((l) => l.trim()) };

  fs.writeFileSync(path.join(OUT, 'clip-e2e-report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 复制即读探针报告 =====');
  console.log(JSON.stringify({ ok: report.ok, checks, steps: report.steps }, null, 2));
  process.exit(report.ok ? 0 : 3);
})().catch((e) => {
  console.error('[clip-e2e] 探针自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
