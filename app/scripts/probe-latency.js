// 端到端延迟度量探针（v2.4.0 延迟攻坚的验收依据）。
//
// 度量的链路与真实使用一致，只把「人按键」换成探针触发：
//   触发 → 反馈音(cue) → [抓选区] → 首句合成(synthesize) → 首声(__playSpeechTimed)
// 抓选区需要真实前台选区，探针里无法稳定复现，故用 --capture 传入实测值
// （scripts/tmp_probe_WL1_capture.js 的宿主 P95 实测 62ms；本机慢网下一次性兜底约 750ms）。
//
// 达标线（用户 2026-10-24 口径）：
//   · 触发 → 反馈音 ≤200ms
//   · 本地引擎（NVSA）触发 → 人声 ≤300ms
//   · 在线兜底（Edge）触发 → 人声 ≤1000ms
//
// 用法（PowerShell 工具，先清 ELECTRON_RUN_AS_NODE）：
//   node node_modules/electron/cli.js scripts/probe-latency.js --runs=3 --capture=62
// 结果写 dist/probe/latency.json，同时打印摘要表。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getBridge } = require('../src/main/ttsBridge');
const a11y = require('../src/main/a11yFeedback');

function argNum(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = Number(hit.split('=')[1]);
  return Number.isFinite(v) ? v : def;
}

const RUNS = Math.max(1, Math.min(20, argNum('runs', 3)));
const CAPTURE_MS = argNum('capture', 62); // 抓选区耗时（来自 WL1 实测）
const SENTENCE = '这是延迟测试的第一句话。';
const OUT = path.join(__dirname, '..', 'dist', 'probe', 'latency.json');

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

app.whenReady().then(async () => {
  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    runs: RUNS,
    captureMsAssumed: CAPTURE_MS,
    rows: [],
    summary: {},
    verdict: null,
  };

  let bridge = null;
  let audioWin = null;
  try {
    bridge = getBridge();
    if (typeof bridge.warmup === 'function') await bridge.warmup();
  } catch (e) {
    result.bridgeError = (e && e.message) || String(e);
  }
  try {
    audioWin = await a11y.ensureAudioWindow();
  } catch (e) {
    result.audioError = (e && e.message) || String(e);
  }

  // ---- 预热（不计入统计）----
  // NVSA 神经语音首次合成要加载模型（本机实测 ~590ms）。真实使用时这段由 index.js
  // 启动期的 bridge.warmup() 承担，不是「按 F1 到出声」的体感延迟，故单独记 coldStartMs。
  let coldStartMs = null;
  if (bridge) {
    try {
      const tc = Date.now();
      await bridge.synthesize(SENTENCE);
      coldStartMs = Date.now() - tc;
      result.coldStartMs = coldStartMs;
      result.coldStartEngine = (bridge.getEngineStatus && bridge.getEngineStatus().active) || null;
    } catch (e) {
      result.coldStartMs = null;
      result.coldStartError = (e && e.message) || String(e);
    }
  }

  for (let i = 0; i < RUNS; i += 1) {
    const row = { run: i + 1 };

    // ---- ① 反馈音（与热键回调同一入口；必须先测完再合成）----
    // 真实链路顺序是「按 F1 → 立刻播提示音 → 再抓选区/合成」，两者不并发。
    // 早前版本为了省时间把 cue 与 synthesize 并发，实测 cue 被合成抢占到 737ms，
    // 属于度量失真（不是产品缺陷），故改回串行。
    const t0 = Date.now();
    try {
      await a11y.cue('press');
      row.tCueMs = Date.now() - t0;
    } catch (e) {
      row.tCueMs = null;
    }

    // ---- ② 首句合成 ----
    const tSynth = Date.now();
    let syn = null;
    try {
      syn = await bridge.synthesize(SENTENCE);
      row.tSynthMs = Date.now() - tSynth;
      row.engine = syn && syn.engine;
      row.audioBytes = syn && syn.audioData ? Buffer.from(syn.audioData).length : 0;
      row.mime = (syn && syn.mime) || 'audio/mpeg';
      row.degraded = !!(syn && syn.degraded);
      row.fallbackReason = syn && syn.fallbackReason ? syn.fallbackReason.reason : null;
      row.voiceFallback = syn && syn.voiceFallback ? syn.voiceFallback : null;
    } catch (e) {
      row.tSynthMs = Date.now() - tSynth;
      row.synthError = (e && e.message) || String(e);
    }

    // ---- ③ 首声（真实解码 + 排音，不等播完）----
    if (syn && syn.audioData && audioWin && !audioWin.isDestroyed()) {
      try {
        const b64 = Buffer.from(syn.audioData).toString('base64');
        const tDispatch = Date.now();
        const pr = await audioWin.webContents.executeJavaScript(
          `window.__playSpeechTimed(${JSON.stringify(b64)}, ${JSON.stringify(row.mime)})`
        );
        row.tPlayDispatchMs = Date.now() - tDispatch; // IPC + 页面执行开销
        row.tPlayStartMs = pr && pr.startDelayMs; // 页面内：解码 + 排音
        row.playDurationMs = pr && pr.durationMs;
        if (Number.isFinite(row.tSynthMs) && Number.isFinite(row.tPlayStartMs)) {
          row.tVoiceMs = row.tSynthMs + row.tPlayDispatchMs + row.tPlayStartMs;
          row.tEndToEndMs = row.tVoiceMs + CAPTURE_MS;
        }
      } catch (e) {
        row.playError = (e && e.message) || String(e);
      }
    }

    result.rows.push(row);
    if (i < RUNS - 1) await new Promise((r) => setTimeout(r, 700)); // 留间隔，避开 429/竞态
  }

  // ---- 汇总 ----
  const ok = result.rows.filter((r) => Number.isFinite(r.tEndToEndMs));
  const synth = ok.map((r) => r.tSynthMs);
  const e2e = ok.map((r) => r.tEndToEndMs);
  const cue = result.rows.map((r) => r.tCueMs).filter((v) => Number.isFinite(v));
  const engines = [...new Set(ok.map((r) => r.engine).filter(Boolean))];

  result.summary = {
    engine: engines.join('+') || null,
    coldStartMs,
    cueP95Ms: pct(cue, 95),
    synthP50Ms: pct(synth, 50),
    synthP95Ms: pct(synth, 95),
    endToEndP50Ms: pct(e2e, 50),
    endToEndP95Ms: pct(e2e, 95),
    playStartP95Ms: pct(
      ok.map((r) => r.tPlayStartMs).filter((v) => Number.isFinite(v)),
      95
    ),
    degradedCount: result.rows.filter((r) => r.degraded).length,
    errors: result.rows.filter((r) => r.synthError || r.playError).length,
  };

  // ---- 判定（本地 vs 在线用不同达标线）----
  const isLocal = engines.some((e) => e && e !== 'edge');
  const e2eTarget = isLocal ? 300 : 1000;
  const cueTarget = 200;
  const e2eOk = result.summary.endToEndP95Ms != null && result.summary.endToEndP95Ms <= e2eTarget;
  const cueOk = result.summary.cueP95Ms != null && result.summary.cueP95Ms <= cueTarget;
  result.verdict = {
    engineKind: isLocal ? 'local' : 'online',
    cueTargetMs: cueTarget,
    endToEndTargetMs: e2eTarget,
    cuePass: cueOk,
    endToEndPass: e2eOk,
    pass: cueOk && e2eOk,
  };

  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  } catch (e) {
    /* noop */
  }

  // 控制台摘要（便于 PowerShell 工具直接读）
  console.log('=== latency summary ===');
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('=== verdict ===');
  console.log(JSON.stringify(result.verdict, null, 2));

  try {
    a11y.disposeAudioWindow && a11y.disposeAudioWindow();
  } catch (e) {
    /* noop */
  }
  app.exit(result.verdict.pass ? 0 : 1);
});
