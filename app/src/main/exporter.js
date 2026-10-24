// 导出：文本 → MP3（Edge 合成，按段拼接）/ 字幕 SRT·LRC。
// 只有 MP3 一种格式：在线语音本身就是 mp3，免转码、免 ffmpeg。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getBridge } = require('./ttsBridge');
const { splitSentences } = require('./util');

const CHUNK_CHARS = 600; // 单次请求的最大字数，避免超长文本被服务端截断

/** 把长文本切成若干段（优先在句末切） */
function chunkText(text, maxChars = CHUNK_CHARS) {
  const sentences = splitSentences(text);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur.length + s.length) > maxChars) {
      chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [String(text)];
}

function msToSrt(ms) {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const m2 = total % 1000;
  const p = (n, l) => String(n).padStart(l, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(m2, 3)}`;
}

function msToLrc(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  const p = (n, l) => String(n).padStart(l, '0');
  return `${p(m, 2)}:${p(s, 2)}.${p(cs, 2)}`;
}

function generateSrt(sentences) {
  return sentences
    .map((s, i) => `${i + 1}\n${msToSrt(s.startMs)} --> ${msToSrt(s.endMs)}\n${s.text}\n`)
    .join('\n');
}

function generateLrc(sentences) {
  return sentences.map((s) => `[${msToLrc(s.startMs)}]${s.text}`).join('\n');
}

/**
 * 导出当前文本为 MP3
 * @param {{text:string, opts?:object, outPath?:string, baseName?:string}} p
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, durationMs?:number, error?:string}>}
 */
async function exportCurrent({ text, opts = {}, outPath, baseName = '朗读音频' } = {}) {
  try {
    const bridge = getBridge();
    const chunks = chunkText(text || '');
    const parts = [];
    // v2.4：本地 SAPI 输出 wav（24k/16k 单声道 16bit），在线 Edge 输出 mp3（48kbps）
    let fmt = 'mp3';
    let sampleRate = 24000;
    for (const c of chunks) {
      if (!c.trim()) continue;
      const r = await bridge.synthesize(c, opts);
      parts.push(Buffer.from(r.audioData));
      if (r.format) fmt = r.format;
      if (r.sampleRate) sampleRate = r.sampleRate;
    }
    if (!parts.length) return { ok: false, error: '没有可导出的内容' };
    const data = Buffer.concat(parts);
    let finalPath = outPath || path.join(os.tmpdir(), `${baseName}.${fmt === 'wav' ? 'wav' : 'mp3'}`);
    // 调用方给的扩展名与实际格式不符时按实际格式纠正，避免产出“内容是 wav 却叫 .mp3”的文件
    if (fmt === 'wav' && /\.mp3$/i.test(finalPath)) finalPath = finalPath.replace(/\.mp3$/i, '.wav');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, data);
    const durationMs =
      fmt === 'wav'
        ? Math.round(((Math.max(0, data.length - 44) / (sampleRate * 2)) * 1000))
        : Math.round((data.length / 6000) * 1000);
    return { ok: true, path: finalPath, bytes: data.length, durationMs, format: fmt };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** 批量导出（列表里每一项一个 mp3） */
async function exportBatch(items, { opts = {}, outDir } = {}) {
  const dir = outDir || path.join(os.homedir(), 'Desktop');
  const paths = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = await exportCurrent({
      text: it.content || it.text || '',
      opts,
      outPath: path.join(dir, `${(it.title || `朗读_${i + 1}`).replace(/[\\/:*?"<>|]/g, '_')}.mp3`),
    });
    if (r.ok) paths.push(r.path);
  }
  return paths;
}

module.exports = {
  chunkText,
  generateSrt,
  generateLrc,
  exportCurrent,
  exportBatch,
  splitSentences,
};
