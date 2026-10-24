// 探针：系统内置 SAPI 语音（Huihui/中文）能否作为「本地兜底引擎」，以及其合成耗时。
//
// 背景：pickSapiVoices 只认晓晓/云希（NVSA 装配的神经语音），系统自带的
// Microsoft Huihui Desktop 因此被挡在门外 → 本地引擎判不可用 → 只能走 Edge（1.4~2.2s）。
// 若 Huihui 走常驻通道合成 <300ms，则它可作为「NVSA 未装/装坏时的本地兜底」，
// 让用户先拿到低延迟，音质等 NVSA 装好再升级。
//
// 用法（PowerShell 工具执行，node 会 spawn 常驻 powershell 通道）：
//   node scripts/tmp_probe_huihui.js
'use strict';

const { SapiHost, b64 } = require('../src/main/backends/sapiHost');

const TEXT = '这是本地语音延迟测试的第一句话。';

(async () => {
  const h = new SapiHost();
  const out = { voices: [], runs: [], warmupMs: null, error: null };
  try {
    await h.start();
    const v = await h.request('voices', {}, 20000);
    const raw = v && v.voices ? v.voices : [];
    const arr = Array.isArray(raw) ? raw : [raw];
    out.voices = arr.map((x) => {
      try {
        return Buffer.from((x && x.name) || '', 'base64').toString('utf8');
      } catch (e) {
        return '';
      }
    });
    console.log('voices=' + out.voices.join(' | '));

    // 选一个中文（Huihui 优先）
    const target =
      out.voices.find((n) => /Huihui/i.test(n)) || out.voices.find((n) => /Chinese|中文/i.test(n)) || out.voices[0];
    out.target = target;
    if (!target) throw new Error('无可用系统语音');

    // 预热一次（首个 synth 有引擎加载开销）
    const tw = Date.now();
    await h.request(
      'synth',
      { textB64: b64('就绪'), voiceB64: b64(target), rate: 0, volume: 100, pitchHz: 0 },
      60000
    );
    out.warmupMs = Date.now() - tw;
    console.log('warmupMs=' + out.warmupMs);

    for (let i = 0; i < 3; i += 1) {
      const t0 = Date.now();
      const r = await h.request(
        'synth',
        { textB64: b64(TEXT), voiceB64: b64(target), rate: 0, volume: 100, pitchHz: 0 },
        60000
      );
      const bytes = Buffer.from((r && r.audioB64) || '', 'base64').length;
      const run = { run: i + 1, synthMs: Date.now() - t0, bytes, sampleRate: r && r.sampleRate };
      out.runs.push(run);
      console.log(`run${run.run} synthMs=${run.synthMs} bytes=${bytes} sr=${run.sampleRate}`);
    }
  } catch (e) {
    out.error = (e && e.message) || String(e);
    console.log('ERROR ' + out.error);
  } finally {
    try {
      h.dispose();
    } catch (e) {
      /* noop */
    }
  }
  console.log('SUMMARY ' + JSON.stringify(out));
})();
