// 平台适配层出口（γ 独占）。
//   getCapabilities()   —— 能力矩阵（缓存）
//   sendCopyKeystroke() —— 发一次 Ctrl+C
//   readClipboardText() —— 读剪贴板（优先 Electron 进程内读，xclip/xsel 兜底）
'use strict';

const { execFile } = require('child_process');
const { detect } = require('./detect');
const { sendCopyKeystroke } = require('./keystroke');

const EXTERNAL_READ_TIMEOUT = 400;

/** 外部工具读剪贴板：仅在 Electron 自身读取失败时兜底 */
function readClipboardExternal(caps) {
  return new Promise((resolve) => {
    const bin = caps.tools.xclip || caps.tools.xsel;
    const args = caps.tools.xclip
      ? ['-selection', 'clipboard', '-o']
      : ['--clipboard', '--output'];
    if (!bin) {
      resolve('');
      return;
    }
    execFile(bin, args, { timeout: EXTERNAL_READ_TIMEOUT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/**
 * 读剪贴板纯文本。
 *
 * 为什么优先用 Electron 而不是 xclip：实测（Xvfb + openbox + Electron 32）中，
 * 当剪贴板所有者是 Chromium 时，外部 `xclip -o` 会一直挂住不返回（4s 超时也读不到，
 * 报 ETIMEDOUT），而 Electron 进程内 clipboard.readText() 稳定 1~3ms 返回；
 * 反过来，剪贴板所有者是别的程序（xclip 写入）时，Electron 也读得到。
 * 延迟是低视力用户的可用性红线，所以主路径走进程内读，xclip/xsel 只作兜底。
 */
async function readClipboardText(electronClipboard) {
  if (electronClipboard) {
    try {
      return electronClipboard.readText() || '';
    } catch (e) {
      /* 落到外部工具 */
    }
  }
  try {
    return await readClipboardExternal(detect());
  } catch (e) {
    return '';
  }
}

module.exports = {
  getCapabilities: detect,
  sendCopyKeystroke,
  readClipboardText,
  detect,
};
