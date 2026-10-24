// E2E 探针 B：热键冲突占用器——先于主进程注册 Ctrl+Alt+R 占住热键，
// 用于验证主进程注册失败时的可感知反馈（ok=false + a11y:announce 播报路径）。
'use strict';

const { app, globalShortcut } = require('electron');

app.whenReady().then(() => {
  const ok = globalShortcut.register('Ctrl+Alt+R', () => {
    console.log('[holder] triggered (occupied by me)');
  });
  console.log(`[holder] Ctrl+Alt+R registered ok=${ok}`);
  setInterval(() => {}, 1000); // 保活
});
