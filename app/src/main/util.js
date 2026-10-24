// 主进程通用工具（CJS）
'use strict';

/**
 * 按中文/英文句末标点切分句子（用于上一句/下一句与字幕）
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  if (!text) return [];
  const raw = String(text).replace(/\r/g, '');
  // 捕获分隔符并拼回，避免丢失标点
  const parts = raw.split(/([。！？!?；;]+|\n+)/);
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const seg = (parts[i] || '') + (parts[i + 1] || '');
    const t = seg.trim();
    if (t) out.push(t);
  }
  if (out.length === 0) {
    const t = raw.trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * 依据各句长度在总时长内按比例估算句级时间边界（无词边界时的可用近似）
 * @param {string[]} segments
 * @param {number} durationMs
 * @returns {Array<{index:number,startMs:number,endMs:number,text:string}>}
 */
function proportionalSentenceMarks(segments, durationMs) {
  const total = segments.reduce((s, x) => s + x.length, 0) || 1;
  let acc = 0;
  return segments.map((seg, idx) => {
    const start = Math.round((acc / total) * durationMs);
    acc += seg.length;
    const end = Math.round((acc / total) * durationMs);
    return { index: idx, startMs: start, endMs: end, text: seg };
  });
}

/**
 * 解析 WAV 头，返回采样率 / 声道数 / 位深
 * @param {Uint8Array|Buffer} buf
 */
function parseWavHeader(buf) {
  const ab = buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
  const dv = new DataView(ab);
  // RIFF(4) size(4) WAVE(4) fmt (4) sub1Size(4)
  const sampleRate = dv.getUint32(24, true);
  const numChannels = dv.getUint16(22, true);
  const bitsPerSample = dv.getUint16(34, true);
  return { sampleRate, numChannels, bitsPerSample };
}

/**
 * Float32 单声道 PCM → 16-bit WAV Uint8Array
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} [numChannels]
 * @returns {Uint8Array}
 */
function float32ToWav(samples, sampleRate, numChannels = 1) {
  const len = samples.length;
  const buffer = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buffer);
}

module.exports = {
  splitSentences,
  proportionalSentenceMarks,
  parseWavHeader,
  float32ToWav,
};
