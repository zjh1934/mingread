// 引擎探针（不依赖 Electron）：
//   node scripts/probe-engine.js status              打印引擎状态（本地 / 在线 / 降级原因）
//   node scripts/probe-engine.js voices              打印音色列表
//   node scripts/probe-engine.js synth [voiceId] [text]  合成一段并落盘
//   node scripts/probe-engine.js refresh             重新探测本地引擎（NVSA 注册后调用）
//
// Windows 上可注入模拟通道验证抽象层（无需 NVSA）：
//   LDN_SAPI_HOST=node LDN_SAPI_HOST_ARGS='["scripts/mock-sapi-host.js"]' node scripts/probe-engine.js status
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

require('../src/main/settingsStore')._setSettingsPathForTest(path.join(os.tmpdir(), `ldn-probe-${process.pid}.json`));

const { getBridge } = require('../src/main/ttsBridge');
const OUT = path.join(__dirname, '..', 'dist', 'probe');

(async () => {
  const cmd = process.argv[2] || 'status';
  const bridge = getBridge();
  await bridge.warmup();
  // 长驻通道会占住事件循环，打印完即释放（Electron 常驻场景不需要）
  const done = (payload) => {
    console.log(payload);
    bridge.dispose();
  };

  if (cmd === 'status') {
    done(JSON.stringify({ engine: bridge.getEngineStatus(), status: bridge.getStatus() }, null, 2));
    return;
  }
  if (cmd === 'voices') {
    done(JSON.stringify(bridge.listVoices(), null, 2));
    return;
  }
  if (cmd === 'refresh') {
    done(JSON.stringify(await bridge.refreshEngines(), null, 2));
    return;
  }
  if (cmd === 'synth') {
    const voiceId = process.argv[3];
    const text = process.argv[4] || '你好，这是朗读女 Neo 的语音引擎测试。';
    const t0 = Date.now();
    const r = await bridge.synthesize(text, { voiceId });
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `synth-${Date.now()}.${r.format === 'wav' ? 'wav' : 'mp3'}`);
    fs.writeFileSync(file, Buffer.from(r.audioData));
    done(
      JSON.stringify(
        {
          ok: true,
          engine: r.engine,
          local: !!r.local,
          degraded: !!r.degraded,
          fallbackReason: r.fallbackReason || null,
          voiceId: r.voiceId,
          format: r.format,
          sampleRate: r.sampleRate,
          bytes: r.audioData.byteLength,
          durationMs: r.durationMs,
          elapsedMs: Date.now() - t0,
          file,
        },
        null,
        2
      )
    );
    return;
  }
  console.error('用法: node scripts/probe-engine.js <status|voices|synth|refresh> [voiceId] [text]');
  process.exit(1);
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2));
  process.exit(2);
});
