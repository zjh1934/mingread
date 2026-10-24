// 共享类型（JSDoc 契约，主进程 CJS）
'use strict';

/**
 * @typedef {Object} VoiceConfig
 * @property {string} id        我们的内部音色 id（xiaoxiao / yunxi）
 * @property {string} displayName 展示名（晓晓 / 云希）
 * @property {string} locale    语言区域（zh-CN）
 * @property {'female'|'male'} gender
 * @property {boolean} isDefault
 * @property {string} [backend] 'windows-media' | 'edge' | 'unknown'
 * @property {string} [nativeId] 系统/引擎原生语音标识
 * @property {'offline'|'online'} [source] 来源层：离线语音包 / Edge 在线兜底
 */

/**
 * @typedef {Object} TtsOptions
 * @property {string} [voiceId] 我们的音色 id（默认晓晓）
 * @property {number} [rate]    -50%~+100%
 * @property {number} [pitch]   -50Hz~+50Hz
 * @property {number} [volume]  -50%~+50%
 * @property {boolean} [ssml]   是否以 SSML 输入
 */

/**
 * @typedef {Object} Marker
 * @property {string} name  'word' | 'sentence' 等
 * @property {number} timeMs 起始时间（毫秒）
 */

/**
 * @typedef {Object} TtsResult
 * @property {Uint8Array} audioData  WAV 字节
 * @property {number} sampleRate
 * @property {number} durationMs
 * @property {Marker[]} markers     词/句边界（用于字幕、跳转）
 * @property {SentenceMark[]} sentences 句级边界（用于上一句/下一句）
 * @property {string} backend
 */

/**
 * @typedef {Object} SentenceMark
 * @property {number} index
 * @property {number} startMs
 * @property {number} endMs
 * @property {string} text
 */

/**
 * @typedef {Object} ReadItem
 * @property {string} id
 * @property {string} title
 * @property {string} [sourcePath]
 * @property {'text'|'file'} kind
 * @property {string} content
 * @property {number} positionMs
 */

/**
 * 归一化并夹取 TTS 参数到合法范围
 * @param {Partial<TtsOptions>} [opts]
 * @returns {TtsOptions}
 */
function normalizeTtsOptions(opts) {
  opts = opts || {};
  const clamp = (v, min, max, d) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  return {
    voiceId: typeof opts.voiceId === 'string' ? opts.voiceId : 'xiaoxiao',
    rate: clamp(opts.rate, -50, 100, 0),
    pitch: clamp(opts.pitch, -50, 50, 0),
    volume: clamp(opts.volume, -50, 50, 0),
    ssml: Boolean(opts.ssml),
  };
}

module.exports = { normalizeTtsOptions };
