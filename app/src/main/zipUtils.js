// 最小纯 Node ZIP 解压器（无第三方依赖，Win7~Win11 行为一致）。
// 用途：解压 NVSA release zip；把 MSIX（OPC/ZIP 格式）当 ZIP 解压出 Narrator 语音模型。
// 支持：stored(0) / deflate(8)、Zip64 EOCD、UTF-8 文件名；目录条目自动创建。
//
// 安全（这是唯一会「按压缩包内容决定写入路径」的代码，必须当成不可信输入处理）：
//   · 防 Zip Slip：条目名先规范化，再断言落点在 destDir 内（拒绝 .. / 绝对路径 / 盘符路径 / NUL）
//   · 拒绝符号链接条目（unix mode S_IFLNK）：避免解压后写出可指向任意位置的链接
//   · 解压只在调用方给定的空目录/新建目录内进行；不做删除操作（清理由调用方负责）
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LFH = 0x04034b50;

function findEOCD(buf) {
  // EOCD 至少 22 字节；注释最长 65535，故从尾部 22+65535 范围内向前找
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 解析中央目录，返回条目列表 */
function readCentralDirectory(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('ZIP 损坏：未找到中央目录结尾（EOCD）');
  let cdOffset = buf.readUInt32LE(eocd + 16);
  let cdCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);

  // Zip64：EOCD 中被截断的字段为 0xFFFFFFFF/0xFFFF 时，转 Zip64 EOCD 记录
  const locatorPos = eocd - 20;
  if (cdOffset === 0xffffffff || cdCount === 0xffff || cdSize === 0xffffffff) {
    if (locatorPos >= 0 && buf.readUInt32LE(locatorPos) === SIG_EOCD64_LOCATOR) {
      const eocd64Pos = Number(buf.readBigUInt64LE(locatorPos + 8));
      if (eocd64Pos >= 0 && eocd64Pos + 56 <= buf.length && buf.readUInt32LE(eocd64Pos) === SIG_EOCD64) {
        cdCount = Number(buf.readBigUInt64LE(eocd64Pos + 32));
        cdOffset = Number(buf.readBigUInt64LE(eocd64Pos + 48));
      }
    }
  }
  if (cdOffset < 0 || cdOffset > buf.length) throw new Error('ZIP 损坏：中央目录偏移越界');

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) {
      throw new Error(`ZIP 损坏：中央目录第 ${i + 1} 条记录无效`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    // 统一成 / 分隔（Windows 工具可能写反斜杠；反斜杠会让 path.resolve 在 POSIX 语义下漏检）
    const name = (flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')).replace(/\\/g, '/');

    // 符号链接条目一律拒绝：解压器不创建链接，避免链接穿越
    const unixMode = (externalAttr >>> 16) & 0xffff;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error(`ZIP 含有符号链接条目，已拒绝解压：${name}`);
    }

    let entry = { name, method, compSize, uncompSize, localOffset, isDir: /\/$/.test(name) };
    // Zip64 extra 字段（0x0001）覆盖大尺寸字段
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      let q = 0;
      while (q + 4 <= extra.length) {
        const hid = extra.readUInt16LE(q);
        const hsz = extra.readUInt16LE(q + 2);
        if (hid === 0x0001) {
          let r = q + 4;
          if (uncompSize === 0xffffffff && r + 8 <= extra.length) {
            entry.uncompSize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (compSize === 0xffffffff && r + 8 <= extra.length) {
            entry.compSize = Number(extra.readBigUInt64LE(r));
            r += 8;
          }
          if (localOffset === 0xffffffff && r + 8 <= extra.length) {
            entry.localOffset = Number(extra.readBigUInt64LE(r));
          }
          break;
        }
        q += 4 + hsz;
      }
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 列出 zip 内条目（不解压） */
function listEntries(zipPath) {
  return readCentralDirectory(fs.readFileSync(zipPath));
}

/**
 * 防 Zip Slip：断言条目名解析后的绝对路径仍在 destDir 内。
 * 任何可疑条目都抛错（宁可整体失败，也不写一个越界文件）。
 * @param {string} destDir
 * @param {string} entryName
 * @returns {string} 规范化后的绝对目标路径
 */
function safeJoin(destDir, entryName) {
  const name = String(entryName == null ? '' : entryName);
  if (!name) throw new Error('ZIP 含有空文件名条目');
  if (name.indexOf('\0') >= 0) throw new Error('ZIP 条目名含 NUL 字符，已拒绝');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`ZIP 含有绝对路径条目：${name}`);
  }

  const root = path.resolve(destDir);
  const target = path.resolve(root, name);
  const rel = path.relative(root, target);
  // rel 为空 = 指到 destDir 自身；以 .. 开头 = 越界；isAbsolute(rel) = 跨盘符
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`ZIP 含有非法路径条目（越界）：${name}`);
  }
  // 二次断言：必须严格以 root + 分隔符 开头
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`ZIP 含有非法路径条目（越界）：${name}`);
  }
  return target;
}

/**
 * 解压整个 zip 到 destDir（同步，大文件也仅持一份 buffer）。
 * @param {string} zipPath
 * @param {string} destDir
 * @param {(done:number, total:number)=>void} [onEntry] 每写完一个条目回调（用于进度）
 * @returns {{files:number, bytes:number}}
 */
function extractAll(zipPath, destDir, onEntry) {
  const buf = fs.readFileSync(zipPath);
  const entries = readCentralDirectory(buf);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });

  // 先整体校验路径，再写盘：一旦发现越界条目，磁盘上不留半成品
  for (const e of entries) safeJoin(root, e.name);

  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    const target = safeJoin(root, e.name);
    if (e.isDir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 本地头：sig(4) ver(2) flags(2) method(2) time(2) date(2) crc(4) csize(4) usize(4) nlen(2) elen(2)
    const lfh = e.localOffset;
    if (lfh + 30 > buf.length || buf.readUInt32LE(lfh) !== SIG_LFH) {
      throw new Error(`ZIP 损坏：条目 ${e.name} 的本地头无效`);
    }
    const nlen = buf.readUInt16LE(lfh + 26);
    const elen = buf.readUInt16LE(lfh + 28);
    const dataStart = lfh + 30 + nlen + elen;
    if (dataStart + e.compSize > buf.length) {
      throw new Error(`ZIP 损坏：条目 ${e.name} 的数据越界`);
    }
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    let out;
    if (e.method === 0) {
      out = Buffer.from(raw);
    } else if (e.method === 8) {
      out = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式（method=${e.method}）：${e.name}`);
    }
    fs.writeFileSync(target, out);
    files += 1;
    bytes += out.length;
    if (onEntry) onEntry(files, entries.length);
  }
  return { files, bytes };
}

module.exports = { listEntries, extractAll, safeJoin };
