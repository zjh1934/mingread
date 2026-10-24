#!/usr/bin/env node
/**
 * verify-mag-dll.js — Magnification.dll 可用性硬校验
 *
 * 用途：确认 resources/magnification/Magnification.dll 是一份 **未压缩的 x64 PE**，
 *       且导出 Windows Magnification API 的必要函数，可直接被 koffi/FFI 加载。
 *
 * 背景：精简版 Win10 19045 的 c:\Windows\System32\Magnification.dll 被删，
 *       WinSxS 里只剩 22726 字节的 Compact OS 压缩存根（文件头 "DCS\1"），
 *       koffi 加载会报 "找不到指定的模块"。本脚本用于拒绝这类坏文件。
 *
 * 用法：
 *   node verify-mag-dll.js [dll路径]
 *   默认路径 = <本脚本>/../resources/magnification/Magnification.dll
 *
 * 纯 Node 实现（仅用内置模块）：
 *   - 第 1/2/4 项由脚本自己解析 PE 头与导出表
 *   - 第 3 项解析 PE 资源段里的 VS_FIXEDFILEINFO / StringFileInfo
 *   - 第 5 项调用 PowerShell Get-AuthenticodeSignature（不可用时降级为"未知"）
 *
 * 退出码：全部通过 0，否则 1
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_DLL = path.resolve(
  __dirname,
  '..',
  'resources',
  'magnification',
  'Magnification.dll'
);

const REQUIRED_EXPORTS = [
  'MagInitialize',
  'MagUninitialize',
  'MagSetFullscreenTransform',
  'MagGetFullscreenTransform',
  'MagSetWindowSource',
  'MagSetWindowTransform',
  'MagShowSystemCursor',
];

const MIN_SIZE = 30 * 1024;
const MAX_SIZE = 200 * 1024;
const ACCEPT_VERSION_RE = /^10\.0\.(1904[1-9]|19045)\.\d+/;

const dllPath = path.resolve(process.argv[2] || DEFAULT_DLL);

const results = [];
function report(no, name, ok, detail) {
  results.push({ no, name, ok, detail });
  const tag = ok === true ? 'PASS' : ok === null ? 'WARN' : 'FAIL';
  console.log(`[${tag}] ${no}. ${name}`);
  for (const line of String(detail).split('\n')) console.log(`       ${line}`);
}

function fatal(msg) {
  console.log(`\n无法继续：${msg}`);
  console.log(`目标路径：${dllPath}`);
  process.exit(1);
}

// ---------- 读取文件 ----------
if (!fs.existsSync(dllPath)) fatal('文件不存在');
const buf = fs.readFileSync(dllPath);
const size = buf.length;
console.log('=== verify-mag-dll.js ===');
console.log(`目标文件: ${dllPath}`);
console.log(`文件大小: ${size} 字节 (${(size / 1024).toFixed(1)} KB)`);
console.log('');

// ---------- 第 1 项：MZ / PE / x64 ----------
let peOff = 0;
let machine = 0;
let peValid = false;
let check1Detail = '';
(function checkPE() {
  const head = buf.subarray(0, Math.min(4, size)).toString('latin1');
  if (head.startsWith('DCS')) {
    check1Detail = `前 4 字节为 "${head.replace(/[^\x20-\x7e]/g, '.')}"，这是 Compact OS 压缩存根，不是 PE 文件`;
    return;
  }
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    check1Detail = `前两字节为 0x${buf[0].toString(16)} 0x${buf[1].toString(16)}，不是 MZ (0x4D5A)`;
    return;
  }
  if (size < 0x40) {
    check1Detail = 'DOS 头截断';
    return;
  }
  peOff = buf.readUInt32LE(0x3c);
  if (peOff + 24 > size) {
    check1Detail = `e_lfanew (0x${peOff.toString(16)}) 越界`;
    return;
  }
  const sig = buf.toString('latin1', peOff, peOff + 4);
  if (sig !== 'PE\0\0') {
    check1Detail = `PE 签名错误: ${JSON.stringify(sig)}`;
    return;
  }
  machine = buf.readUInt16LE(peOff + 4);
  const optMagic = buf.readUInt16LE(peOff + 24);
  const okMagic = optMagic === 0x20b || optMagic === 0x10b;
  peValid = okMagic;
  check1Detail =
    `MZ 头: 是 (0x4D5A)\n` +
    `PE 签名: 是 (e_lfanew=0x${peOff.toString(16)})\n` +
    `OptionalHeader.Magic: 0x${optMagic.toString(16)} ${optMagic === 0x20b ? '(PE32+)' : optMagic === 0x10b ? '(PE32)' : '(未知)'}\n` +
    `Machine: 0x${machine.toString(16).toUpperCase()} ${machine === 0x8664 ? '(x64)' : machine === 0x14c ? '(x86 — 错误架构)' : '(非 x64)'}`;
})();
report(1, '文件头 MZ + 有效 PE + machine=0x8664 (x64)', peValid && machine === 0x8664, check1Detail);

// ---------- PE 工具：RVA -> 文件偏移 ----------
const optOff = peOff + 24;
const is64 = machine === 0x8664 || buf.readUInt16LE(optOff) === 0x20b;
const numDirsOff = optOff + (is64 ? 108 : 92);
const dirsOff = optOff + (is64 ? 112 : 96);
const numDirs = peValid ? buf.readUInt32LE(numDirsOff) : 0;
const sectionsOff = optOff + (is64 ? 240 : 224);
const numSections = peValid ? buf.readUInt16LE(peOff + 6) : 0;

function rvaToOff(rva) {
  for (let i = 0; i < numSections; i++) {
    const s = sectionsOff + i * 40;
    const vsize = buf.readUInt32LE(s + 8);
    const vaddr = buf.readUInt32LE(s + 12);
    const rsize = buf.readUInt32LE(s + 16);
    const raddr = buf.readUInt32LE(s + 20);
    const span = Math.max(vsize, rsize);
    if (rva >= vaddr && rva < vaddr + span) return raddr + (rva - vaddr);
  }
  return -1;
}

function readDir(index) {
  if (!peValid || index >= numDirs) return { rva: 0, size: 0 };
  return {
    rva: buf.readUInt32LE(dirsOff + index * 8),
    size: buf.readUInt32LE(dirsOff + index * 8 + 4),
  };
}

// ---------- 第 2 项：导出表 ----------
let exportsFound = [];
(function checkExports() {
  const exp = readDir(0);
  if (!exp.rva) {
    report(2, '导出表包含 Magnification API 必需函数', false, '没有导出目录');
    return;
  }
  const base = rvaToOff(exp.rva);
  if (base < 0) {
    report(2, '导出表包含 Magnification API 必需函数', false, '导出目录 RVA 无法映射到文件偏移');
    return;
  }
  const numNames = buf.readUInt32LE(base + 24);
  const namesRva = buf.readUInt32LE(base + 32);
  const namesOff = rvaToOff(namesRva);
  if (namesOff < 0) {
    report(2, '导出表包含 Magnification API 必需函数', false, '导出名表 RVA 无法映射');
    return;
  }
  const all = [];
  for (let i = 0; i < numNames; i++) {
    const nameRva = buf.readUInt32LE(namesOff + i * 4);
    const off = rvaToOff(nameRva);
    if (off < 0) continue;
    let end = off;
    while (end < size && buf[end] !== 0) end++;
    all.push(buf.toString('latin1', off, end));
  }
  exportsFound = all;
  const missing = REQUIRED_EXPORTS.filter((n) => !all.includes(n));
  const detail =
    `导出函数总数: ${all.length}\n` +
    REQUIRED_EXPORTS.map((n) => `  ${all.includes(n) ? '✓' : '✗'} ${n}`).join('\n') +
    (missing.length ? `\n缺失: ${missing.join(', ')}` : '\n全部必需符号均存在');
  report(2, '导出表包含 Magnification API 必需函数', missing.length === 0, detail);
})();

// ---------- 第 3 项：文件版本 ----------
function readVersionFromResource() {
  const res = readDir(2);
  if (!res.rva) return null;
  const resBase = rvaToOff(res.rva);
  if (resBase < 0) return null;

  // 遍历资源目录树：Type(16=RT_VERSION) -> Name -> Lang
  function entries(dirOff) {
    const out = [];
    if (dirOff < 0 || dirOff + 16 > size) return out;
    const named = buf.readUInt16LE(dirOff + 12);
    const ids = buf.readUInt16LE(dirOff + 14);
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      if (e + 8 > size) break;
      const nameField = buf.readUInt32LE(e);
      const dataField = buf.readUInt32LE(e + 4);
      out.push({ id: nameField & 0x7fffffff, isSubdir: (dataField & 0x80000000) !== 0, offset: (dataField & 0x7fffffff) });
    }
    return out;
  }

  const typeDir = resBase + entries(resBase).find((e) => e.isSubdir && e.id === 16)?.offset;
  if (!typeDir) return null;

  // 深度遍历到叶子
  function walk(dirOff, depth) {
    if (depth > 3) return null;
    for (const e of entries(dirOff)) {
      if (e.isSubdir) {
        const r = walk(resBase + e.offset, depth + 1);
        if (r) return r;
      } else {
        const de = resBase + e.offset;
        const dataRva = buf.readUInt32LE(de);
        const dataSize = buf.readUInt32LE(de + 4);
        const dataOff = rvaToOff(dataRva);
        if (dataOff >= 0) return { off: dataOff, size: dataSize };
      }
    }
    return null;
  }

  const leaf = walk(typeDir, 1);
  if (!leaf) return null;

  // VS_FIXEDFILEINFO 位于 VS_VERSIONINFO 内，签名 0xFEEF04BD
  const sigOff = buf.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), leaf.off);
  let fixed = null;
  if (sigOff >= 0 && sigOff + 16 < leaf.off + leaf.size) {
    const ms = buf.readUInt32LE(sigOff + 8);
    const ls = buf.readUInt32LE(sigOff + 12);
    fixed = `${(ms >>> 16) & 0xffff}.${ms & 0xffff}.${(ls >>> 16) & 0xffff}.${ls & 0xffff}`;
  }
  // FileVersion 字符串（UTF-16LE "10.0.19041.1"）
  const raw = buf.toString('latin1', leaf.off, leaf.off + leaf.size);
  const m = raw.match(/1\x000\x00?\.\x000\x00\.\x001\x009\x00[0-9]\x00[0-9]\x00[0-9]/);
  const strHint = m ? m[0].replace(/\x00/g, '') : null;

  return { fixed, strHint };
}

let versionStr = '';
(function checkVersion() {
  let v = null;
  try {
    v = readVersionFromResource();
  } catch (e) {
    v = null;
  }
  if (v && v.fixed) versionStr = v.fixed;
  else if (v && v.strHint) versionStr = v.strHint;
  else versionStr = '';

  if (!versionStr) {
    report(3, '文件版本接近 10.0.19041.x / 10.0.19045.x', false, '未能从 PE 资源中解析出 VS_VERSIONINFO 版本号');
    return;
  }
  const ok = ACCEPT_VERSION_RE.test(versionStr);
  report(
    3,
    '文件版本接近 10.0.19041.x / 10.0.19045.x',
    ok,
    `FileVersion = ${versionStr}${v && v.strHint && v.strHint !== versionStr ? ` (字符串表: ${v.strHint})` : ''}`
  );
})();

// ---------- 第 4 项：大小区间 ----------
report(
  4,
  '文件大小在 30KB~200KB 之间',
  size >= MIN_SIZE && size <= MAX_SIZE,
  `${size} 字节 (${(size / 1024).toFixed(1)} KB)，允许区间 ${MIN_SIZE}~${MAX_SIZE} 字节` +
    (size < MIN_SIZE ? '\n偏小：极可能是 Compact OS 压缩存根或存根 DLL' : '')
);

// ---------- 第 5 项：数字签名（PowerShell） ----------
(function checkSignature() {
  const name = '数字签名（Get-AuthenticodeSignature）';
  let out = '';
  try {
    out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-AuthenticodeSignature -FilePath '${dllPath.replace(/'/g, "''")}'; ` +
          `"$($s.Status)|$($s.SignerCertificate.Subject)"`,
      ],
      { encoding: 'utf8', timeout: 60000 }
    ).trim();
  } catch (e) {
    report(5, name, null, '无法调用 PowerShell 读取签名（不影响其余校验）');
    return;
  }
  const [status, subject] = out.split('|');
  const isMS = /O=Microsoft Corporation|CN=Microsoft/i.test(subject || '');
  const detail =
    `状态: ${status}\n` +
    `签名者: ${subject ? subject : '(无)'}`;
  if (status === 'Valid' && isMS) {
    report(5, name, true, `${detail}\nsigned=Microsoft`);
  } else if (status === 'Valid') {
    report(5, name, null, `${detail}\nsigned=非 Microsoft（不否决，但需标注）`);
  } else {
    report(5, name, null, `${detail}\nsigned=无/无效（不否决，但需标注）`);
  }
})();

// ---------- 汇总 ----------
const failed = results.filter((r) => r.ok === false);
const warned = results.filter((r) => r.ok === null);
console.log('');
console.log('=== 汇总 ===');
console.log(`通过: ${results.length - failed.length - warned.length} / 5`);
if (warned.length) console.log(`警示（不否决）: ${warned.map((r) => r.no).join(', ')}`);
if (failed.length) console.log(`失败: ${failed.map((r) => r.no).join(', ')} -> 该 DLL 不可用`);
else console.log('结论: 该 DLL 可用于 Windows Magnification API 验证');
if (exportsFound.length) {
  console.log('');
  console.log(`导出符号（共 ${exportsFound.length}）: ${exportsFound.join(', ')}`);
}
console.log('');
process.exit(failed.length === 0 ? 0 : 1);
