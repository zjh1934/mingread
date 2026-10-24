// 悬停朗读端到端验证（两段）：
//   A. 服务集成：模式切换、OCR 预热、**本应用窗口内不自读**、切回热键后停止
//   B. 真实链路：裸 HoverReader + 真 OCR + 真鼠标移动 → 确实读到文字
// B 单独做，是因为 A 里的「自窗口排除」会主动跳过窗口内的一切，
// 若用集成实例测链路，永远读不到——两件事必须分开验证。
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');

process.env.VITE_DEV_SERVER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'index.html')
).href;

const mod = require('../src/main/index.js');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const GetCursorPos = user32.func('int GetCursorPos(_Out_ void *lpPoint)');
  const SetCursorPos = user32.func('int SetCursorPos(int X, int Y)');

  const origBuf = Buffer.alloc(8);
  GetCursorPos(origBuf);
  const origX = origBuf.readInt32LE(0);
  const origY = origBuf.readInt32LE(4);
  console.log(`[e2e] 原始鼠标位置 ${origX},${origY}`);

  await sleep(4200);

  // ============ A. 服务集成 ============
  // eslint-disable-next-line global-require
  const hover = require('../src/main/hover');
  check('A1', '切到悬停模式', hover.setMode('hover') === 'hover', 'mode=hover');

  await sleep(3000);
  const st0 = hover.getStats();
  check('A2', 'OCR 引擎已预热', st0.prewarmed === true, `lang=${st0.ocrLang}`);

  const win = mod.getMainWindow();
  if (!win) {
    check('A3', '主窗口存在', false, 'null');
    SetCursorPos(origX, origY);
    app.exit(1);
    return;
  }

  const b = win.getBounds();
  const tX = Math.round(b.x + b.width * 0.5);
  const tY = Math.round(b.y + b.height * 0.5);
  SetCursorPos(Math.max(0, tX - 200), tY);
  await sleep(150);
  SetCursorPos(tX, tY);
  await sleep(2600);

  const stSelf = hover.getStats();
  check(
    'A3',
    '指针停在本应用窗口内时不朗读自己的界面文字',
    !!(stSelf.reader && stSelf.reader.hits === 0),
    `hits=${stSelf.reader ? stSelf.reader.hits : 'n/a'}`
  );

  hover.setMode('hotkey');
  await sleep(300);
  check('A4', '切回热键模式成功', hover.getMode() === 'hotkey', `mode=${hover.getMode()}`);

  // ============ B. 真实链路（裸实例，不受自窗口排除影响）============
  const { OcrHost } = require('../src/main/hover/ocrHost');
  const { HoverReader } = require('../src/main/hover/hoverReader');
  const ocr = new OcrHost();
  const got = [];
  const reader = new HoverReader({
    ocr,
    isSelfPoint: () => false, // 故意关掉，才能在本窗口上取到文字
    onText: (t, meta) => got.push({ t, meta }),
    config: { hoverDelayMs: 400, pollMs: 80 },
  });
  reader.start();

  // 移到窗口内的状态卡（一定有文字）
  SetCursorPos(Math.max(0, tX - 250), tY);
  await sleep(200);
  SetCursorPos(tX, tY);
  await sleep(2600);

  reader.stop();
  const stats = reader.stats;
  console.log(`[e2e] 真实链路统计 ${JSON.stringify(stats)}`);
  check('B1', '真实鼠标悬停触发了取词', stats.hits >= 1, `hits=${stats.hits}`);
  // 注意：这里的 lastMs 是**新实例的第一次**调用，包含 OCR 引擎首次加载（实测 ~1.1s）；
  // 稳态在 tmp_probe_ocrhost.js 里单独测（105ms 左右）。两者不能混为一谈。
  check('B2', '首次取词耗时合理（≤1.5s，含引擎初始化）', stats.lastMs > 0 && stats.lastMs <= 1500, `lastMs=${stats.lastMs}`);
  check('B3', '确实读到了文字（非空）', got.length > 0 && String(got[0].t).length > 0, got.length ? `"${String(got[0].t).slice(0, 30)}"` : '(空)');
  check('B4', '文本已清理（无汉字间空格）', got.length > 0 && !/[\u4e00-\u9fa5] [\u4e00-\u9fa5]/.test(got[0].t), got.length ? got[0].t.slice(0, 24) : '');
  check('B5', '无取词错误', stats.errors === 0, `errors=${stats.errors}`);

  reader.dispose();
  ocr.dispose();

  SetCursorPos(origX, origY);
  console.log('[e2e] 鼠标已归位');
  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 400);
});
