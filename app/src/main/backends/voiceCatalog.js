// 音色目录：本地 SAPI（NVSA）与在线 Edge 共用同一套「音色 key」（xiaoxiao / yunxi）。
// 目的：引擎切换（本地 ⇄ 在线）时用户的选择不丢失 —— 上层只认 key，不认引擎前缀。
// 音色 id 仍带引擎前缀（sapi:xxx / edge:xxx），但解析时先按 key 匹配，再按 id 精确匹配。
'use strict';

const C = require('../../shared/constants');

/** 本地 SAPI 音色定义（keywords 用于在 SAPI 枚举结果里匹配微软自然语音名） */
const SAPI_VOICES = [
  {
    key: 'xiaoxiao',
    id: 'sapi:xiaoxiao',
    name: '晓晓',
    gender: 'female',
    keywords: ['xiaoxiao', '晓晓'],
    desc: '本地离线神经语音 · 女声',
  },
  {
    key: 'yunxi',
    id: 'sapi:yunxi',
    name: '云希',
    gender: 'male',
    keywords: ['yunxi', '云希'],
    desc: '本地离线神经语音 · 男声',
  },
  {
    // 本地兜底层：NVSA 的神经语音没装时，用系统内置中文语音顶上。
    // 实测 Microsoft Huihui Desktop 走常驻通道合成 18~43ms（预热 547ms），
    // 端到端 ≈90ms —— 音质是旧版机械音，但「立刻出声」比音质更符合低视力用户诉求。
    // keywords 仅供 matchesVoice 判断，主循环会跳过它（fallbackOnly），由 pickSapiVoices 末尾单独挑。
    key: 'system',
    id: 'sapi:system',
    name: '系统语音',
    gender: 'female',
    keywords: ['huihui', 'chinese', '中文'],
    desc: '系统内置语音 · 音质一般，但几乎零延迟（离线语音没装好时自动使用）',
    fallbackOnly: true,
  },
];

const VOICE_KEYS = ['xiaoxiao', 'yunxi', 'system'];
const DEFAULT_KEY = 'xiaoxiao';

/**
 * 跨引擎统一 key 的兜底链（按顺序尝试，取第一个可用的；空数组 = 无兜底）。
 * 用户口径：在线兜底单音色即可 —— 云希没声时回退晓晓，保证「一定有声音」；
 * 体系可扩展：加音色只需在 SAPI_VOICES / constants.EDGE_VOICES 里加一条，
 * 再在这里补一行兜底链，引擎侧代码零改动。
 */
const VOICE_FALLBACK_CHAIN = {
  xiaoxiao: [],
  yunxi: ['xiaoxiao'],
};

/**
 * 从任意音色 id（edge:xiaoxiao / sapi:yunxi / xiaoxiao）解析出音色 key
 * @param {string} [voiceId]
 * @returns {string|null}
 */
function voiceKeyOf(voiceId) {
  const s = String(voiceId || '').trim().toLowerCase();
  if (!s) return null;
  const i = s.indexOf(':');
  const k = i >= 0 ? s.slice(i + 1) : s;
  return VOICE_KEYS.indexOf(k) >= 0 ? k : null;
}

/** SAPI 语音名（如 "Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)"）是否命中某音色 */
function matchesVoice(name, def) {
  const n = String(name || '').toLowerCase();
  return def.keywords.some((k) => n.indexOf(k.toLowerCase()) >= 0);
}

/**
 * 在 SAPI 枚举出的语音名里为各音色挑一个最合适的语音。
 * 优先命中「Natural / Online」字样的微软神经语音，其次任意命中项。
 * @param {string[]} installedNames
 * @returns {Array<{key:string, name:string}>}
 */
function pickSapiVoices(installedNames) {
  const names = Array.isArray(installedNames) ? installedNames : [];
  const out = [];
  for (const def of SAPI_VOICES) {
    if (def.fallbackOnly) continue; // 兜底层在下面单独挑，不参与主循环
    const hits = names.filter((n) => matchesVoice(n, def));
    if (!hits.length) continue;
    // NVSA 注册的微软自然语音名通常含 "Natural"；优先取之，避免选到同名的旧 SAPI5 音库
    const natural = hits.find((n) => /natural/i.test(n)) || hits[0];
    out.push({ key: def.key, name: natural, id: def.id, kind: 'nvsa' });
  }
  if (out.length) return out;

  // NVSA（晓晓/云希）没装 → 退到系统内置中文语音，保证「本地零延迟」这条路始终有声音。
  // 这是有意的降级：音质让位于响应速度，且必须让上层知道（kind='system'），不许静默。
  const sys = names.find((n) => /huihui|chinese|中文|zh-cn|zh_cn/i.test(String(n || '')));
  const def = SAPI_VOICES.find((d) => d.key === 'system');
  if (sys) out.push({ key: 'system', name: sys, id: def ? def.id : 'sapi:system', kind: 'system' });
  return out;
}

/** 在线 Edge 音色（id 与 constants.EDGE_VOICES 保持一致） */
function edgeVoiceIdOf(key) {
  const v = C.EDGE_VOICES.find((x) => x.key === key);
  return v ? v.id : C.DEFAULT_VOICE_ID;
}

/**
 * 某音色 key 的兜底 key 列表（不含自身，已去重、已过滤未知 key）
 * @param {string} [key]
 * @returns {string[]}
 */
function fallbackKeysOf(key) {
  const k = VOICE_KEYS.indexOf(String(key || '')) >= 0 ? String(key) : DEFAULT_KEY;
  const chain = VOICE_FALLBACK_CHAIN[k] || [];
  return chain.filter((x, i) => x !== k && VOICE_KEYS.indexOf(x) >= 0 && chain.indexOf(x) === i);
}

/**
 * 尝试顺序：自身 + 兜底链。调用方按序尝试，第一个成功即用；
 * 用到非首位的那次必须对外标记 degraded + fallbackReason（不得静默）。
 * @param {string} [key]
 * @returns {Array<{key:string, isFallback:boolean}>}
 */
function voicePlanOf(key) {
  const primary = VOICE_KEYS.indexOf(String(key || '')) >= 0 ? String(key) : DEFAULT_KEY;
  return [{ key: primary, isFallback: false }].concat(
    fallbackKeysOf(primary).map((x) => ({ key: x, isFallback: true }))
  );
}

module.exports = {
  SAPI_VOICES,
  VOICE_KEYS,
  DEFAULT_KEY,
  VOICE_FALLBACK_CHAIN,
  voiceKeyOf,
  matchesVoice,
  pickSapiVoices,
  edgeVoiceIdOf,
  fallbackKeysOf,
  voicePlanOf,
};
