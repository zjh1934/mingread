// 验证常驻 OCR 宿主：启动耗时、稳态延迟、连续调用稳定性、退出干净。
// 判定标准：稳态单次 ≤ 300ms（悬停朗读要在这个量级才不会让人觉得卡）。
'use strict';

const { OcrHost } = require('../src/main/hover/ocrHost');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}

(async () => {
  const host = new OcrHost();

  const t0 = Date.now();
  let info;
  try {
    info = await host.start();
  } catch (e) {
    check('A1', '宿主启动', false, e.message);
    process.exit(1);
  }
  const bootMs = Date.now() - t0;
  check('A1', '宿主启动成功', !!info, `lang=${info.lang} 启动=${bootMs}ms`);

  // 屏幕中心 900x360（与探针同一区域，便于对照）
  const region = { x: 510, y: 360, w: 900, h: 360 };

  const timings = [];
  let lastLines = 0;
  for (let i = 0; i < 4; i += 1) {
    const s = Date.now();
    try {
      const r = await host.recognize(region);
      const ms = Date.now() - s;
      timings.push(ms);
      lastLines = r.lines.length;
      console.log(`[host] 第${i + 1}次: ${ms}ms 行数=${r.lines.length} 内部=${r.ms}ms`);
      if (i === 0) {
        r.lines.slice(0, 3).forEach((l) => console.log(`[host]   y=${l.y} h=${l.h} "${String(l.t).slice(0, 40)}"`));
      }
    } catch (e) {
      check(`B${i + 1}`, '识别调用', false, e.message);
    }
  }

  check('B1', '至少识别出内容', lastLines > 0, `行数=${lastLines}`);
  const warm = timings.slice(1);
  const avg = warm.length ? Math.round(warm.reduce((a, b) => a + b, 0) / warm.length) : -1;
  const max = warm.length ? Math.max(...warm) : -1;
  check('B2', '稳态单次 ≤ 300ms', avg > 0 && avg <= 300, `平均=${avg}ms 最慢=${max}ms`);

  // 空区域不应崩
  try {
    const r = await host.recognize({ x: 0, y: 0, w: 120, h: 60 });
    check('C1', '小区域不崩', Array.isArray(r.lines), `行数=${r.lines.length}`);
  } catch (e) {
    check('C1', '小区域不崩', false, e.message);
  }

  host.dispose();
  await new Promise((r) => setTimeout(r, 400));
  check('D1', 'dispose 后进程已退出', !host._proc, `proc=${host._proc ? 'alive' : 'null'}`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
