// 验证「辅助与联系」卡片：1.0x / 2.0x 两档都不破版，且两个入口都在。
// 判定依据是 DOM 实测（scrollWidth vs clientWidth + 元素包围盒），不是看图说话。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');

// 必须强制走打包路径：dev 分支会 loadURL('http://localhost:5173')，
// 探针环境没有 dev server，拿到的是空白页（这个坑在 boot_shot 探针已经踩过一次）。
process.env.VITE_DEV_SERVER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'index.html')
).href;

const mod = require('../src/main/index.js');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}${detail !== undefined ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(4200);
  const win = mod.getMainWindow();
  if (!win) { console.log('FAIL  窗口未创建'); app.exit(1); return; }

  const setScale = async (s) => {
    await win.webContents.executeJavaScript(
      `document.documentElement.style.fontSize='${16 * s}px';document.documentElement.style.setProperty('--ldn-scale','${s}');`
    );
    await sleep(700);
  };

  const probe = async (label) => {
    return win.webContents.executeJavaScript(`(() => {
      const sec = document.querySelector('section[aria-label="辅助与联系"]');
      const scroller = document.querySelector('section[aria-label="辅助与联系"]')
        ? [...document.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 8 && getComputedStyle(d).overflowY !== 'visible')
        : null;
      const docW = document.documentElement.clientWidth;
      const overflowX = Math.max(
        document.documentElement.scrollWidth - docW,
        document.body.scrollWidth - docW
      );
      const btn = sec ? sec.querySelector('button') : null;
      const img = sec ? sec.querySelector('img') : null;
      const r = sec ? sec.getBoundingClientRect() : null;
      const ir = img ? img.getBoundingClientRect() : null;
      return {
        found: !!sec,
        overflowX,
        docW,
        cardW: r ? Math.round(r.width) : 0,
        btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
        btnText: btn ? btn.innerText.trim() : '',
        imgW: ir ? Math.round(ir.width) : 0,
        imgH: ir ? Math.round(ir.height) : 0,
        imgAlt: img ? img.getAttribute('alt') : '',
        cursorLine: sec ? (sec.querySelector('p') ? sec.querySelector('p').innerText.slice(0, 60) : '') : '',
      };
    })()`);
  };

  for (const scale of [1, 2]) {
    await setScale(scale);
    const r = await probe(`scale=${scale}`);
    console.log(`[card] scale=${scale} ${JSON.stringify(r)}`);
    check(`S${scale}-1`, `[${scale}x] 卡片存在`, r.found);
    check(`S${scale}-2`, `[${scale}x] 无页面级横向溢出`, r.overflowX <= 1, `overflowX=${r.overflowX} docW=${r.docW}`);
    check(`S${scale}-3`, `[${scale}x] 按钮高度 ≥44`, r.btnH >= 44, `${r.btnH}px "${r.btnText}"`);
    check(`S${scale}-4`, `[${scale}x] 二维码正方形且尺寸稳定`, r.imgW > 0 && Math.abs(r.imgW - r.imgH) <= 2, `${r.imgW}x${r.imgH}`);
    check(`S${scale}-5`, `[${scale}x] 二维码有可读 alt`, (r.imgAlt || '').length >= 8, r.imgAlt ? r.imgAlt.slice(0, 24) : '(空)');
  }

  // 滚动到卡片并截图（2.0x 下它不在首屏）
  await setScale(2);
  await win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="辅助与联系"]');
    if (sec) sec.scrollIntoView({ block: 'center' });
  })()`);
  await sleep(900);
  const out = path.join(__dirname, '..', 'dist', 'probe', 'supportcard-2x.png');
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('[card] shot -> ' + out);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
