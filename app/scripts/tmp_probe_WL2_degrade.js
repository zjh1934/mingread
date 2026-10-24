// W-L2 降级语义验证（离线运行，不需要网络、不需要 NVSA）：
//   node scripts/tmp_probe_WL2_degrade.js
//
// test-engine-routing.js 已覆盖的降级点（不在本文件重复）：
//   §2 本地合成失败 → Edge，fallbackReason.reason = LOCAL_SYNTH_FAIL
//   §3 本地未注册   → Edge，fallbackReason.reason = VOICE_NOT_REGISTERED
//   §6 通道起不来   → Edge，fallbackReason.reason = HOST_START_FAILED；两边都不通必须抛错
// 本文件补的是 test-engine-routing 未覆盖的三块（本次 W-L2 新增能力）：
//   A. 音色兜底链：云希失败 → 回退晓晓，必须带 degraded + fallbackReason（不得静默换音色）
//   B. 关掉音色兜底：只认所选音色，失败如实抛错，不偷偷换
//   C. 在线保活：失败只记 onlineLastError，不抛、不阻塞、不污染热路径；单飞 + dispose 清定时器
// 做法：用假 EdgeTTS 顶替 node-edge-tts（只改 require 缓存，不动任何文件与依赖）。
'use strict';

const path = require('path');
const os = require('os');
const settingsStore = require('../src/main/settingsStore');
settingsStore._setSettingsPathForTest(path.join(os.tmpdir(), `ldn-wl2-${process.pid}.json`));

let mode = 'ok'; // ok | failAll | failYunxi
let delayMs = 0;
const calls = [];

class FakeEdgeTTS {
  constructor(o) {
    this.o = o || {};
  }
  async *streamAudio(text) {
    calls.push({ voice: this.o.voice, text: String(text), at: Date.now() });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (mode === 'failAll') throw new Error('模拟：429 Too Many Requests');
    if (mode === 'failYunxi' && /Yunxi/.test(this.o.voice)) throw new Error('模拟：该音色合成失败');
    yield Buffer.alloc(1200, 1); // 假 mp3 数据
  }
}

const edgeModPath = require.resolve('node-edge-tts');
require.cache[edgeModPath] = {
  id: edgeModPath,
  filename: edgeModPath,
  loaded: true,
  exports: { EdgeTTS: FakeEdgeTTS },
};

const EdgeTtsBackend = require('../src/main/backends/edgeTtsBackend');
const { TtsBridge } = require('../src/main/ttsBridge');
const voiceCatalog = require('../src/main/backends/voiceCatalog');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

/** 本地不可用的替身（文案与真实 sapiBackend 一致，便于验证「原因可感知」） */
function stubLocalDown() {
  return {
    id: 'sapi',
    kind: 'local',
    label: '本地离线语音（NVSA）',
    warmed: 0,
    lastProbe: () => ({
      available: false,
      reason: 'VOICE_NOT_REGISTERED',
      message: '未检测到本地语音（晓晓/云希），需运行离线语音注册',
    }),
    isAvailable: () => false,
    invalidate() {
      return this;
    },
    warmup() {
      this.warmed += 1;
      return Promise.resolve(null);
    },
    async probe() {
      return this.lastProbe();
    },
    listVoices: () => [],
    async synthesize() {
      throw new Error('本地不可用，不应走到本地合成');
    },
    dispose() {},
  };
}

(async () => {
  console.log('\n=== A. 音色兜底链（云希 → 晓晓）===');
  check(
    '目录声明：云希的兜底是晓晓',
    JSON.stringify(voiceCatalog.fallbackKeysOf('yunxi')) === '["xiaoxiao"]',
    voiceCatalog.fallbackKeysOf('yunxi')
  );
  check('目录声明：晓晓无兜底（单音色已到底）', voiceCatalog.fallbackKeysOf('xiaoxiao').length === 0);
  check(
    '尝试顺序 = [云希, 晓晓]',
    voiceCatalog.voicePlanOf('yunxi').map((s) => s.key).join(',') === 'yunxi,xiaoxiao',
    voiceCatalog.voicePlanOf('yunxi')
  );

  mode = 'failYunxi';
  calls.length = 0;
  {
    const be = new EdgeTtsBackend();
    const r = await be.synthesize('兜底音色测试。', { voiceId: 'edge:yunxi' });
    check('回退成功：实际音色 = 晓晓', r.voiceId === 'edge:xiaoxiao', r.voiceId);
    check('标记 degraded', r.degraded === true);
    check('fallbackReason.reason = VOICE_FALLBACK', r.fallbackReason && r.fallbackReason.reason === 'VOICE_FALLBACK', r.fallbackReason);
    check('fallbackReason 记录了 from/to', !!r.fallbackReason && r.fallbackReason.from === 'edge:yunxi' && r.fallbackReason.to === 'edge:xiaoxiao', r.fallbackReason);
    check(
      '回退原因对人可读（含两个音色名）',
      !!r.fallbackReason && /云希/.test(r.fallbackReason.message) && /晓晓/.test(r.fallbackReason.message),
      r.fallbackReason && r.fallbackReason.message
    );
    check('先试云希、再试晓晓（各一次）', calls.map((c) => c.voice).join(',') === 'zh-CN-YunxiNeural,zh-CN-XiaoxiaoNeural', calls.map((c) => c.voice));
    be.dispose();
  }

  console.log('\n=== B. 关掉音色兜底 → 不偷偷换音色，如实报错 ===');
  calls.length = 0;
  {
    const be = new EdgeTtsBackend();
    let err = null;
    try {
      await be.synthesize('不允许兜底时应当报错。', { voiceId: 'edge:yunxi', voiceFallback: false });
    } catch (e) {
      err = e;
    }
    check('抛错而不是静默换音色', !!err, err && err.message);
    check('只尝试了所选音色一次', calls.length === 1 && /Yunxi/.test(calls[0].voice), calls.map((c) => c.voice));
    check('错误码 = EDGE_NETWORK', !!err && err.code === 'EDGE_NETWORK', err && err.code);
    be.dispose();
  }

  console.log('\n=== C. 没有兜底的音色失败 → 抛错，绝不返回空音频 ===');
  mode = 'failAll';
  calls.length = 0;
  {
    const be = new EdgeTtsBackend();
    let err = null;
    try {
      await be.synthesize('晓晓失败时要报错。', { voiceId: 'edge:xiaoxiao' });
    } catch (e) {
      err = e;
    }
    check('抛错', !!err, err && err.message);
    check('不重复尝试（晓晓无兜底）', calls.length === 1, calls.length);
    check('错误信息含失败原因', !!err && /429/.test(err.message), err && err.message);
    check('onlineLastError 已记录', !!be.onlineLastError && /429/.test(be.onlineLastError.message), be.onlineLastError);
    be.dispose();
  }

  console.log('\n=== D. 保活失败隔离：不抛、不阻塞、状态可见 ===');
  mode = 'failAll';
  calls.length = 0;
  {
    const be = new EdgeTtsBackend();
    let threw = null;
    try {
      await be.warmup();
    } catch (e) {
      threw = e;
    }
    check('warmup() 不抛', threw === null, threw && threw.message);
    check('保活确实发了真实短合成（2 字）', calls.length === 1 && calls[0].text === '就绪', calls.map((c) => c.text));
    const info = be.getInfo();
    check('状态可见：keepAlive.running = true', info.keepAlive.running === true, info.keepAlive);
    check('状态可见：keepAlive.lastOk = false', info.keepAlive.lastOk === false, info.keepAlive);
    check('状态可见：lastError 记录原因', !!info.lastError && /429/.test(info.lastError.message), info.lastError);
    check('失败计数 = 1', info.keepAlive.fails === 1, info.keepAlive.fails);
    check('保活间隔 = 4 分钟', info.keepAlive.intervalMs === 4 * 60 * 1000, info.keepAlive.intervalMs);

    // 恢复后下一次保活成功 → 错误清空、计数归零
    mode = 'ok';
    await be.warmup();
    const info2 = be.getInfo();
    check('恢复后 lastOk = true', info2.keepAlive.lastOk === true, info2.keepAlive);
    check('恢复后 lastError 清空', info2.lastError === null, info2.lastError);
    check('恢复后失败计数归零', info2.keepAlive.fails === 0, info2.keepAlive.fails);

    // 单飞：并发三次 warmup 只发一次合成
    delayMs = 150;
    calls.length = 0;
    await Promise.all([be.warmup(), be.warmup(), be.warmup()]);
    delayMs = 0;
    check('并发 warmup 单飞（只合成 1 次）', calls.length === 1, calls.length);

    be.dispose();
    check('dispose 后定时器已清', be.getInfo().keepAlive.running === false);
    calls.length = 0;
    await be.warmup();
    check('dispose 后 warmup 不再发请求', calls.length === 0, calls.length);
  }

  console.log('\n=== E. bridge 集成：保活归 bridge 管，dispose 清掉 ===');
  mode = 'ok';
  {
    const edge = new EdgeTtsBackend();
    const local = stubLocalDown();
    const b = new TtsBridge({ noWarmup: true, engines: { sapi: local, edge } });
    check('构造后尚无保活定时器（noWarmup）', b._keepAliveTimer === null);
    b._startKeepAlive();
    const t1 = b._keepAliveTimer;
    b._startKeepAlive();
    check('_startKeepAlive 幂等', !!t1 && b._keepAliveTimer === t1);
    b.dispose();
    check('dispose 清掉保活定时器', b._keepAliveTimer === null);
  }

  console.log('\n=== F. 本地不可用 → Edge 兜底，原因可感知（端到端，离线替身）===');
  {
    const edge = new EdgeTtsBackend();
    const b = new TtsBridge({ noWarmup: true, engines: { sapi: stubLocalDown(), edge } });
    const r = await b.synthesize('本地没有语音时应当走在线。', { voiceId: 'edge:xiaoxiao' });
    check('落到在线 edge', r.engine === 'edge', r.engine);
    check('标记 degraded', r.degraded === true);
    check('原因 = VOICE_NOT_REGISTERED', r.fallbackReason && r.fallbackReason.reason === 'VOICE_NOT_REGISTERED', r.fallbackReason);
    check(
      '播报文案可感知（本地原因 + 已切换）',
      !!r.fallbackReason && /未检测到本地语音/.test(r.fallbackReason.message) && /已切换到在线 Edge 语音/.test(r.fallbackReason.message),
      r.fallbackReason && r.fallbackReason.message
    );
    check('getEngineStatus().degraded 可见', b.getEngineStatus().degraded === true);
    b.dispose();
  }

  console.log('\n=== G. 在线彻底不通 → 如实报错，绝不返回空音频假装播放 ===');
  mode = 'failAll';
  {
    const edge = new EdgeTtsBackend();
    const b = new TtsBridge({ noWarmup: true, engines: { sapi: stubLocalDown(), edge } });
    let err = null;
    let res = null;
    try {
      res = await b.synthesize('都不通时必须报错。');
    } catch (e) {
      err = e;
    }
    check('抛错', !!err, err && err.message);
    check('没有返回音频', res === null, res && res.audioData && res.audioData.byteLength);
    check('错误信息含本地原因', !!err && /本地语音不可用/.test(err.message), err && err.message);
    check('错误信息含在线原因', !!err && /429/.test(err.message), err && err.message);
    b.dispose();
  }

  console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
