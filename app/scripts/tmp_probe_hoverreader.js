// 验证悬停朗读的核心逻辑：文本清理、行选择、静止触发、移动不触发、冷却。
// 这些都是纯逻辑，用注入方式测——不依赖真实鼠标，也不真的朗读。
'use strict';

const { app } = require('electron');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { HoverReader, tidyText } = require('../src/main/hover/hoverReader');

  // ---- A. 中文空格清理 ----
  check('A1', '汉字之间的空格被合回', tidyText('命 令 文 本') === '命令文本', `"${tidyText('命 令 文 本')}"`);
  check('A2', '英文单词间空格保留', tidyText('hello world') === 'hello world', `"${tidyText('hello world')}"`);
  check('A3', '中英混排：英文内部空格保留、汉字间去掉',
    tidyText('用 Electron 做 桌面 应用') === '用 Electron 做桌面应用', `"${tidyText('用 Electron 做 桌面 应用')}"`);
  check('A4', '首尾空白清理', tidyText('  测试  ') === '测试', `"${tidyText('  测试  ')}"`);

  // ---- B. 行选择与合并（注入假 OCR 结果）----
  const makeOcr = (lines) => ({
    recognize: async () => ({ lines, ms: 100 }),
  });

  const lines = [
    { t: '第 一 行 文 字', y: 20, h: 16 },
    { t: '第 二 行 文 字', y: 40, h: 16 },
    { t: '第 三 行 文 字', y: 60, h: 16 },
    { t: '另 一 段', y: 200, h: 16 },
  ];

  // 让 region 固定为 (0,0)，便于把屏幕坐标直接当相对坐标
  const reader = new HoverReader({
    ocr: makeOcr(lines),
    onText: (t, meta) => { captured.push({ t, meta }); },
    config: { regionW: 900, regionH: 360 },
  });
  const captured = [];
  reader._cursorPhysical = () => ({ x: 450, y: 30, sf: 1 }); // 垂直落在第一行（y=20..36）

  const origMax = global.__HOOK;
  void origMax;

  // 直接调用 _scan，绕过轮询
  reader._busyScanning = false;
  await reader._scan({ x: 450, y: 30, sf: 1 });
  const hit1 = captured[0];
  check('B1', '指针落在第一行时读到该行起的内容', !!hit1 && hit1.t.indexOf('第一行') === 0, hit1 ? hit1.t : '(无)');
  check('B2', '相邻行被合并（同一段换行）', !!hit1 && hit1.t.indexOf('第二行') > 0, hit1 ? hit1.t : '(无)');
  check('B3', '段间距过大时不再合并', !!hit1 && hit1.t.indexOf('另一段') < 0, hit1 ? hit1.t : '(无)');

  // 指针落在第四行（y=200..216），应只读该段
  captured.length = 0;
  await reader._scan({ x: 450, y: 520, sf: 1 }); // rel = 520 - (520-180) = 180? 用固定 region 反推
  // region 的 y = pos.y - 180 = 340，rel = 520-340 = 180，落在 200..216 之间偏上 20px 内 → 命中最近行
  check('B4', '指针远离文字时不误读（超过 24px 容差）', captured.length === 0, captured.length ? captured[0].t : '(静默，正确)');

  // ---- C. 静止触发 ----
  const fired = [];
  const r2 = new HoverReader({
    ocr: makeOcr([{ t: '触 发 成 功', y: 170, h: 20 }]),
    onText: (t) => fired.push(t),
    config: { hoverDelayMs: 200, pollMs: 40, regionW: 400, regionH: 360 },
  });
  r2._cursorPhysical = () => ({ x: 960, y: 540, sf: 1 });
  r2.start();
  await sleep(600);
  r2.stop();
  check('C1', '指针静止超过阈值后触发', fired.length >= 1, `触发 ${fired.length} 次 "${fired[0] || ''}"`);

  // ---- D. 移动不触发 ----
  const fired2 = [];
  const r3 = new HoverReader({
    ocr: makeOcr([{ t: '不 该 触 发', y: 170, h: 20 }]),
    onText: (t) => fired2.push(t),
    config: { hoverDelayMs: 200, pollMs: 40, regionW: 400, regionH: 360 },
  });
  let px = 100;
  r3._cursorPhysical = () => ({ x: px, y: 540, sf: 1 });
  r3.start();
  for (let i = 0; i < 12; i += 1) {
    await sleep(40);
    px += 30; // 持续移动
  }
  r3.stop();
  check('D1', '指针持续移动时不触发', fired2.length === 0, `触发 ${fired2.length} 次`);

  // ---- E. 冷却与同位置 ----
  const fired3 = [];
  const r4 = new HoverReader({
    ocr: makeOcr([{ t: '冷 却 测 试', y: 170, h: 20 }]),
    onText: (t) => fired3.push(t),
    config: { hoverDelayMs: 100, pollMs: 30, cooldownMs: 800, samePosPx: 9999, regionW: 400, regionH: 360 },
  });
  r4._cursorPhysical = () => ({ x: 500, y: 500, sf: 1 });
  r4.start();
  await sleep(1200);
  r4.stop();
  check('E1', '原地长时间停留只读一次（同位置不重复）', fired3.length === 1, `触发 ${fired3.length} 次`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
