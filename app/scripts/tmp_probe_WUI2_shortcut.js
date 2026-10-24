// W-UI2 自检探针：快捷键速查卡在 1.0x / 2.0x 下的收起态 + 展开态截图与 DOM 断言。
// 用法：electron scripts/tmp_probe_WUI2_shortcut.js（Windows 需先 unset ELECTRON_RUN_AS_NODE）
// 产物：deliverables/qa-wui2-shortcut-{1x,2x}-{collapsed,expanded}.png + scripts/tmp_probe_WUI2_shortcut.txt
//
// 为什么要自己起窗口：主进程的 --capture 只能延迟截图，无法「点一下再截」，
// 也没有滚动能力（2.0x 下速查卡在首屏之外）。这里直接载入 dist 产物，
// 用 executeJavaScript 点展开、滚动到卡片，再 capturePage —— 验证的仍是构建产物。
'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const APP_DIR = path.join(__dirname, '..');
const OUT_DIR = path.join(APP_DIR, '..', 'deliverables');
const LOG_PATH = path.join(__dirname, 'tmp_probe_WUI2_shortcut.txt');
const LOG = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(LOG_PATH, LOG.join('\n') + '\n', 'utf8');
}

// 主进程侧假系统设置：默认 = 产品默认；最后一轮改成 Ctrl+Alt+R 验证「热键从 store 读」
let sys = { hotkey: 'F1', clipboardAuto: true };
const a11y = [];
ipcMain.handle('probe:systemSettings', () => ({ ...sys }));
ipcMain.on('probe:a11y', (_e, p) => a11y.push(p));

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    backgroundColor: '#f5f6fa',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'tmp_probe_WUI2_preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) log(`[console:${level}] ${message}`);
  });

  await win.loadFile(path.join(APP_DIR, 'dist', 'renderer', 'index.html'));
  win.show();
  win.focus();
  await wait(2500);

  const CARD = 'section[aria-label="快捷键速查"]';

  async function setScale(scale) {
    await win.webContents.executeJavaScript(
      `document.documentElement.style.fontSize='${16 * scale}px';` +
        `document.documentElement.style.setProperty('--ldn-scale','${scale}');`
    );
    await wait(700);
  }

  async function scrollToCard() {
    const r = await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(CARD)}); if (!el) return 'missing';
        el.scrollIntoView({ block: 'start' });
        const b = el.getBoundingClientRect();
        return JSON.stringify({ top: Math.round(b.top), height: Math.round(b.height) }); })()`
    );
    await wait(350);
    return r;
  }

  async function shot(name) {
    // 首帧偶尔还没合成（capturePage 返回 0x0 空图），重试几次再落盘
    let img = await win.webContents.capturePage();
    for (let i = 0; i < 4 && img.getSize().width === 0; i++) {
      await wait(500);
      img = await win.webContents.capturePage();
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name);
    fs.writeFileSync(p, img.toPNG());
    const size = img.getSize();
    log(`captured ${name} ${size.width}x${size.height} ${fs.statSync(p).size}B`);
  }

  // 探针：结构 + 尺寸 + 溢出 + 实际计算样式（证明 fs/su 生效、无横向溢出）
  const probe = `(() => {
    const card = document.querySelector(${JSON.stringify(CARD)});
    if (!card) return JSON.stringify({ card: 'MISSING' });
    const btn = card.querySelector('button');
    const panel = document.getElementById('shortcut-guide-panel');
    const table = card.querySelector('table');
    const rows = table ? table.querySelectorAll('tbody tr') : [];
    const cells = table ? table.querySelectorAll('th, td') : [];
    const overflowCells = [];
    cells.forEach((c) => { if (c.scrollWidth > c.clientWidth + 1) overflowCells.push((c.textContent || '').slice(0, 12)); });
    const cs = getComputedStyle(card);
    const label = card.querySelector('kbd') || card.querySelector('thead th');
    const b = card.getBoundingClientRect();
    return JSON.stringify({
      ariaExpanded: btn ? btn.getAttribute('aria-expanded') : 'no-button',
      ariaControls: btn ? btn.getAttribute('aria-controls') : 'none',
      ariaLabel: btn ? btn.getAttribute('aria-label') : 'none',
      panel: panel ? 'present' : 'absent',
      rowCount: rows.length,
      firstHotkey: (card.querySelector('kbd') || {}).textContent || 'none',
      rowLabels: [].map.call(rows, (r) => { const t = r.querySelector('td div'); return t ? t.textContent : ''; }),
      clipboardNote: (() => { const last = rows[rows.length - 1]; if (!last) return ''; const d = last.querySelectorAll('td div'); return d.length > 1 ? d[1].textContent : ''; })(),
      fontPx: label ? getComputedStyle(label).fontSize : 'n/a',
      cardHeight: Math.round(b.height),
      cardWidth: Math.round(b.width),
      radius: cs.borderTopLeftRadius,
      borderColor: cs.borderTopColor,
      bg: cs.backgroundColor,
      overflowCells,
      docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardOverflowX: card.scrollWidth - card.clientWidth,
      panelOverflowX: panel ? panel.scrollWidth - panel.clientWidth : 0,
      window: window.innerWidth + 'x' + window.innerHeight,
    });
  })()`;

  const p = (s) => win.webContents.executeJavaScript(s);
  const click = () =>
    p(`(() => { const b = document.querySelector(${JSON.stringify(CARD)} + ' button'); if (!b) return false; b.click(); return true; })()`);

  try {
    // ---------- 1.0x ----------
    await setScale(1);
    log('--- 1.0x ---');
    log('scroll: ' + (await scrollToCard()));
    await shot('qa-wui2-shortcut-1x-collapsed.png');
    log('collapsed: ' + (await p(probe)));

    a11y.length = 0;
    log('click expand: ' + (await click()));
    await wait(500);
    await scrollToCard();
    await shot('qa-wui2-shortcut-1x-expanded.png');
    log('expanded: ' + (await p(probe)));
    log('a11y after expand: ' + JSON.stringify(a11y));
    log('collapsed-height(expanded): ' + (await p(`(() => { const c=document.querySelector(${JSON.stringify(CARD)}); return Math.round(c.getBoundingClientRect().height); })()`)));

    // 展开 → 再点一次收起，验证 aria-expanded 回到 false 且表格移出文档
    a11y.length = 0;
    await click();
    await wait(400);
    log('after collapse: ' + (await p(`(() => { const c=document.querySelector(${JSON.stringify(CARD)}); const b=c.querySelector('button'); return JSON.stringify({ ariaExpanded: b.getAttribute('aria-expanded'), table: !!c.querySelector('table'), height: Math.round(c.getBoundingClientRect().height) }); })()`)));
    log('a11y after collapse: ' + JSON.stringify(a11y));

    // ---------- 2.0x ----------
    await setScale(2);
    log('--- 2.0x ---');
    log('scroll: ' + (await scrollToCard()));
    await shot('qa-wui2-shortcut-2x-collapsed.png');
    log('collapsed: ' + (await p(probe)));
    await click();
    await wait(500);
    await scrollToCard();
    await shot('qa-wui2-shortcut-2x-expanded.png');
    log('expanded: ' + (await p(probe)));
    // 2.0x 下滚到卡片底部，确认最后一行（复制即读）不被裁切
    log('scroll-bottom: ' + (await p(`(() => { const c=document.querySelector(${JSON.stringify(CARD)}); const sc=c.closest('div[style*="overflow"], .MuiBox-root'); c.scrollIntoView({ block: 'end' }); return 'ok'; })()`)));
    await wait(300);
    await shot('qa-wui2-shortcut-2x-expanded-bottom.png');

    // ---------- store 驱动：热键改成 Ctrl+Alt+R + 关闭复制即读，重载后应跟着变 ----------
    log('--- store-driven hotkey ---');
    sys = { hotkey: 'Ctrl+Alt+R', clipboardAuto: false };
    await win.webContents.reload();
    await wait(1800);
    await setScale(1);
    await click();
    await wait(400);
    const driven = await p(`(() => {
      const c = document.querySelector(${JSON.stringify(CARD)});
      if (!c) return JSON.stringify({ card: 'MISSING' });
      const keys = [].map.call(c.querySelectorAll('tbody tr:first-of-type kbd'), (k) => k.textContent).join('+');
      const lastRow = c.querySelector('tbody tr:last-of-type td');
      return JSON.stringify({ hotkeyShown: keys, clipboardNote: lastRow ? lastRow.textContent : '' });
    })()`);
    log('store-driven: ' + driven);
  } catch (e) {
    log('FAILED: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
  }
  setTimeout(() => app.exit(0), 300);
});

setTimeout(() => {
  log('TIMEOUT');
  app.exit(1);
}, 90000);
