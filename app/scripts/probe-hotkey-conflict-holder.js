// E2E 探针 B：热键冲突占用器——先于主进程注册 F1（默认热键，可用 argv 覆盖）占住热键，
// 用于验证主进程注册失败时的可感知反馈（ok=false + a11y:announce 播报路径）。
'use strict';

const { app, globalShortcut } = require('electron');

app.whenReady().then(() => {
  const accel = process.argv[2] || 'F1';
  const ok = globalShortcut.register(accel, () => {
    console.log('[holder] triggered (occupied by me)');
  });
  console.log(`[holder] ${accel} registered ok=${ok}`);
  setInterval(() => {}, 1000); // 保活
});
