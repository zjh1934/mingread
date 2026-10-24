// 发送"复制"按键：按平台能力选择实现。
//   Linux(X11)  -> xdotool key --clearmodifiers ctrl+c
//   Windows     -> PowerShell WScript.Shell.SendKeys('^c')
// 两条路都只负责"发键 + 上报耗时"，不读剪贴板（读在 selectionReader 里做）。
'use strict';

const { execFile } = require('child_process');
const { detect } = require('./detect');

const PS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle',
  'Hidden',
  '-Command',
  '$w = New-Object -ComObject WScript.Shell; $w.SendKeys("^c")',
];

/** xdotool：--clearmodifiers 保证热键残留的修饰键不会把 ctrl+c 变成别的组合键 */
function sendViaXdotool(xdotool) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(xdotool, ['key', '--clearmodifiers', 'ctrl+c'], { timeout: 1500, windowsHide: true }, (err) => {
      resolve({
        ok: !err,
        strategy: 'x11-xdotool',
        error: err ? err.message : '',
        tookMs: Date.now() - t0,
      });
    });
  });
}

function sendViaPowershell(ps) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(ps, PS_ARGS, { timeout: 6000, windowsHide: true }, (err) => {
      resolve({
        ok: !err,
        strategy: 'win32-sendkeys',
        error: err ? err.message : '',
        tookMs: Date.now() - t0,
      });
    });
  });
}

/**
 * 发送一次 Ctrl+C（不等待剪贴板变化）
 * @returns {Promise<{ok:boolean, strategy:string, error:string, tookMs:number, code?:string, reason?:string}>}
 */
async function sendCopyKeystroke() {
  const caps = detect();
  if (caps.strategy === 'x11-xdotool') return sendViaXdotool(caps.tools.xdotool);
  if (caps.strategy === 'win32-sendkeys') return sendViaPowershell(caps.tools.powershell);
  return {
    ok: false,
    strategy: caps.strategy,
    error: caps.reason || 'no strategy',
    code: caps.code,
    reason: caps.reason,
    tookMs: 0,
  };
}

module.exports = { sendCopyKeystroke };
