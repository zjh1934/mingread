// Edge 在线语音后端（唯一合成方案）：微软 Edge 语音接口，输出 mp3。
// 依赖 node-edge-tts（MIT）；音色固定为晓晓 / 云希。
//
// 关于「保活」：node-edge-tts 每次 streamAudio 都新建 WebSocket 并在 turn.end 后
// 关闭，连接无法复用；而 URL 上的 Sec-MS-GEC 令牌是按 5 分钟窗口现算的，
// 裸预连接（只连不发）既不能交接给库、也过不了令牌校验。所以保活只能是
// 「真实短合成」：每 _KEEPALIVE_INTERVAL_MS 合成一次 2 字文本（「就绪」）并丢弃音频，
// 把模块加载 / DNS 解析 / 服务端会话选择这些一次性成本留在空闲时段，
// 同时把失败原因写进 onlineLastError 供状态展示 —— 预热失败绝不穿透到热键路径。
'use strict';

const C = require('../../shared/constants');
const { splitSentences, proportionalSentenceMarks } = require('../util');
const { voicePlanOf } = require('./voiceCatalog');

const LOCALE = 'zh-CN';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const MP3_BYTES_PER_SEC = 48000 / 8; // 48kbps CBR ≈ 6000 B/s
const SAMPLE_RATE = 24000;

const KEEPALIVE_TEXT = '就绪'; // 2 字：够短（合成快）又够长（服务端会真的出声）
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 分钟（令牌窗口 5 分钟，留 1 分钟余量）
const KEEPALIVE_MAX_FAILS = 2; // 连续失败到这个次数后隔一轮再试（防网络抖动时刷请求被限流）

let mod = null;
let loaded = false;
let loadErr = null;

// 唤醒补位：锁屏回来时连接/会话大概率已失效，补做一次保活。
// 纯 node 环境（探针/测试）没有 electron，取不到就跳过，不影响合成。
let powerMonitor = null;
try {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  if (electron && typeof electron === 'object' && electron.powerMonitor) powerMonitor = electron.powerMonitor;
} catch (e) {
  powerMonitor = null;
}

function load() {
  if (loaded) return mod;
  loaded = true;
  try {
    // eslint-disable-next-line global-require
    const m = require('node-edge-tts');
    if (m && typeof m.EdgeTTS === 'function') mod = m;
  } catch (e) {
    loadErr = e;
    mod = null;
  }
  return mod;
}

function voiceDef(voiceId) {
  const key = String(voiceId || '').replace(/^edge:/, '');
  return C.EDGE_VOICES.find((v) => v.key === key) || C.EDGE_VOICES[0];
}

/** pitch(-50~+50，与旧版一致按音分处理) → Edge 百分比 */
function pitchToPercent(pitch) {
  const factor = Math.pow(2, (Number(pitch) || 0) / 1200);
  return Math.round((factor - 1) * 100);
}

const signed = (v) => `${v >= 0 ? '+' : ''}${v}%`;

class EdgeTtsBackend {
  constructor() {
    this._keepAlive = null; // 私有保活定时器
    this._keepAlivePromise = null; // 单飞：同一时刻只允许一次保活合成
    this._keepAliveFails = 0;
    this._activeSynth = 0; // 热路径合成计数（保活礼让：有真实合成时不抢占连接）
    this._disposed = false;
    this._onUnlock = null;
    this.onlineLastError = null; // 最近一次在线失败（保活/合成），供状态展示
    this._keepAliveStat = { at: null, ms: 0, ok: null, trigger: null, count: 0 };
  }

  get id() {
    return 'edge';
  }

  /** 引擎种类：本地离线 / 在线（引擎抽象层契约字段） */
  get kind() {
    return 'online';
  }

  get label() {
    return '微软 Edge 在线语音';
  }

  isAvailable() {
    return !!load();
  }

  /** 在线引擎无缓存，空实现以满足契约 */
  invalidate() {
    return this;
  }

  /**
   * 后台预热（契约允许返回 Promise，调用方可 await 也可忽略）：
   *   1. 加载依赖（require node-edge-tts / ws）
   *   2. 立即做一次真实短合成（丢弃音频）—— 把冷启动挪出热键路径
   *   3. 装 4 分钟保活定时器 + 锁屏解锁补位
   * 全部 try/catch：预热失败只记 onlineLastError，绝不抛给调用方。
   */
  warmup() {
    if (this._disposed) return Promise.resolve(null);
    load();
    this._armKeepAlive();
    return this._keepAliveNow('warmup');
  }

  dispose() {
    this._disposed = true;
    if (this._keepAlive) {
      clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
    if (this._onUnlock && powerMonitor) {
      try {
        powerMonitor.removeListener('unlock', this._onUnlock);
      } catch (e) {
        /* 解绑失败不影响退出 */
      }
    }
    this._onUnlock = null;
  }

  listVoices() {
    return C.EDGE_VOICES.map((v) => ({
      id: v.id,
      engine: 'edge',
      displayName: v.name,
      locale: LOCALE,
      gender: v.gender,
      desc: v.desc,
      source: 'online',
      nativeId: `${LOCALE}-${v.shortName}`,
      available: this.isAvailable(),
    }));
  }

  /**
   * 合成。所选音色失败且配置了兜底时，回退到兜底链里的下一个音色重试一次；
   * 回退成功的结果带 degraded + fallbackReason（绝不静默换音色）。
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number,
   *          voiceFallback?:boolean}} opts
   */
  async synthesize(text, opts) {
    const m = load();
    if (!m) {
      const err = new Error('在线语音组件不可用（缺少 node-edge-tts 依赖）');
      err.code = C.ERR.EDGE_NETWORK;
      throw err;
    }
    const o = opts || {};
    const def = voiceDef(o.voiceId);
    // voiceFallback === false 时只用所选音色（设置里可关；缺省开启）
    const plan = o.voiceFallback === false ? [{ key: def.key, isFallback: false }] : voicePlanOf(def.key);

    let firstErr = null;
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i];
      const stepDef = i === 0 ? def : voiceDef(step.key);
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await this._synthOnce(text, stepDef, o);
        this.onlineLastError = null;
        if (i === 0) return res;
        return {
          ...res,
          degraded: true,
          fallbackReason: {
            from: `${def.id}`,
            to: `${stepDef.id}`,
            reason: 'VOICE_FALLBACK',
            message: `音色「${def.name}」合成失败（${firstErr && firstErr.message ? firstErr.message : '原因未知'}）；已回退到「${stepDef.name}」继续朗读`,
            at: Date.now(),
          },
        };
      } catch (e) {
        if (!firstErr) firstErr = e;
        this.onlineLastError = {
          at: Date.now(),
          code: e.code || C.ERR.EDGE_NETWORK,
          message: e.message || String(e),
          voiceId: stepDef.id,
        };
      }
    }
    throw firstErr;
  }

  /** 状态展示用（ttsBridge.getEngineStatus 的 info 字段） */
  getInfo() {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      loaded: !!mod,
      loadError: loadErr ? String(loadErr.message || loadErr) : null,
      keepAlive: {
        intervalMs: KEEPALIVE_INTERVAL_MS,
        running: !!this._keepAlive,
        lastAt: this._keepAliveStat.at,
        lastMs: this._keepAliveStat.ms,
        lastOk: this._keepAliveStat.ok,
        lastTrigger: this._keepAliveStat.trigger,
        count: this._keepAliveStat.count,
        fails: this._keepAliveFails,
      },
      lastError: this.onlineLastError,
    };
  }

  // ---- 内部 ----

  /**
   * 一次真实合成（成败都只走 throw/return，不吞错）。
   * @returns {Promise<object>} 与 synthesize 相同的 TtsResult
   */
  async _synthOnce(text, def, opts) {
    const m = load();
    if (!m) {
      const err = new Error('在线语音组件不可用（缺少 node-edge-tts 依赖）');
      err.code = C.ERR.EDGE_NETWORK;
      throw err;
    }
    const o = opts || {};
    const tts = new m.EdgeTTS({
      voice: `${LOCALE}-${def.shortName}`,
      lang: LOCALE,
      outputFormat: OUTPUT_FORMAT,
      saveSubtitles: true,
      rate: signed(Math.max(-50, Math.min(100, Number(o.rate) || 0))),
      pitch: signed(pitchToPercent(o.pitch)),
      volume: signed(Math.max(-50, Math.min(50, Number(o.volume) || 0))),
      timeout: 20000,
    });

    const chunks = [];
    const marks = [];
    this._activeSynth += 1;
    try {
      for await (const chunk of tts.streamAudio(String(text))) {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else if (chunk && typeof chunk.start === 'number') {
          marks.push({ name: 'word', timeMs: Math.round(chunk.start) });
        }
      }
    } catch (e) {
      const err = new Error(
        `在线合成失败：${e && e.message ? e.message : e}。请检查网络后重试` +
          `（设置里点「一键安装离线语音」后，没网也能朗读，且没有网络延迟）。`
      );
      err.code = C.ERR.EDGE_NETWORK;
      err.cause = e;
      throw err;
    } finally {
      this._activeSynth = Math.max(0, this._activeSynth - 1);
    }

    const audioData = new Uint8Array(Buffer.concat(chunks));
    if (audioData.length === 0) {
      const err = new Error('在线合成失败：未收到音频数据（服务无响应）');
      err.code = C.ERR.EDGE_NETWORK;
      throw err;
    }
    const durationMs = Math.max(
      Math.round((audioData.length / MP3_BYTES_PER_SEC) * 1000),
      marks.length ? marks[marks.length - 1].timeMs : 0
    );
    return {
      audioData,
      sampleRate: SAMPLE_RATE,
      durationMs,
      markers: marks,
      sentences: proportionalSentenceMarks(splitSentences(text), durationMs),
      backend: 'edge',
      format: 'mp3',
      voiceId: `${def.id}`,
    };
  }

  /** 装保活定时器（幂等）+ 锁屏解锁补位 */
  _armKeepAlive() {
    if (this._disposed || this._keepAlive) return this._keepAlive;
    const timer = setInterval(() => {
      // 连续失败说明网络/端点有问题：隔一轮再试，避免抖动时反过来把 IP 打到限流
      if (this._keepAliveFails >= KEEPALIVE_MAX_FAILS) {
        this._keepAliveFails -= 1;
        return;
      }
      this._keepAliveNow('interval');
    }, KEEPALIVE_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref(); // 别把进程钉住（探针/退出时友好）
    this._keepAlive = timer;

    if (powerMonitor && !this._onUnlock) {
      this._onUnlock = () => this._keepAliveNow('unlock');
      try {
        powerMonitor.on('unlock', this._onUnlock);
      } catch (e) {
        this._onUnlock = null;
      }
    }
    return this._keepAlive;
  }

  /** 单飞执行一次保活；并发调用共用同一个 Promise，不叠加请求 */
  _keepAliveNow(trigger) {
    if (this._disposed) return Promise.resolve(null);
    if (this._keepAlivePromise) return this._keepAlivePromise;
    const p = this._runKeepAlive(trigger).then(
      () => {
        if (this._keepAlivePromise === p) this._keepAlivePromise = null;
        return null;
      },
      () => {
        if (this._keepAlivePromise === p) this._keepAlivePromise = null;
        return null;
      }
    );
    this._keepAlivePromise = p;
    return p;
  }

  /** 真实短合成 + 丢弃音频；失败只记录，不抛不阻塞 */
  async _runKeepAlive(trigger) {
    try {
      if (!load()) return;
      // 用户正在朗读时不抢连接（避免两条 WebSocket 互相拖慢，热键路径优先）
      if (this._activeSynth > 0) return;
      const t0 = Date.now();
      try {
        await this._synthOnce(KEEPALIVE_TEXT, voiceDef(null), {});
        this._keepAliveFails = 0;
        this.onlineLastError = null; // 恢复后状态里不该再挂着旧错误
        this._keepAliveStat = {
          at: t0,
          ms: Date.now() - t0,
          ok: true,
          trigger,
          count: this._keepAliveStat.count + 1,
        };
      } catch (e) {
        this._keepAliveFails += 1;
        this._keepAliveStat = {
          at: t0,
          ms: Date.now() - t0,
          ok: false,
          trigger,
          count: this._keepAliveStat.count,
        };
        this.onlineLastError = {
          at: Date.now(),
          code: e.code || C.ERR.EDGE_NETWORK,
          message: e.message || String(e),
          voiceId: 'edge:xiaoxiao',
          stage: 'keepAlive',
        };
      }
    } catch (e) {
      /* 保活任何异常都不得穿透到热键路径 */
    }
  }
}

module.exports = EdgeTtsBackend;
