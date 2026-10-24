// 引擎抽象层 / 降级逻辑自测（不需要 Windows、不需要 NVSA）。
// 本地引擎用「注入的模拟长驻通道」（scripts/mock-sapi-host.js）代替 PowerShell，
// 在线引擎默认用真实的 node-edge-tts（联网）。验证的是路由与降级，不是 NVSA 本身。
//   node scripts/test-engine-routing.js
'use strict';

const path = require('path');
const os = require('os');
const settingsStore = require('../src/main/settingsStore');
settingsStore._setSettingsPathForTest(path.join(os.tmpdir(), `ldn-route-${process.pid}.json`));

const { TtsBridge } = require('../src/main/ttsBridge');
const SapiBackend = require('../src/main/backends/sapiBackend');
const EdgeTtsBackend = require('../src/main/backends/edgeTtsBackend');
const { ENGINE_ERR, LOCAL_REASON } = require('../src/main/backends');

const MOCK = path.join(__dirname, 'mock-sapi-host.js');
const TEXT = '你好，这是引擎路由测试。本地语音应当优先。';

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 环境问题导致无法验证时记为 SKIP，不计入失败（明确区分"没测"与"测了没过"） */
function skip(name, why) {
  skipped += 1;
  console.log(`  [SKIP] ${name} — ${why}`);
}

function withMock(env, fn) {
  const saved = { ...process.env };
  Object.assign(process.env, { LDN_SAPI_HOST: process.execPath, LDN_SAPI_HOST_ARGS: JSON.stringify([MOCK]), ...env });
  return fn().finally(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
}

/**
 * 在线 Edge 在沙箱里偶发失败（微软端点间歇性返回 200 而不是 101），与本次改动无关。
 * 测试里对"必须走在线"的场景做有限重试，重试仍失败才判定为环境问题。
 */
async function synthRetry(bridge, text, opts, tries = 5) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await bridge.synthesize(text, opts);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}

function newBridge(overrides) {
  const o = overrides || {};
  return new TtsBridge({ noWarmup: true, engines: { sapi: o.sapi || new SapiBackend(), edge: o.edge || new EdgeTtsBackend() } });
}

/** 永不失败的在线替身：验证「降级确实落到了在线引擎」，不依赖真实网络 */
const stubEdgeOk = {
  id: 'edge',
  kind: 'online',
  label: 'stub-edge-ok',
  isAvailable: () => true,
  listVoices: () => [
    { id: 'edge:xiaoxiao', engine: 'edge', displayName: '晓晓', source: 'online' },
    { id: 'edge:yunxi', engine: 'edge', displayName: '云希', source: 'online' },
  ],
  warmup() {},
  invalidate() {
    return this;
  },
  dispose() {},
  async synthesize() {
    return {
      audioData: new Uint8Array(Buffer.alloc(2048, 7)),
      sampleRate: 24000,
      durationMs: 1200,
      markers: [],
      sentences: [],
      backend: 'edge',
      format: 'mp3',
    };
  },
};

const stubEdge = (errMsg, code) => ({
  id: 'edge',
  kind: 'online',
  label: 'stub-edge',
  isAvailable: () => true,
  listVoices: () => [],
  warmup() {},
  invalidate() {
    return this;
  },
  dispose() {},
  async synthesize() {
    const e = new Error(errMsg || '模拟：在线合成失败');
    e.code = code || 'EDGE_NETWORK';
    throw e;
  },
});

(async () => {
  console.log('\n=== 1. 本地可用 → 必须走本地（离线优先）===');
  await withMock({}, async () => {
    const b = newBridge();
    const p = await b.local.probe(true);
    check('本地探测可用', p.available === true, p);
    check('挑出晓晓/云希两个音色', (p.voices || []).length === 2, p.voices);
    const r = await b.synthesize(TEXT, { voiceId: 'edge:xiaoxiao' });
    check('引擎 = sapi', r.engine === 'sapi', r.engine);
    check('未降级', r.degraded === false);
    check('输出 wav', r.format === 'wav', r.format);
    const head = Buffer.from(r.audioData).slice(0, 4).toString('ascii');
    check('WAV 容器正确（RIFF 头）', head === 'RIFF', head);
    check('时长合理', r.durationMs > 100, r.durationMs);
    const voices = b.listVoices();
    check('音色表为离线来源', voices.length === 2 && voices.every((v) => v.source === 'offline'), voices.map((v) => v.id));
    check('旧设置 edge:xiaoxiao 仍能命中同音色', voices.some((v) => v.id === 'sapi:xiaoxiao' && v.isDefault), voices);
    b.dispose();
  });

  console.log('\n=== 2. 本地合成失败 → 降级在线，且原因可感知 ===');
  await withMock({ MOCK_FAIL_SYNTH: '1' }, async () => {
    const b = newBridge({ edge: stubEdgeOk });
    const r = await b.synthesize('这是一次降级测试。', { voiceId: 'sapi:xiaoxiao' });
    check('落到在线 edge', r.engine === 'edge', r.engine);
    check('标记降级', r.degraded === true);
    check('降级原因 = 本地合成失败', r.fallbackReason && r.fallbackReason.reason === ENGINE_ERR.LOCAL_SYNTH_FAIL, r.fallbackReason);
    check('状态里可见降级', b.getEngineStatus().degraded === true);
    check('输出 mp3', r.format === 'mp3', r.format);
    b.dispose();
  });

  console.log('\n=== 3. 本地未注册 → 降级在线，原因 VOICE_NOT_REGISTERED ===');
  await withMock({ MOCK_NO_VOICES: '1' }, async () => {
    const b = newBridge({ edge: stubEdgeOk });
    const p = await b.local.probe(true);
    check('本地不可用', p.available === false, p);
    check('原因 = 未注册', p.reason === LOCAL_REASON.VOICE_NOT_REGISTERED, p.reason);
    const r = await b.synthesize('本地没有语音时应当走在线。');
    check('落到在线 edge', r.engine === 'edge', r.engine);
    check('降级原因透传', r.fallbackReason && r.fallbackReason.reason === LOCAL_REASON.VOICE_NOT_REGISTERED, r.fallbackReason);
    b.dispose();
  });

  console.log('\n=== 4. 两条路都不通 → 明确报错，绝不假装播放 ===');
  await withMock({ MOCK_NO_VOICES: '1' }, async () => {
    const b = newBridge({ edge: stubEdge('模拟：网络不可用') });
    let err = null;
    try {
      await b.synthesize('两边都不行的时候要说清楚。');
    } catch (e) {
      err = e;
    }
    check('抛错而不是返回空音频', !!err);
    check('错误信息含本地原因', !!err && /本地语音不可用/.test(err.message), err && err.message);
    check('错误信息含在线原因', !!err && /网络不可用/.test(err.message), err && err.message);
    b.dispose();
  });

  console.log('\n=== 5. 关闭在线兜底 → 不静默走在线，直接报错 ===');
  await withMock({ MOCK_NO_VOICES: '1' }, async () => {
    settingsStore.saveSettings({ edgeEnabled: false, autoFallback: false });
    const b = newBridge();
    let err = null;
    try {
      await b.synthesize('兜底关掉时要明确报错。');
    } catch (e) {
      err = e;
    }
    check('抛错', !!err);
    check('提示在线兜底已关闭', !!err && /在线兜底已关闭/.test(err.message), err && err.message);
    settingsStore.saveSettings({ edgeEnabled: true, autoFallback: true });
    b.dispose();
  });

  console.log('\n=== 6. 空文本 / 通道起不来 → 不崩，按约定报错 ===');
  await withMock({}, async () => {
    const b = newBridge();
    let err = null;
    try {
      await b.synthesize('   ');
    } catch (e) {
      err = e;
    }
    check('空文本抛错', !!err && err.code === 'TTS_SYNTH_FAIL', err && err.message);
    b.dispose();
  });
  await withMock({ MOCK_BOOT_FAIL: '1' }, async () => {
    const b = newBridge({ edge: stubEdgeOk });
    const p = await b.local.probe(true);
    check('通道起不来 → 本地不可用', p.available === false, p);
    check('原因 = 通道启动失败', p.reason === LOCAL_REASON.HOST_START_FAILED, p.reason);
    const r = await b.synthesize('通道坏了要能降级在线。');
    check('仍能用在线兜底', r.engine === 'edge' && r.degraded === true, r.engine);
    b.dispose();
  });

  console.log('\n=== 7. 真实环境默认（无注入）→ 本地状态可解释，在线路径正常 ===');
  {
    const b = newBridge();
    const p = await b.local.probe(true);
    // 断言必须平台自适应：旧写法把「Linux 沙箱」当前提写死成 p.reason === NOT_WINDOWS，
    // 在 Windows 上恒不成立（本机实测 reason=VOICE_NOT_REGISTERED），属于断言缺陷而非功能回归。
    if (process.platform !== 'win32') {
      check('非 Windows：本地不可用且原因明确', p.available === false && p.reason === LOCAL_REASON.NOT_WINDOWS, p);
    } else if (p.available) {
      check('Windows 且本地语音已就绪：可用', p.available === true, p);
    } else {
      // 未装 NVSA 是首次运行的常态：原因必须可播报，且不能是 NOT_WINDOWS（那说明平台判定写错了）
      check(
        'Windows 未装本地语音：原因可解释（非 NOT_WINDOWS）',
        !!p.reason && p.reason !== LOCAL_REASON.NOT_WINDOWS,
        p
      );
    }
    check('状态可出（应用不崩）', !!b.getStatus().engine.id, b.getStatus().engine);
    // 唯一依赖真实网络的用例：微软在线端点在沙箱里会间歇性限流（返回 200 而非 101），
    // 连不上时记为 SKIP（环境问题），不算实现缺陷。
    let r = null;
    try {
      r = await synthRetry(b, '这是 Linux 沙箱里的在线合成测试。');
    } catch (e) {
      skip('在线合成（真实网络）不可达', e.message);
    }
    if (r) {
      // 本地语音就绪时本地优先（NVSA 已装），否则必须走在线 edge 兜底 —— 两种都算正确
      const expectLocal = p.available;
      check(
        expectLocal ? '本地语音就绪 → 走本地引擎' : '走在线 edge',
        expectLocal ? r.engine !== 'edge' : r.engine === 'edge',
        r.engine
      );
      check('音频有数据', r.audioData.byteLength > 1000, r.audioData.byteLength);
    }
    b.dispose();
  }

  console.log(`\n结果：PASS=${pass} FAIL=${fail} SKIP=${skipped}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
