// 探针：F1 端到端——真实 app 里注入 F1，验证「钩子收到按键 → 触发朗读链路」是否连通。
//
// 与 tmp_probe_kb_hook.js 的区别：那个只验证「钩子能不能收到被独占的 F1」；
// 这个加载真实入口（src/main/index.js），连同 hotkeyTray 的三层保障、抓取宿主、
// 渲染层提示一起跑，验证用户按 F1 之后**确实有动作**。
//
// 判定依据（控制台日志）：
//   [hotkey] low-level hook took over  → 钩子接管
//   [hotkey] press cue ok=true         → 反馈音发出（按键已被处理）
//   [hotkey] fired -> ... 或 busy      → 走进朗读链路
//   NO_SELECTION 属预期（探针没有真实选区）
//
// 用法（PowerShell 工具，先清 ELECTRON_RUN_AS_NODE）：
//   node node_modules/electron/cli.js scripts/tmp_probe_f1_e2e.js
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 真实入口：会自行 whenReady、建窗、注册热键/钩子、预热抓取宿主
require('../src/main/index.js');

const OUT = path.join(__dirname, '..', 'dist', 'probe', 'f1-e2e.json');
const result = { at: new Date().toISOString(), injected: 0, errors: [] };

function injectF1() {
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uint64 dwExtraInfo)');
    keybd_event(0x70, 0, 0, 0); // F1 down
    setTimeout(() => keybd_event(0x70, 0, 0x0002, 0), 40); // F1 up
    result.injected += 1;
    console.log(`[f1-e2e] injected F1 #${result.injected} at ${Date.now()}`);
  } catch (e) {
    result.errors.push((e && e.message) || String(e));
    console.log('[f1-e2e] inject failed: ' + ((e && e.message) || e));
  }
}

app.whenReady().then(() => {
  // 等 app 完成建窗 + 钩子装上 + 抓取宿主预热，再注入
  setTimeout(injectF1, 6000);
  setTimeout(injectF1, 9000);

  setTimeout(() => {
    result.doneAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    } catch (e) {
      /* noop */
    }
    console.log('[f1-e2e] exit injected=' + result.injected);
    app.exit(0);
  }, 14000);
});
