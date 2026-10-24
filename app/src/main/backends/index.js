// 引擎抽象层：统一接口契约 + 注册表（ttsBridge 只依赖本文件，不直接依赖具体后端实现）。
//
// ---- 引擎契约（每个后端必须实现）----
//   id            : string                     引擎标识（'sapi' | 'edge'）
//   kind          : 'local' | 'online'         本地离线 / 联网
//   label         : string                     展示名
//   isAvailable() : boolean                    同步粗判（不启动进程、不发网络请求）
//   probe(force?) : Promise<ProbeResult>        异步探测（允许有副作用：拉起长驻通道 / 枚举语音）
//                   ProbeResult = { available:boolean, reason?:string, message?:string, detail?:object }
//   listVoices()  : VoiceConfig[]              该引擎当前可用的音色
//   synthesize(text, opts): Promise<TtsResult> 合成；失败必须 throw（禁止返回空音频假装成功）
//   warmup()      : void                       后台预热（把冷启动开销挪到空闲时）
//   invalidate()  : void                       丢弃缓存（注册表/语音列表变化后调用）
//   dispose()     : void                       释放长驻资源
//
// ---- 路由策略（实现在 ttsBridge）----
//   本地 NVSA（SAPI）优先 → espeak（仅 Linux/沙箱，验证专用，不进入产品分发）
//   → 在线 Edge 兜底 → 仍失败则明确报错（绝不静默、不假装播放）
'use strict';

const SapiBackend = require('./sapiBackend');
const EdgeTtsBackend = require('./edgeTtsBackend');
// ⚠️ espeak 后端是沙箱/CI 验证专用，不进入产品分发（详见 espeakBackend.js 头部说明）
const EspeakBackend = require('./espeakBackend');
const { ENGINE_ERR, LOCAL_REASON, LOCAL_REASON_TEXT } = require('./engineErrors');

/**
 * 按优先级创建引擎链（顺序即 ttsBridge 的探测顺序）：
 *   本地 SAPI（NVSA，Windows）→ espeak（仅 Linux/沙箱，验证专用）→ 在线 Edge
 * @param {{sapi?:object, espeak?:object|null, edge?:object}} [overrides] 注入用（测试可替换后端实例；
 *         espeak 传 null 表示显式剔除沙箱引擎，保持注入链精确可控）
 */
function createEngines(overrides) {
  const o = overrides || {};
  const espeak = 'espeak' in o ? o.espeak : new EspeakBackend();
  return [o.sapi || new SapiBackend(), espeak, o.edge || new EdgeTtsBackend()].filter(Boolean);
}

module.exports = {
  ENGINE_ERR,
  LOCAL_REASON,
  LOCAL_REASON_TEXT,
  createEngines,
  SapiBackend,
  EdgeTtsBackend,
  EspeakBackend,
};
