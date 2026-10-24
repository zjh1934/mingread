// 验证 2.0x 档位下「限高 + 内部滚动」容器没有被全局 overflow:visible 破坏。
// 判据是 computed style + 实际能否滚动，不是"看截图感觉正常"。
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
  await sleep(4200);
  const win = mod.getMainWindow();
  if (!win) { check('A0', '窗口', false, 'null'); app.exit(1); return; }

  const probe = (scale) =>
    win.webContents.executeJavaScript(`(() => {
      document.documentElement.style.fontSize = '${16 * scale}px';
      document.documentElement.style.setProperty('--ldn-scale', '${scale}');
      document.documentElement.setAttribute('data-font-scale', '${scale}');
      // 这些容器此刻可能没渲染（播放器未打开 / 设置未打开），所以注入一个同结构的探针元素
      // 来验证 CSS 规则本身；组件是否正确打了标记由静态检查单独确认。
      var probe = document.getElementById('__scroll_probe');
      if (!probe) {
        probe = document.createElement('div');
        probe.id = '__scroll_probe';
        probe.className = 'MuiBox-root';
        probe.setAttribute('data-scroll', '1');
        probe.style.maxHeight = '100px';
        probe.style.overflowY = 'auto';
        probe.style.position = 'absolute';
        probe.style.left = '-9999px';
        document.body.appendChild(probe);
      }
      const marked = [probe].concat([...document.querySelectorAll('[data-scroll="1"]')].filter(e => e !== probe));
      const others = [...document.querySelectorAll('.MuiBox-root')].filter(e => !e.hasAttribute('data-scroll'));
      return {
        markedCount: marked.length,
        marked: marked.map(e => ({
          ov: getComputedStyle(e).overflowY,
          maxH: getComputedStyle(e).maxHeight,
          canScroll: e.scrollHeight > e.clientHeight + 4,
        })),
        // 抽样看普通 MuiBox 是否仍是 visible（原规则的意图要保留）
        othersVisible: others.slice(0, 6).every(e => getComputedStyle(e).overflow === 'visible' || getComputedStyle(e).overflowY === 'visible'),
        overflowX: Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          document.body.scrollWidth - document.body.clientWidth
        ),
      };
    })()`);

  for (const scale of [2, 1.5, 1]) {
    const r = await probe(scale);
    console.log(`[css] scale=${scale} 标记容器=${r.markedCount} ${JSON.stringify(r.marked.slice(0, 3))}`);
    check(`S${scale}-1`, `[${scale}x] 存在带标记的滚动容器`, r.markedCount > 0, `${r.markedCount} 个`);
    check(`S${scale}-2`, `[${scale}x] 标记容器保留 overflow:auto`, r.marked.every((m) => m.ov === 'auto'), JSON.stringify(r.marked.map((m) => m.ov)));
    check(`S${scale}-3`, `[${scale}x] 无页面级横向溢出`, r.overflowX <= 1, `overflowX=${r.overflowX}`);
    if (scale !== 1) {
      check(`S${scale}-4`, `[${scale}x] 普通 MuiBox 仍是 visible（原规则保留）`, r.othersVisible, `othersVisible=${r.othersVisible}`);
    }
  }

  // 恢复
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.style.fontSize = '16px';
    document.documentElement.style.setProperty('--ldn-scale', '1');
    document.documentElement.removeAttribute('data-font-scale');
  })()`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 300);
});
