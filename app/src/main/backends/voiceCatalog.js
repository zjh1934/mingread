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
];

const VOICE_KEYS = ['xiaoxiao', 'yunxi'];

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
    const hits = names.filter((n) => matchesVoice(n, def));
    if (!hits.length) continue;
    // NVSA 注册的微软自然语音名通常含 "Natural"；优先取之，避免选到同名的旧 SAPI5 音库
    const natural = hits.find((n) => /natural/i.test(n)) || hits[0];
    out.push({ key: def.key, name: natural });
  }
  return out;
}

/** 在线 Edge 音色（id 与 constants.EDGE_VOICES 保持一致） */
function edgeVoiceIdOf(key) {
  const v = C.EDGE_VOICES.find((x) => x.key === key);
  return v ? v.id : C.DEFAULT_VOICE_ID;
}

module.exports = { SAPI_VOICES, VOICE_KEYS, voiceKeyOf, matchesVoice, pickSapiVoices, edgeVoiceIdOf };
