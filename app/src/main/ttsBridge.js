// TtsBridge（v2.4 引擎抽象层）：本地优先 + 沙箱验证引擎 + 在线兜底。
//
//   ttsBridge（按优先级依次探测，第一个可用的引擎出声）
//     ├── 本地 NVSA（SAPI）    ← 产品首选：Windows 可用时优先（离线、百毫秒级）
//     ├── espeak（沙箱/CI 专用）← 仅 Linux/沙箱：验证链路用，不进入产品分发（见 backends/espeakBackend.js）
//     └── 在线 Edge            ← 兜底：网络可用时（node-edge-tts）
//
// 三条不可动摇的原则：
//   1. 本地优先：本地可用就用本地，用户无需做任何选择。
//   2. 降级可感知：任何一次没走到首选引擎，都记录原因（getStatus().fallback /
//      getEngineStatus() / synthesize 返回的 fallbackReason），上层拿去播报
//      「已切换到 X，原因：xxx」，绝不静默。沙箱里默认路径就是
//      SAPI 不可用（非 Windows）→ espeak，这条降级原因同样完整可感知。
//   3. 失败明确报错：所有引擎都不通时抛出可读错误，绝不返回空音频假装播放成功。
'use strict';

const C = require('../shared/constants');
const { normalizeTtsOptions } = require('../shared/types');
const { ENGINE_ERR, LOCAL_REASON_TEXT } = require('./backends');
const SapiBackend = require('./backends/sapiBackend');
const EdgeTtsBackend = require('./backends/edgeTtsBackend');
// ⚠️ espeak 后端是沙箱/CI 验证专用，不进入产品分发；仅在链路里兜底验证，不做任何产品化包装
const EspeakBackend = require('./backends/espeakBackend');
const { voiceKeyOf, edgeVoiceIdOf } = require('./backends/voiceCatalog');
const { getSettings } = require('./settingsStore');

const ENGINE_LABEL = { sapi: '本地离线语音（NVSA）', espeak: 'espeak-ng 中文语音（沙箱/CI 验证专用）', edge: '微软 Edge 在线语音' };

/**
 * 构建引擎链（顺序即探测顺序）：
 *   不传注入 → 产品/沙箱默认链 [SAPI, espeak, Edge]；
 *   传入 injected（测试用）→ 完全按注入列表构建，缺的补默认；
 *   未显式提供 espeak 时不插入沙箱引擎（注入链保持精确可控，与旧行为一致）。
 * @param {{sapi?:object, espeak?:object|null, edge?:object}} [injected]
 */
function buildEngineChain(injected) {
  const sapi = (injected && injected.sapi) || new SapiBackend();
  const edge = (injected && injected.edge) || new EdgeTtsBackend();
  const espeak = injected && 'espeak' in injected ? injected.espeak : injected ? null : new EspeakBackend();
  return [sapi, espeak, edge].filter(Boolean);
}

/** 全链路失败时的合并描述（每个引擎为什么没成，供播报） */
function describeAttempts(attempts, labelOf) {
  if (!attempts.length) return '本地语音不可用（未探测）';
  return attempts.map((a) => `${labelOf(a.id)}不可用：${a.message || '原因未知'}`).join('；');
}

class TtsBridge {
  /**
   * @param {object} [opts]
   * @param {{sapi?:object, espeak?:object|null, edge?:object}} [opts.engines] 注入后端（测试用）
   * @param {boolean} [opts.noWarmup] 禁止后台预热（测试用）
   */
  constructor(opts = {}) {
    const o = opts || {};
    this.engines = buildEngineChain(o.engines);
    this.locals = this.engines.filter((e) => e.kind === 'local');
    this.online = this.engines.find((e) => e.kind === 'online') || this.engines[this.engines.length - 1];
    // 兼容旧字段：本地首选（SAPI）；沙箱验证引擎单列，便于上层识别「现在是不是在走验证路径」
    this.local = this.locals[0] || null;
    this.sandbox = this.locals.find((e) => e.id === 'espeak') || null;
    this._labelOf = (id) => (this.engines.find((e) => e.id === id) || {}).label || id || '未知引擎';
    this._cache = null;
    this._fallback = null; // { from, to, reason, message, code, attempts, at }
    this._listeners = new Set();
    this._warmupDone = false;
    if (!o.noWarmup) {
      // 后台预热：把各引擎的冷启动（PowerShell 通道 / espeak 首次进程）挪到空闲时，不在热键路径上支付
      setImmediate(() => this.warmup());
    }
  }

  init() {
    return this;
  }

  invalidate() {
    this._cache = null;
    for (const e of this.engines) {
      if (e && typeof e.invalidate === 'function') e.invalidate();
    }
    return this;
  }

  /** 在线兜底是否允许（v2.3 精简版 settings 里 edgeEnabled 缺省为 undefined，按启用处理） */
  get autoFallback() {
    let s = {};
    try {
      s = getSettings();
    } catch (e) {
      s = {};
    }
    return s.autoFallback !== false && s.edgeEnabled !== false;
  }

  // ---- 音色 ----

  listVoices() {
    if (this._cache) return this._cache;
    let settings = {};
    try {
      settings = getSettings();
    } catch (e) {
      settings = {};
    }
    // 按链路顺序取第一个已探测可用的本地引擎的音色；都没有才落在音色表上
    let list = [];
    for (const eng of this.locals) {
      const lp = eng.lastProbe ? eng.lastProbe() : null;
      if (lp && lp.available) {
        list = this._safe(() => eng.listVoices(), []);
        if (list.length) break;
      }
    }
    if (!list.length) list = this._safe(() => this.online.listVoices(), []);
    const curKey = voiceKeyOf(settings.voiceId);
    list = list.map((v) => ({
      ...v,
      isDefault: v.id === settings.voiceId || (!!curKey && voiceKeyOf(v.id) === curKey),
    }));
    if (!list.some((v) => v.isDefault) && list.length) list[0] = { ...list[0], isDefault: true };
    this._cache = list;
    return list;
  }

  getVoice(voiceId) {
    const list = this.listVoices();
    const key = voiceKeyOf(voiceId);
    return (
      list.find((v) => v.id === voiceId) ||
      (key ? list.find((v) => voiceKeyOf(v.id) === key) : null) ||
      list.find((v) => v.isDefault) ||
      list[0] ||
      null
    );
  }

  isAvailable() {
    for (const eng of this.locals) {
      const lp = eng.lastProbe ? eng.lastProbe() : null;
      if (lp && lp.available) return true;
    }
    return this._safe(() => !!this.online.isAvailable(), false);
  }

  // ---- 合成 ----

  /**
   * 按链路顺序合成：SAPI → espeak（沙箱）→ Edge。
   * @param {string} text
   * @param {Partial<import('../shared/types').TtsOptions>} [opts]
   * @returns {Promise<import('../shared/types').TtsResult & {engine:string, local:boolean, degraded:boolean}>}
   */
  async synthesize(text, opts) {
    if (!text || !String(text).trim()) {
      const err = new Error('合成文本为空');
      err.code = C.ERR.TTS_SYNTH_FAIL;
      throw err;
    }
    const o = normalizeTtsOptions(opts);
    const key = voiceKeyOf(o.voiceId) || 'xiaoxiao';

    // 1) 本地链（SAPI → espeak）依次探测、依次尝试
    const attempts = [];
    for (const eng of this.locals) {
      const probe = await this._safeAsync(() => eng.probe(), {
        available: false,
        reason: ENGINE_ERR.LOCAL_UNAVAILABLE,
        message: '探测异常',
      });
      if (!probe.available) {
        attempts.push({
          id: eng.id,
          stage: 'probe',
          reason: probe.reason || ENGINE_ERR.LOCAL_UNAVAILABLE,
          message: probe.message || LOCAL_REASON_TEXT[probe.reason] || '本地语音不可用',
        });
        continue;
      }
      try {
        const res = await eng.synthesize(text, { ...o, voiceId: `${eng.id}:${key}` });
        if (attempts.length) {
          // 没走到首选引擎：降级原因必须可感知（例如沙箱里「SAPI 仅支持 Windows → espeak」）
          const first = attempts[0];
          this._noteFallback({
            from: first.id,
            to: eng.id,
            reason: first.reason,
            message: `${this._labelOf(first.id)}不可用：${first.message}；已切换到${this._labelOf(eng.id)}`,
            attempts,
          });
        } else {
          this._clearFallback();
        }
        return {
          ...res,
          engine: eng.id,
          local: true,
          degraded: attempts.length > 0,
          fallbackReason: attempts.length ? this._fallback : null,
          format: res.format || 'wav',
        };
      } catch (e) {
        attempts.push({
          id: eng.id,
          stage: 'synth',
          reason: e.reason || ENGINE_ERR.LOCAL_SYNTH_FAIL,
          message: e.message,
          code: e.code,
        });
      }
    }

    // 2) 本地全失败 → 在线兜底（合并所有本地原因，绝不静默）
    const first = attempts[0];
    const localSummary = describeAttempts(attempts, this._labelOf);
    this._noteFallback({
      from: first ? first.id : 'local',
      to: 'edge',
      reason: first ? first.reason : ENGINE_ERR.LOCAL_UNAVAILABLE,
      message: `${localSummary}；已切换到在线 Edge 语音`,
      attempts,
    });
    if (!this.autoFallback) {
      const err = new Error(`本地语音不可用（${localSummary}），在线兜底已关闭`);
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      err.attempts = attempts;
      throw err;
    }
    return this._synthOnline(text, o, key, localSummary);
  }

  /** 在线兜底；失败则把「本地为什么不行 + 在线为什么不行」一起抛出，不静默、不假装播放 */
  async _synthOnline(text, o, key, localReason) {
    const available = this._safe(() => !!this.online.isAvailable(), false);
    if (!available) {
      const err = new Error(`本地语音不可用（${localReason}）；在线兜底也不可用（缺少 node-edge-tts 依赖）。`);
      err.code = ENGINE_ERR.ALL_UNAVAILABLE;
      throw err;
    }
    try {
      const res = await this.online.synthesize(text, { ...o, voiceId: edgeVoiceIdOf(key) });
      return {
        ...res,
        engine: 'edge',
        local: false,
        degraded: true,
        fallbackReason: this._fallback,
        format: res.format || 'mp3',
      };
    } catch (e) {
      const err = new Error(`本地语音不可用（${localReason}）；在线兜底也失败：${e.message}`);
      err.code = e.code || ENGINE_ERR.ALL_UNAVAILABLE;
      err.cause = e;
      throw err;
    }
  }

  // ---- 状态（供 UI 展示与语音播报）----

  /** 单个引擎的当前状态（探测结果 + 可用性） */
  _engineState(eng) {
    const lp = eng.lastProbe ? eng.lastProbe() : null;
    const available =
      eng.kind === 'local' ? !!(lp && lp.available) : this._safe(() => !!eng.isAvailable(), false);
    return {
      id: eng.id,
      kind: eng.kind,
      label: eng.label,
      available,
      verificationOnly: eng.id === 'espeak',
      reason: available ? null : lp && lp.reason,
      message: available ? null : lp && lp.message,
      voices: available && lp && lp.voices ? lp.voices : [],
      installedCount: lp && lp.installed ? lp.installed.length : null,
      detail: lp && lp.detail ? lp.detail : null,
      info: typeof eng.getInfo === 'function' ? eng.getInfo() : null,
    };
  }

  /** 引擎状态：上层（播报 / 设置界面）据此说明「为什么现在是这条路」 */
  getEngineStatus() {
    const states = this.engines.map((e) => this._engineState(e));
    const active = states.find((s) => s.available) || null;
    const byId = (id) => states.find((s) => s.id === id) || null;
    return {
      active: active ? active.id : null,
      activeLabel: active ? active.label : '无可用引擎',
      activeVerificationOnly: !!(active && active.verificationOnly),
      // 探测顺序即链路顺序（播报「当前链路 SAPI → espeak → Edge」用）
      chain: states.map((s) => s.id),
      local: byId('sapi'), // 兼容旧字段：本地首选（SAPI）
      sandbox: byId('espeak'), // 沙箱/CI 验证引擎（可为 null：注入链未插入时）
      online: byId('edge'),
      fallback: this._fallback,
      degraded: !!this._fallback,
      autoFallback: this.autoFallback,
      engines: states,
    };
  }

  /** 完整状态（兼容 v2.3 契约，另加 engines / local / fallback / degraded / chain） */
  getStatus() {
    let base = {};
    try {
      // eslint-disable-next-line global-require
      base = require('./voiceSetup').getStatus();
    } catch (e) {
      base = {};
    }
    const es = this.getEngineStatus();
    const voices = this.listVoices().map((v) => ({
      id: v.id,
      displayName: v.displayName,
      gender: v.gender,
      locale: v.locale,
      desc: v.desc,
      source: v.source || (v.engine === 'sapi' ? 'offline' : 'online'),
      engine: v.engine,
      isDefault: !!v.isDefault,
      available: !!v.available,
      verificationOnly: !!v.verificationOnly,
    }));
    const activeState = es.engines.find((s) => s.id === es.active) || null;
    const detail =
      es.active === 'sapi'
        ? '本地离线合成 · 无需网络 · 晓晓 / 云希'
        : es.active === 'espeak'
          ? `espeak-ng 验证专用合成（沙箱/CI）· 机器人音色${es.fallback ? `（${es.fallback.message}）` : ''}`
          : es.active === 'edge'
            ? `在线合成 · 需要网络 · 晓晓 / 云希${es.fallback ? `（本地不可用：${es.fallback.reason}）` : ''}`
            : '没有可用语音引擎';
    return {
      ...base,
      engine: {
        ...(base.engine || {}),
        id: es.active || (base.engine && base.engine.id) || 'edge',
        label: es.activeLabel,
        online: !!(activeState && activeState.kind === 'online'),
        ready: !!es.active,
        voiceCount: voices.length,
        detail,
        lastError: (base.engine && base.engine.lastError) || null,
      },
      voices,
      engines: es.engines,
      local: es.local,
      sandbox: es.sandbox,
      fallback: es.fallback,
      degraded: es.degraded,
      autoFallback: es.autoFallback,
      offlineReady: es.engines.some((s) => s.kind === 'local' && s.available),
      tier: es.active === 'sapi' ? 'local' : es.active === 'espeak' ? 'espeak' : es.active === 'edge' ? 'edge' : 'none',
      chain: es.chain,
    };
  }

  /** 引擎状态变化订阅（本地可用/不可用、发生降级时回调） */
  onEngineChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  /** 重新探测各引擎（NVSA 注册完成 / 装上 espeak-ng 后调用：重枚举 + 刷缓存） */
  async refreshEngines() {
    this._cache = null;
    for (const eng of this.locals) {
      if (typeof eng.resetHost === 'function') eng.resetHost();
      await this._safeAsync(() => eng.probe(true), { available: false });
    }
    this._cache = null;
    this._notify();
    return this.getEngineStatus();
  }

  /** 后台预热（构造时自动调用一次） */
  warmup() {
    this._warmupDone = true;
    return this._safeAsync(async () => {
      for (const eng of this.locals) {
        const p = await eng.probe();
        if (p.available && typeof eng.warmup === 'function') eng.warmup();
        if (p.available) break; // 链路首个可用引擎预热即可
      }
      if (typeof this.online.warmup === 'function') this.online.warmup();
      this._cache = null;
      this._notify();
      return null;
    }, null);
  }

  dispose() {
    this._listeners.clear();
    for (const e of this.engines) {
      try {
        if (e && typeof e.dispose === 'function') e.dispose();
      } catch (err) {
        /* 释放失败不影响退出 */
      }
    }
  }

  // ---- 内部 ----

  _safe(fn, dflt) {
    try {
      return fn();
    } catch (e) {
      return dflt;
    }
  }

  async _safeAsync(fn, dflt) {
    try {
      return await fn();
    } catch (e) {
      return dflt;
    }
  }

  _noteFallback(info) {
    const prev = this._fallback;
    const next = { ...info, at: Date.now() };
    if (prev && prev.reason === next.reason && prev.message === next.message) return;
    this._fallback = next;
    this._cache = null;
    this._notify();
  }

  _clearFallback() {
    if (!this._fallback) return;
    this._fallback = null;
    this._cache = null;
    this._notify();
  }

  _notify() {
    const status = this.getEngineStatus();
    for (const cb of this._listeners) {
      try {
        cb(status);
      } catch (e) {
        /* 监听器异常不影响主流程 */
      }
    }
    // 顺带广播一次全局语音状态，渲染层无需改 preload 就能感知降级
    try {
      // eslint-disable-next-line global-require
      const voiceSetup = require('./voiceSetup');
      if (voiceSetup && typeof voiceSetup.broadcastStatus === 'function') voiceSetup.broadcastStatus();
    } catch (e) {
      /* voiceSetup 未就绪 */
    }
  }
}

let _instance = null;
function getBridge() {
  if (!_instance) _instance = new TtsBridge().init();
  return _instance;
}

/** 测试用：重置单例 */
function _resetBridge() {
  if (_instance) _instance.dispose && _instance.dispose();
  _instance = null;
}

module.exports = { TtsBridge, getBridge, _resetBridge, ENGINE_LABEL };
