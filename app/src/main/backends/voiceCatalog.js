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

// ---------------------------------------------------------------- 动态音色（音色源注册）
//
// 背景：SAPI_VOICES 原先是写死的三件套，用户用「音色源」（voiceSources）装好的新发音人
// 因为不在目录里，sapiBackend.listVoices() 过滤掉、voiceKeyOf() 也解析不了 —— 装得上、选不到。
// 这里把「目录」变成可追加的：动态项与内置项同构（key/id/name/gender/keywords/desc），
// 但只能用 registerDynamicVoices 追加，且**永不覆盖内置 key**（内置项是兜底语义的基石）。

/** 内置 key 快照（注册动态音色时据此判重，内置项不可被覆盖） */
const BUILTIN_VOICE_KEYS = VOICE_KEYS.slice();

/** 已注册的动态音色 key（按注册顺序；clearDynamicVoices 用它精确回滚） */
let _dynamicKeys = [];
/** 动态音色注册过程中的告警（重复 key / 非法 key 等），供上层诊断用 */
let _dynamicWarnings = [];

function warnDynamic(code, message, key) {
  _dynamicWarnings.push({ code, key: key || null, message });
}
/**
 * 注册一批动态音色（来自音色源清单），追加到 SAPI_VOICES / VOICE_KEYS / VOICE_FALLBACK_CHAIN。
 *
 * 入参项：{ key, displayName, gender, locale, desc?, keywords? }
 *   - keywords 可选：清单里给了就用它（用它去匹配系统枚举出的语音名），否则用 [key, displayName]。
 *   - 重复 key（含与内置项同名、同批内重复）一律忽略并记 warning，**不覆盖**已有定义。
 *
 * @param {Array<{key?:string, displayName?:string, gender?:string, locale?:string, desc?:string, keywords?:string[]}>} list
 * @returns {{added:string[], ignored:Array<{key:string, reason:string}>, warnings:Array}}
 */
function registerDynamicVoices(list) {
  const arr = Array.isArray(list) ? list : [];
  const added = [];
  const ignored = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') {
      warnDynamic('DYNAMIC_VOICE_INVALID', '动态音色项不是对象，已忽略');
      ignored.push({ key: '', reason: 'INVALID' });
      continue;
    }
    const key = String(raw.key == null ? '' : raw.key).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]*$/.test(key) || key.length < 2 || key.length > 32) {
      warnDynamic('DYNAMIC_VOICE_INVALID_KEY', `动态音色 key「${key}」不合法，已忽略`, key);
      ignored.push({ key, reason: 'INVALID_KEY' });
      continue;
    }
    if (VOICE_KEYS.indexOf(key) >= 0) {
      const isBuiltin = BUILTIN_VOICE_KEYS.indexOf(key) >= 0;
      warnDynamic(
        isBuiltin ? 'DYNAMIC_VOICE_BUILTIN' : 'DYNAMIC_VOICE_DUPLICATE',
        isBuiltin
          ? `动态音色 key「${key}」与内置音色同名，已忽略（内置项不会被覆盖）`
          : `动态音色 key「${key}」重复注册，已忽略`,
        key
      );
      ignored.push({ key, reason: isBuiltin ? 'BUILTIN_KEY' : 'DUPLICATE_KEY' });
      continue;
    }
    const displayName = String(raw.displayName == null ? '' : raw.displayName).trim() || key;
    const g = String(raw.gender == null ? '' : raw.gender).trim().toLowerCase();
    const gender = ['female', 'male', 'neutral'].indexOf(g) >= 0 ? g : 'neutral';
    const locale = String(raw.locale == null ? '' : raw.locale).trim() || 'zh-CN';
    // 清单里显式给的 keywords 优先（系统语音名与 key 不一致时必须靠它匹配）；否则 key + 显示名
    const kwIn = Array.isArray(raw.keywords) ? raw.keywords.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : [];
    const keywords = [];
    (kwIn.length ? kwIn : [key, displayName]).forEach((k) => {
      if (k && keywords.indexOf(k) < 0) keywords.push(k);
    });

    SAPI_VOICES.push({
      key,
      id: `sapi:${key}`,
      name: displayName,
      gender,
      locale,
      keywords,
      desc: String(raw.desc == null ? '' : raw.desc).trim() || '来自音色源 · 动态注册',
      dynamic: true, // 标记：pickSapiVoices 对动态项有额外约束（见下）
    });
    VOICE_KEYS.push(key);
    // 动态音色无兜底：绝不能因为用户选了它而悄悄念成别人的声音
    VOICE_FALLBACK_CHAIN[key] = [];
    _dynamicKeys.push(key);
    added.push(key);
  }
  return { added, ignored, warnings: _dynamicWarnings.slice() };
}

/** 当前已注册的动态音色定义（返回副本，防止外部改坏目录） */
function getDynamicVoices() {
  return _dynamicKeys
    .map((k) => SAPI_VOICES.find((d) => d.key === k))
    .filter(Boolean)
    .map((d) => ({ ...d, keywords: (d.keywords || []).slice() }));
}

/** 动态音色的注册告警（诊断用） */
function getDynamicVoiceWarnings() {
  return _dynamicWarnings.slice();
}

/**
 * 清空全部动态音色（测试用；音色源变更后重建目录也用它）。
 * @returns {number} 被移除的数量
 */
function clearDynamicVoices() {
  const keys = _dynamicKeys.slice();
  for (const k of keys) {
    for (let i = SAPI_VOICES.length - 1; i >= 0; i -= 1) {
      if (SAPI_VOICES[i].key === k && SAPI_VOICES[i].dynamic) SAPI_VOICES.splice(i, 1);
    }
    const ki = VOICE_KEYS.indexOf(k);
    if (ki >= 0) VOICE_KEYS.splice(ki, 1);
    delete VOICE_FALLBACK_CHAIN[k];
  }
  _dynamicKeys = [];
  _dynamicWarnings = [];
  return keys.length;
}

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
  const kws = (def && def.keywords) || [];
  return kws.some((k) => n.indexOf(String(k).toLowerCase()) >= 0);
}

/** 系统内置中文语音（兜底层）的识别式：动态音色不许抢这些名字 */
const SYSTEM_NAME_RE = /huihui|chinese|中文|zh-cn|zh_cn/i;

/** NVSA 注册的神经语音名特征（含 Natural / Online）；动态音色只在其上匹配，避免抢到旧 SAPI5 音库 */
const NATURAL_NAME_RE = /natural|online/i;

/**
 * 在 SAPI 枚举出的语音名里为各音色挑一个最合适的语音。
 * 优先级：内置音色 → 动态音色（音色源注册）→ 系统兜底。
 *  - 每个枚举名只能被一个音色占用（claimed），避免两个 key 指向同一个发音人；
 *  - 动态音色只认带 Natural/Online 字样的枚举名：系统内置音（如 Huihui Desktop）始终留给 system，
 *    这样清单里 keywords 写宽了（例如顺手写了 "chinese"）也不会把兜底音色顶掉。
 * @param {string[]} installedNames
 * @returns {Array<{key:string, name:string, id?:string, kind:string}>}
 */
function pickSapiVoices(installedNames) {
  const names = Array.isArray(installedNames) ? installedNames : [];
  const out = [];
  const claimed = [];
  for (const def of SAPI_VOICES) {
    if (def.fallbackOnly) continue; // 兜底层在下面单独挑，不参与主循环
    const hits = names.filter((n) => {
      if (claimed.indexOf(n) >= 0) return false; // 已被别的音色占用
      if (def.dynamic && !NATURAL_NAME_RE.test(String(n || ''))) return false; // 系统旧音库不归动态音色
      return matchesVoice(n, def);
    });
    if (!hits.length) continue;
    // NVSA 注册的微软自然语音名通常含 "Natural"；优先取之，避免选到同名的旧 SAPI5 音库
    const natural = hits.find((n) => /natural/i.test(n)) || hits[0];
    out.push({ key: def.key, name: natural, id: def.id, kind: 'nvsa' });
    claimed.push(natural);
  }
  if (out.length) return out;

  // NVSA（晓晓/云希）没装 → 退到系统内置中文语音，保证「本地零延迟」这条路始终有声音。
  // 这是有意的降级：音质让位于响应速度，且必须让上层知道（kind='system'），不许静默。
  const sys = names.find((n) => SYSTEM_NAME_RE.test(String(n || '')));
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
  BUILTIN_VOICE_KEYS,
  voiceKeyOf,
  matchesVoice,
  pickSapiVoices,
  registerDynamicVoices,
  getDynamicVoices,
  getDynamicVoiceWarnings,
  clearDynamicVoices,
  edgeVoiceIdOf,
  fallbackKeysOf,
  voicePlanOf,
};
