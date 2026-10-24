// 验证「对齐 macOS」的三件事：段落聚合、句级切分、详细度三档。
// 用构造的 OCR 行（两段，每段 3 行）注入，检查不同详细度读出来的范围。
'use strict';

const { app } = require('electron');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}

app.whenReady().then(async () => {
  const { HoverReader, tidyText, splitSentences, clusterParagraph } = require('../src/main/hover/hoverReader');

  // ---------- A. 纯函数 ----------
  check('A1', '汉字间空格合并', tidyText('命 令 文 本') === '命令文本', tidyText('命 令 文 本'));
  check('A2', '英文词间空格保留', tidyText('hello world') === 'hello world', tidyText('hello world'));

  const sents = splitSentences('第一句。第二句！第三句？');
  check('A3', '按标点切成 3 句', sents.length === 3, sents.map((s) => s.text).join(' | '));
  check('A4', '句子带回在全文中的位置', sents[1] && sents[1].index > 0, `index=${sents[1] ? sents[1].index : 'n/a'}`);

  // ---------- B. 段落聚合 ----------
  // 第一段：y=20/40/60（行高 16，行距 4）；第二段：y=140 起（与第一段间距 64px > 16*1.0）
  // 注意：截图区域以指针为中心，指针的 relY 恒等于 regionH/2 = 210。
  // 行必须落在 210 附近，否则永远 miss（第一次写测试就把行放在 y=20 一带，全部读空）。
  const lines = [
    { t: '第 一 段 第 一 行 。 第 一 段 第 二 句 。', y: 190, h: 16, x: 100, w: 600 },
    { t: '第 一 段 第 二 行 接 上 去 的 内 容 。', y: 210, h: 16, x: 100, w: 500 },
    { t: '第 一 段 第 三 行 结 尾 。', y: 230, h: 16, x: 100, w: 400 },
    { t: '第 二 段 开 头 第 一 行 。', y: 310, h: 16, x: 100, w: 480 },
    { t: '第 二 段 第 二 行 。', y: 330, h: 16, x: 100, w: 300 },
  ];

  const seg = clusterParagraph(lines, 1);
  check('B1', '指针在第 2 行，聚出的段落只含第一段 3 行', seg.length === 3, `行数=${seg.length}`);
  check('B2', '段落不含第二段', !seg.some((l) => String(l.t).indexOf('第 二 段') === 0), seg.map((l) => l.t.slice(0, 6)).join(' / '));

  // ---------- C. 详细度三档 ----------
  const makeReader = (detail) => {
    const got = [];
    const r = new HoverReader({
      ocr: { recognize: async () => ({ lines, ms: 50 }) },
      isSelfPoint: () => false,
      onText: (t, meta) => got.push({ t, meta }),
      config: { detail, regionW: 900, regionH: 420 },
    });
    return { r, got };
  };

  // 指针相对坐标：region 起点 = pos.y - 210；要落在第 2 行(y=40..56)，取 relY=48 → pos.y = 258
  const probe = { x: 450, y: 258, sf: 1 };

  const low = makeReader('low');
  await low.r._scan(probe);
  const lowText = low.got[0] ? low.got[0].t : '';
  check('C1', '详细度「少」只读指针所在的那一句', lowText.length > 0 && lowText.length < 40, `"${lowText}"`);

  const mid = makeReader('medium');
  await mid.r._scan(probe);
  const midText = mid.got[0] ? mid.got[0].t : '';
  check('C2', '详细度「中」读完整第一段（3 行合并）', midText.indexOf('第三行') > 0 || midText.indexOf('第三') > 0, `"${midText.slice(0, 50)}"`);
  check('C3', '「中」不含第二段', midText.indexOf('第二段') < 0 || midText.indexOf('第 二 段') < 0, `含第二段=${/第\s*二\s*段/.test(midText)}`);

  const high = makeReader('high');
  await high.r._scan(probe);
  const highText = high.got[0] ? high.got[0].t : '';
  check('C4', '详细度「多」把后续段落也带上', /第\s*二\s*段/.test(highText), `"${highText.slice(0, 60)}"`);

  // ---------- D. 高亮矩形 ----------
  const meta = mid.got[0] ? mid.got[0].meta : null;
  check('D1', '返回高亮矩形（读的是哪一块看得见）', !!(meta && Array.isArray(meta.rects) && meta.rects.length === 3), `rects=${meta ? meta.rects.length : 'n/a'}`);
  check('D2', '矩形是屏幕坐标且宽高为正', !!(meta && meta.rects.every((r) => r.w > 0 && r.h > 0 && r.y > 0)), meta ? JSON.stringify(meta.rects[0]) : '');

  // ---------- E. 超长截断 ----------
  const longLines = [
    { t: '这 是 一 个 很 长 的 段 落 。'.repeat(30), y: 190, h: 16, x: 100, w: 800 },
  ];
  const longR = new HoverReader({
    ocr: { recognize: async () => ({ lines: longLines, ms: 30 }) },
    onText: (t, m) => longR.__got = { t, m },
    config: { detail: 'medium', regionW: 900, regionH: 420 },
  });
  await longR._scan({ x: 450, y: 230, sf: 1 });
  check('E1', '超长文本被截断（不一次读几百字）', !!(longR.__got && longR.__got.t.length <= 210), `长度=${longR.__got ? longR.__got.t.length : 'n/a'}`);
  check('E2', '截断有标记（可提示「还有下文」）', !!(longR.__got && longR.__got.m.truncated === true), `truncated=${longR.__got ? longR.__got.m.truncated : 'n/a'}`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
