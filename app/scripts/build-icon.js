// 生成应用图标：SVG 设计 → Electron 渲染 → 多尺寸 PNG → 打包 ICO。
//
// 为什么用 Electron 渲染而不是引 sharp/canvas：
// 项目里已经有 Electron，零新依赖；而且能保证渲染结果与 Chromium 一致。
//
// 用法：
//   node node_modules/electron/cli.js scripts/build-icon.js --variant=A --size=256   # 单张预览
//   node node_modules/electron/cli.js scripts/build-icon.js --all                     # 全部变体预览
//   node node_modules/electron/cli.js scripts/build-icon.js --build                   # 出正式 icon.ico/png
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'dist', 'icon');
const RES_DIR = path.join(__dirname, '..', 'resources');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

// ---------------------------------------------------------------------------
// 设计约束（来自用户反馈）
//   上一版是「深蓝底 + 金黄竖条」，用户评价「像流氓软件鲁大师」。
//   所以这一版刻意避开蓝+黄：用产品自身的主色 #6b5bff（theme.js primary），
//   图形只用白，且元素数量压到 4 个以内 —— 16px 任务栏下也要能认出「有文字、在发声」。
// ---------------------------------------------------------------------------

/** 文字行 + 声波弧（主方案）
 *  参数思路：文字块占左 45%、声波占右 35%，中缝 20%；
 *  三行文字用「长-短-中」制造段落感（两行容易被读成减号）；
 *  声波只留两道且保持较高不透明度 —— 三道+透明度递减在 16px 下会糊成灰雾。 */
function variantA() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.9" y2="1">
        <stop offset="0" stop-color="#8577ff"/>
        <stop offset="1" stop-color="#6350f7"/>
      </linearGradient>
    </defs>
    <rect x="4" y="4" width="248" height="248" rx="50" fill="url(#bg)"/>
    <!-- 三行文字：右端刻意参差（96/66/82），小圆角 —— 圆角一大、长度一对齐就会被读成汉堡菜单 -->
    <rect x="40" y="92" width="96" height="16" rx="7" fill="#ffffff"/>
    <rect x="40" y="120" width="66" height="16" rx="7" fill="#ffffff" opacity="0.9"/>
    <rect x="40" y="148" width="82" height="16" rx="7" fill="#ffffff" opacity="0.78"/>
    <!-- 两道声波，紧贴文字右端发出 -->
    <path d="M152 102 A 28 28 0 0 1 152 154" stroke="#ffffff" stroke-width="16" fill="none" stroke-linecap="round"/>
    <path d="M182 80 A 66 66 0 0 1 182 176" stroke="#ffffff" stroke-width="16" fill="none" stroke-linecap="round" opacity="0.55"/>
  `;
}

/** 极简：单行粗文字 + 单道声波（最抗小尺寸） */
function variantB() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7d6fff"/>
        <stop offset="1" stop-color="#5944f0"/>
      </linearGradient>
    </defs>
    <rect x="4" y="4" width="248" height="248" rx="60" fill="url(#bg)"/>
    <rect x="44" y="112" width="96" height="32" rx="16" fill="#ffffff"/>
    <path d="M162 92 A 52 52 0 0 1 162 164" stroke="#ffffff" stroke-width="20" fill="none" stroke-linecap="round"/>
    <path d="M198 68 A 92 92 0 0 1 198 188" stroke="#ffffff" stroke-width="20" fill="none" stroke-linecap="round" opacity="0.55"/>
  `;
}

/** 三条文字行 + 三道光弧（信息更足，小尺寸偏密） */
function variantC() {
  return `
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#7d6fff"/>
        <stop offset="1" stop-color="#5944f0"/>
      </linearGradient>
    </defs>
    <rect x="4" y="4" width="248" height="248" rx="60" fill="url(#bg)"/>
    <rect x="42" y="80" width="74" height="17" rx="8.5" fill="#ffffff"/>
    <rect x="42" y="119" width="52" height="17" rx="8.5" fill="#ffffff" opacity="0.9"/>
    <rect x="42" y="158" width="64" height="17" rx="8.5" fill="#ffffff" opacity="0.76"/>
    <path d="M142 100 A 30 30 0 0 1 142 156" stroke="#ffffff" stroke-width="13" fill="none" stroke-linecap="round"/>
    <path d="M166 82 A 56 56 0 0 1 166 174" stroke="#ffffff" stroke-width="13" fill="none" stroke-linecap="round" opacity="0.7"/>
    <path d="M190 64 A 82 82 0 0 1 190 192" stroke="#ffffff" stroke-width="13" fill="none" stroke-linecap="round" opacity="0.45"/>
  `;
}

const VARIANTS = { A: variantA, B: variantB, C: variantC };

function htmlFor(variant, size) {
  const body = VARIANTS[variant]();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>
    <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">${body}</svg>
  </body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function renderOne(variant, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    resizable: false,
    useContentSize: true,
    webPreferences: { offscreen: false, devTools: false },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlFor(variant, size)));
    win.showInactive(); // 必须真正显示，隐藏窗口 capturePage 会返回 0x0（本项目已踩过）
    await sleep(320);
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    const out = path.join(OUT_DIR, `icon-${variant}-${size}.png`);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(out, png);
    const sz = img.getSize();
    console.log(`[icon] ${variant} ${size} -> ${out} (${png.length}B, ${sz.width}x${sz.height})`);
    return png;
  } finally {
    win.destroy();
  }
}

/** ICO 封装：每个条目内嵌 PNG（Windows Vista+ 支持，免去 BMP 掩码处理） */
function buildIco(pngBySize) {
  const entries = [];
  let offset = 6 + 16 * pngBySize.length;
  const parts = [];
  for (const { size, png } of pngBySize) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // 调色板数
    e.writeUInt8(0, 3); // 保留
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    parts.push(png);
    offset += png.length;
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(pngBySize.length, 4);
  return Buffer.concat([header, ...entries, ...parts]);
}

app.whenReady().then(async () => {
  const args = process.argv;
  const all = args.includes('--all');
  const build = args.includes('--build');
  const vArg = args.find((a) => a.startsWith('--variant='));
  const sArg = args.find((a) => a.startsWith('--size='));

  try {
    if (all) {
      // 注意：实测同一个 Electron 进程里第二次 new BrowserWindow 会 ERR_FAILED，
      // 所以一次只渲染一个变体（由外部循环调用），别在这里 for 循环变体。
      const v = vArg ? vArg.split('=')[1] : 'A';
      const png = await renderOne(v, 256);
      const img = nativeImage.createFromBuffer(png);
      for (const s of [48, 16]) {
        const small = img.resize({ width: s, height: s, quality: 'best' });
        const out = path.join(OUT_DIR, `icon-${v}-${s}.png`);
        fs.writeFileSync(out, small.toPNG());
        console.log(`[icon] ${v} ${s} -> ${out} (${small.toPNG().length}B)`);
      }
    } else if (build) {
      const v = vArg ? vArg.split('=')[1] : 'A';
      const basePng = await renderOne(v, 256);
      const baseImg = nativeImage.createFromBuffer(basePng);
      const pngBySize = [];
      for (const s of ICO_SIZES) {
        const png =
          s === 256
            ? basePng
            : baseImg.resize({ width: s, height: s, quality: 'best' }).toPNG();
        fs.writeFileSync(path.join(OUT_DIR, `icon-${v}-${s}.png`), png);
        pngBySize.push({ size: s, png });
      }
      const ico = buildIco(pngBySize);
      fs.writeFileSync(path.join(RES_DIR, 'icon.ico'), ico);
      // 应用内/窗口用 256 PNG
      fs.copyFileSync(path.join(OUT_DIR, `icon-${v}-256.png`), path.join(RES_DIR, 'icon.png'));
      console.log(`[icon] wrote icon.ico (${ico.length}B, ${ICO_SIZES.length} sizes) + icon.png`);
    } else {
      const v = vArg ? vArg.split('=')[1] : 'A';
      const s = sArg ? Number(sArg.split('=')[1]) : 256;
      await renderOne(v, s);
    }
  } catch (e) {
    console.error('[icon] failed:', e && e.message);
    app.exit(1);
    return;
  }
  app.exit(0);
});
