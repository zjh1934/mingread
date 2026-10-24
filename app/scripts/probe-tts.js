// 主进程 TTS 探针（不依赖 Electron）：
//   node scripts/probe-tts.js list          列出音色
//   node scripts/probe-tts.js synth [voiceId] [text]  合成一段（需要网络）
//   node scripts/probe-tts.js status        状态
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

require('../src/main/settingsStore')._setSettingsPathForTest(path.join(os.tmpdir(), `ldn-${process.pid}.json`));

const { getBridge } = require('../src/main/ttsBridge');

const OUT = path.join(__dirname, '..', 'dist', 'probe');

(async () => {
  const cmd = process.argv[2] || 'list';
  const bridge = getBridge();

  if (cmd === 'list') {
    console.log(JSON.stringify({ count: bridge.listVoices().length, voices: bridge.listVoices() }, null, 2));
    return;
  }

  if (cmd === 'status') {
    await bridge.warmup(); // 等后台探测完成，避免读到"尚未探测"的中间态
    console.log(JSON.stringify(bridge.getStatus(), null, 2));
    return;
  }

  if (cmd === 'synth') {
    const voiceId = process.argv[3] || 'edge:xiaoxiao';
    const text = process.argv[4] || '你好，这是朗读女 Neo 的语音测试。';
    const t0 = Date.now();
    const r = await bridge.synthesize(text, { voiceId });
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `synth-${Date.now()}.${r.format === 'wav' ? 'wav' : 'mp3'}`);
    fs.writeFileSync(file, Buffer.from(r.audioData));
    console.log(
      JSON.stringify(
        {
          ok: true,
          engine: r.engine,
          local: !!r.local,
          degraded: !!r.degraded,
          fallbackReason: r.fallbackReason || null,
          voiceId: r.voiceId,
          bytes: r.audioData.byteLength,
          durationMs: r.durationMs,
          format: r.format,
          elapsedMs: Date.now() - t0,
          file,
        },
        null,
        2
      )
    );
    return;
  }

  console.error('用法: node scripts/probe-tts.js <list|status|synth> [voiceId] [text]');
  process.exit(1);
})().catch((e) => {
  console.error(JSON.stringify({ ok: false, code: e.code, message: e.message }, null, 2));
  process.exit(2);
});
