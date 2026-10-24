// 极简 EPUB 解析（不依赖第三方库）：读 zip 目录 → 找 OPF → 按 spine 顺序取章节文本。
// 只处理 store(0) / deflate(8) 两种压缩方式，覆盖 99% 的 epub。
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

/** 解析 zip 中央目录，返回 { 文件名: {offset, compressedSize, size, method} } */
function readZipEntries(buf) {
  // 从尾部找中央目录结束记录 EOCD(0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 EPUB（未找到 zip 目录）');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries[name] = { method, compressedSize, size, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entry) {
  const { localOffset } = entry;
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip 局部头损坏');
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`不支持的压缩方式：${entry.method}`);
}

const ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&#160;': ' ',
};

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<\s*head[^>]*>[\s\S]*?<\s*\/\s*head\s*>/gi, '');
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

function pickTitle(html, fallback) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m && m[1].trim()) return htmlToText(m[1]).slice(0, 80);
  const h = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  if (h && h[1].trim()) return htmlToText(h[1]).slice(0, 80);
  return fallback;
}

/**
 * @param {string} filePath
 * @returns {{ok:boolean, content?:string, chapters?:Array<{title:string,text:string}>, error?:string}}
 */
function readEpub(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    const entries = readZipEntries(buf);
    const containerName = Object.keys(entries).find((n) => /META-INF\/container\.xml$/i.test(n));
    if (!containerName) return { ok: false, error: 'EPUB 缺少 META-INF/container.xml' };
    const container = readEntry(buf, entries[containerName]).toString('utf8');
    const opfPath = (/full-path="([^"]+)"/i.exec(container) || [])[1];
    if (!opfPath) return { ok: false, error: 'EPUB 缺少 OPF 路径' };
    const opfDir = path.posix.dirname(opfPath);
    const opf = readEntry(buf, entries[opfPath]).toString('utf8');

    // manifest: id -> href
    const manifest = {};
    const itemRe = /<item\b[^>]*>/gi;
    let im;
    while ((im = itemRe.exec(opf))) {
      const tag = im[0];
      const id = (/\bid="([^"]+)"/i.exec(tag) || [])[1];
      const href = (/\bhref="([^"]+)"/i.exec(tag) || [])[1];
      if (id && href) manifest[id] = href;
    }
    // spine 顺序
    const spineIds = [];
    const refRe = /<itemref\b[^>]*\bidref="([^"]+)"/gi;
    let rm;
    while ((rm = refRe.exec(opf))) spineIds.push(rm[1]);

    const chapters = [];
    for (const id of spineIds) {
      const href = manifest[id];
      if (!href) continue;
      const full = opfDir && opfDir !== '.' ? path.posix.join(opfDir, href) : href;
      const candidates = [full, decodeURIComponent(full)];
      const key = candidates.find((k) => entries[k]);
      if (!key) continue;
      let html = '';
      try {
        html = readEntry(buf, entries[key]).toString('utf8');
      } catch (e) {
        continue;
      }
      const text = htmlToText(html);
      if (!text || text.length < 2) continue;
      chapters.push({ title: pickTitle(html, `第 ${chapters.length + 1} 节`), text });
    }

    if (!chapters.length) return { ok: false, error: 'EPUB 内未解析出可朗读文本' };
    const merged = chapters.map((c) => `${c.title}\n${c.text}`).join('\n\n');
    return { ok: true, content: merged, chapters, title: path.basename(filePath, path.extname(filePath)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { readEpub, htmlToText };
