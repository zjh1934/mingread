// 语音链路探针（沙箱/CI 用，不依赖 Electron）：
//   node scripts/probe-voice-chain.js
//
// 验证内容：
//   1. 引擎链与各引擎探测结果（SAPI → espeak → Edge，及每个"为什么没走它"）
//   2. 直连 espeak backend 合成 → 落盘 WAV，报告字节/时长/采样率/RIFF 校验/耗时
//   3. 经 ttsBridge 全链合成 → 落盘 WAV，报告实际引擎/降级原因/耗时
//   4. 热路径延迟（预热后连续合成 3 次）
//   5. 关闭沙箱引擎（注入 espeak:null）→ 必须明确报错而不是假装播放
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

require('../src/main/settingsStore')._setSettingsPathForTest(path.join(os.tmpdir(), `ldn-vchain-${process.pid}.json`));

const { getBridge } = require('../src/main/ttsBridge');
const EspeakBackend = require('../src/main/backends/espeakBackend');

const OUT = path.join(__dirname, '..', 'dist', 'probe');

function wavInfo(buf) {
  const b = Buffer.from(buf);
  const riff = b.slice(0, 4).toString('ascii');
  const wave = b.slice(8, 12).toString('ascii');
  const sampleRate = b.readUInt32LE(24);
  const channels = b.readUInt16LE(22);
  const bits = b.readUInt16LE(34);
  const byteRate = sampleRate * channels * Math.max(1, Math.floor(bits / 8));
  const pcmBytes = Math.max(0, b.length - 44);
  return {
    riffOk: riff === 'RIFF' && wave === 'WAVE',
    bytes: b.length,
    sampleRate,
    channels,
    bits,
    durationByBytesMs: Math.round((pcmBytes / byteRate) * 1000),
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { steps: [] };
  const log = (name, obj) => {
    report.steps.push({ name, ...obj });
    console.log(`\n== ${name} ==\n${JSON.stringify(obj, null, 2)}`);
  };

  // ---- 1. 链路与探测 ----
  const bridge = getBridge();
  await bridge.warmup();
  const es = bridge.getEngineStatus();
  log('engine-chain', {
    chain: es.chain,
    active: es.active,
    activeLabel: es.activeLabel,
    engines: es.engines.map((s) => ({ id: s.id, kind: s.kind, available: s.available, reason: s.reason, message: s.message })),
    autoFallback: es.autoFallback,
  });

  // ---- 2. 直连 espeak backend ----
  {
    const be = new EspeakBackend();
    const text = '你好，这是直连 espeak 后端的合成测试。';
    const t0 = Date.now();
    const r = await be.synthesize(text, { voiceId: 'espeak:xiaoxiao' });
    const elapsedMs = Date.now() - t0;
    const file = path.join(OUT, `espeak-direct-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(r.audioData));
    const info = wavInfo(r.audioData);
    log('espeak-direct', {
      ok: true,
      file,
      bytes: info.bytes,
      durationMs: r.durationMs,
      durationByBytesMs: info.durationByBytesMs,
      durationMatch: Math.abs(info.durationByBytesMs - r.durationMs) <= 2,
      sampleRate: info.sampleRate,
      channels: info.channels,
      bits: info.bits,
      riffOk: info.riffOk,
      format: r.format,
      voiceId: r.voiceId,
      elapsedMs,
    });
    if (!info.riffOk || info.bytes < 1000) {
      console.error('直连 espeak 产出异常');
      process.exit(2);
    }
  }

  // ---- 3. 经 ttsBridge 全链（沙箱真实路径：SAPI 不可用 → espeak）----
  {
    const text = '这是经过完整引擎链的合成测试，本地不可用时降级原因必须可感知。';
    const t0 = Date.now();
    const r = await bridge.synthesize(text, { voiceId: 'edge:xiaoxiao' });
    const elapsedMs = Date.now() - t0;
    const file = path.join(OUT, `chain-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(r.audioData));
    const info = wavInfo(r.audioData);
    log('bridge-chain', {
      ok: true,
      file,
      engine: r.engine,
      local: r.local,
      degraded: r.degraded,
      fallback: r.fallbackReason
        ? { from: r.fallbackReason.from, to: r.fallbackReason.to, reason: r.fallbackReason.reason, message: r.fallbackReason.message }
        : null,
      bytes: info.bytes,
      durationMs: r.durationMs,
      durationByBytesMs: info.durationByBytesMs,
      sampleRate: info.sampleRate,
      riffOk: info.riffOk,
      format: r.format,
      elapsedMs,
    });
    if (r.engine !== 'espeak' || !info.riffOk || info.bytes < 1000) {
      console.error('全链合成未按预期落到 espeak 或产出异常');
      process.exit(2);
    }
  }

  // ---- 4. 热路径延迟（预热后）----
  {
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const r = await bridge.synthesize(`第${i + 1}次热路径延迟测量。`, { voiceId: 'edge:xiaoxiao' });
      runs.push({ i, elapsedMs: Date.now() - t0, bytes: r.audioData.byteLength, durationMs: r.durationMs });
    }
    const avg = Math.round(runs.reduce((s, x) => s + x.elapsedMs, 0) / runs.length);
    log('hot-path-latency', { runs, avgElapsedMs: avg });
  }

  // ---- 5. 沙箱引擎被禁用 + 在线不可达 → 必须明确报错 ----
  {
    const { TtsBridge } = require('../src/main/ttsBridge');
    const b = new TtsBridge({ noWarmup: true, engines: { sapi: undefined, espeak: null, edge: undefined } });
    let err = null;
    try {
      await b.synthesize('这条路径必须明确失败。', {});
    } catch (e) {
      err = e;
    }
    log('explicit-failure', {
      threw: !!err,
      code: err ? err.code : null,
      message: err ? err.message : null,
      note: '注入 espeak:null 模拟"沙箱引擎也没装"：不得返回空音频假装播放',
    });
    if (!err) {
      console.error('失败路径没有抛错，违反"不假装播放"原则');
      process.exit(2);
    }
  }

  console.log('\n探针完成：链路各环节均有真实音频产出。');
  process.exit(0);
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2));
  process.exit(2);
});
