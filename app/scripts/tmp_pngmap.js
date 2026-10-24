// 用 Node 内置 zlib 解码 PNG，输出字符画，用于核对截图真实内容
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(file) {
  const buf = fs.readFileSync(file);
  let off = 8; // skip signature
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 0xff;
      else if (ft === 2) v = (v + b) & 0xff;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

const file = process.argv[2];
const cols = parseInt(process.argv[3] || '96', 10);
const rowsN = parseInt(process.argv[4] || '48', 10);
const { w, h, bpp, data } = decodePNG(file);
const lines = [];
for (let ry = 0; ry < rowsN; ry++) {
  let line = '';
  for (let rx = 0; rx < cols; rx++) {
    let r = 0, g = 0, b = 0, n = 0;
    const x0 = Math.floor((rx * w) / cols), x1 = Math.floor(((rx + 1) * w) / cols);
    const y0 = Math.floor((ry * h) / rowsN), y1 = Math.floor(((ry + 1) * h) / rowsN);
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = y * w * bpp + x * bpp;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    r /= n; g /= n; b /= n;
    const lum = (r + g + b) / 3;
    // 黄色检测（十字线/描边）：R,G 高 B 低
    const yellow = r > 150 && g > 120 && b < r * 0.6;
    if (yellow) line += 'Y';
    else if (lum < 16) line += '.';
    else if (lum < 64) line += ':';
    else if (lum < 128) line += '*';
    else if (lum < 200) line += 'O';
    else line += '#';
  }
  lines.push(line);
}
console.log(`${file} (${w}x${h})  .=黑 :=暗 *=中 O=亮 #=白 Y=黄`);
console.log(lines.join('\n'));
