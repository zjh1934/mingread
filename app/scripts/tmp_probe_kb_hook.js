// 探针：验证 WH_KEYBOARD_LL 低级键盘钩子能否在 F1 被其他程序独占时仍收到按键。
//
// 场景还原：本机 F1 被网吧管理客户端占用 → globalShortcut.register('F1') 返回 false。
// 此时装钩子，用 keybd_event 注入真实系统输入（走完整输入分发链），验证钩子命中。
//
// 用法（PowerShell 工具，先清 ELECTRON_RUN_AS_NODE）：
//   $env:ELECTRON_RUN_AS_NODE = $null
//   node node_modules/electron/cli.js scripts/tmp_probe_kb_hook.js
// 结果写 dist/probe/kb-hook.json
'use strict';

const fs = require('fs');
const path = require('path');
const { app, globalShortcut } = require('electron');
const hook = require('../src/main/platform/keyboardHook');

const OUT = path.join(__dirname, '..', 'dist', 'probe', 'kb-hook.json');
const VK_F1 = 0x70;

function injectF1(koffi) {
  const user32 = koffi.load('user32.dll');
  // keybd_event(bVk, bScan, dwFlags, dwExtraInfo)；KEYEVENTF_KEYUP = 0x0002
  const keybd_event = user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uint64 dwExtraInfo)');
  keybd_event(VK_F1, 0, 0, 0);
  setTimeout(() => keybd_event(VK_F1, 0, 0x0002, 0), 40);
}

app.whenReady().then(() => {
  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    hookSupported: hook.isSupported(),
    hookError: hook.currentError(),
    globalShortcutF1: null,
    hookStart: null,
    injected: 0,
    hits: [],
    hookState: null,
    verdict: null,
  };

  // 1) 先看 globalShortcut 能不能抢到 F1（预期失败：被外部程序占用）
  try {
    result.globalShortcutF1 = !!globalShortcut.register('F1', () => {
      result.hits.push({ via: 'globalShortcut', at: Date.now() });
    });
  } catch (e) {
    result.globalShortcutF1 = 'threw: ' + ((e && e.message) || e);
  }

  // 2) 装钩子
  result.hookStart = hook.start((e) => {
    result.hits.push({ via: 'hook', vkCode: e.vkCode, at: e.at });
  });

  // 3) 注入 3 次 F1（间隔 600ms，越过 250ms 去重窗口）
  let koffi;
  try {
    // eslint-disable-next-line global-require
    koffi = require('koffi');
  } catch (e) {
    result.injectError = (e && e.message) || String(e);
  }

  const fire = () => {
    if (!koffi) return;
    try {
      injectF1(koffi);
      result.injected += 1;
    } catch (e) {
      result.injectError = (e && e.message) || String(e);
    }
  };

  setTimeout(fire, 400);
  setTimeout(fire, 1000);
  setTimeout(fire, 1600);

  // 4) 收尾判定
  setTimeout(() => {
    result.hookState = hook.getState();
    const hookHits = result.hits.filter((h) => h.via === 'hook').length;
    result.hookHits = hookHits;
    // 判定：钩子装上 且 3 次注入全部命中（允许自动重复导致的额外命中）
    result.verdict =
      result.hookStart === true && hookHits >= 3
        ? 'PASS'
        : result.hookStart === true && hookHits > 0
          ? 'PARTIAL'
          : 'FAIL';
    try {
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    } catch (e) {
      /* noop */
    }
    try {
      globalShortcut.unregisterAll();
    } catch (e) {
      /* noop */
    }
    hook.stop();
    app.exit(result.verdict === 'FAIL' ? 1 : 0);
  }, 2600);
});
