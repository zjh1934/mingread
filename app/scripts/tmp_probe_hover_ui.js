// 截「悬停模式」下的首屏：需要先点一下「鼠标停住就读」，否则看不到详细度那一行。
// 同时验证切换后详细度出现、热键模式的说明消失。
'use strict';

const fs = require('fs');
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

  const info = async () => win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="朗读方式"]');
    if (!sec) return { found: false };
    const radios = [...sec.querySelectorAll('[role=radio]')].map(r => ({
      label: r.innerText.replace(/\\s+/g, ' ').trim(),
      checked: r.getAttribute('aria-checked') === 'true',
    }));
    return { found: true, radios, text: sec.innerText.replace(/\\s+/g, ' ').trim() };
  })()`);

  const before = await info();
  check('A1', '切换器存在（热键模式）', before.found, before.found ? `选项=${before.radios.length}` : '未找到');
  check('A2', '默认选中热键', !!(before.radios || []).some((r) => r.checked && r.label.indexOf('选中后按热键') >= 0), JSON.stringify((before.radios || []).map((r) => r.label + '=' + r.checked)));

  // 点「鼠标停住就读」
  await win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="朗读方式"]');
    const btn = [...sec.querySelectorAll('[role=radio]')].find(r => r.innerText.indexOf('鼠标停住就读') >= 0);
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(1800); // 等 IPC + OCR 预热开始

  const after = await info();
  const detailRadios = (after.radios || []).filter((r) => ['少', '中', '多'].some((x) => r.label.startsWith(x)));
  check('A3', '切换后出现「读多少」三档', detailRadios.length === 3, detailRadios.map((r) => r.label).join(' | '));
  check('A4', '默认详细度是「中·一段」', detailRadios.some((r) => r.label.indexOf('中') === 0 && r.checked), JSON.stringify(detailRadios.map((r) => r.checked)));
  check('A5', '悬停态提示文案已更新', /停住约 0\.6 秒/.test(after.text), (after.text || '').slice(0, 60));

  // 切回热键，避免把用户设置留在悬停
  await win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="朗读方式"]');
    const btn = [...sec.querySelectorAll('[role=radio]')].find(r => r.innerText.indexOf('选中后按热键') >= 0);
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(600);

  // 再切回悬停并截图（要展示详细度那一行）
  await win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="朗读方式"]');
    const btn = [...sec.querySelectorAll('[role=radio]')].find(r => r.innerText.indexOf('鼠标停住就读') >= 0);
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(1500);

  const out = path.join(__dirname, '..', 'dist', 'probe', 'hover-mode.png');
  const img = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('[shot] ' + out);

  // 收尾：切回热键（用户默认习惯）
  await win.webContents.executeJavaScript(`(() => {
    const sec = document.querySelector('section[aria-label="朗读方式"]');
    const btn = [...sec.querySelectorAll('[role=radio]')].find(r => r.innerText.indexOf('选中后按热键') >= 0);
    if (btn) btn.click();
    return true;
  })()`);
  await sleep(500);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 300);
});
