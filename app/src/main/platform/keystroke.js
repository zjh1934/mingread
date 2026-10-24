// 发送"复制"按键 + 抓取选区文本：按平台能力选择实现。
//   Linux(X11)  -> xdotool key --clearmodifiers ctrl+c  + Node 侧轮询剪贴板
//   Windows     -> 常驻 PowerShell 通道（captureHost，发键+5ms 粒度读剪贴板都在宿主内）
//                  宿主起不来时回退到一次性 PowerShell（WScript.Shell.SendKeys） + Node 轮询
//
// 分层（延迟第一优先，但**不允许静默退化**）：
//   captureSelection()           —— 上层唯一入口，返回 {ok,text,tookMs,via,error}
//   captureSelectionOneShot()    —— 兜底通道（原实现，冷启动 200~400ms），也用于对照实验
//   sendCopyKeystroke()          —— 只发键不读剪贴板（保留原语义：外部工具/探针可单独用）
'use strict';

const { execFile } = require('child_process');
const { detect } = require('./detect');
const { CaptureHost, getCaptureHost } = require('./captureHost');

const PS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle',
  'Hidden',
  '-Command',
  '$w = New-Object -ComObject WScript.Shell; $w.SendKeys("^c")',
];

/** 一次性兜底通道的轮询间隔下限：每次读都是进程内 IPC，5ms 轮询纯属空转 */
const ONESHOT_MIN_POLL_MS = 15;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

/**
 * 取一个"读当前剪贴板文本"的同步函数。
 * 优先用调用方注入的（selectionReader 会传 Electron clipboard.readText，进程内 1~3ms），
 * 其次自己 require('electron')，最后退回平台层的外部工具（xclip/xsel，慢但能用）。
 */
function resolveReader(injected) {
  if (typeof injected === 'function') return injected;
  try {
    const { clipboard } = require('electron');
    if (clipboard && typeof clipboard.readText === 'function') return () => clipboard.readText() || '';
  } catch (e) {
    /* 非 Electron 上下文（探针/单测） */
  }
  return async () => {
    try {
      // 延迟 require：避免 index.js ↔ keystroke.js 的循环依赖（index 会引入本文件）
      const platform = require('./index');
      return (await platform.readClipboardText(undefined)) || '';
    } catch (e) {
      return '';
    }
  };
}

/** 只抹掉 CR：Get-Clipboard 与 Electron 对换行的处理可能差一个 \r，不能因此把旧值当成新选区 */
function norm(s) {
  return String(s == null ? '' : s).replace(/\r/g, '');
}

/**
 * 兜底通道（原实现）：一次性进程发键 + Node 侧轮询剪贴板。
 * Windows 上冷启动 200~400ms；非线性退化时（宿主不可用）才走这里。
 *
 * @param {object} [opts] 同 captureSelection
 * @returns {Promise<{ok:boolean,text:string,tookMs:number,via:'oneshot',error:string,sendTookMs:number,timedOut:boolean,stage:string}>}
 */
async function captureSelectionOneShot(opts = {}) {
  const before = opts.before == null ? '' : String(opts.before);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 1200;
  const pollMs = Math.max(Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 30, ONESHOT_MIN_POLL_MS);
  const read = resolveReader(opts.readClipboard);
  const t0 = Date.now();
  const base = { via: 'oneshot', text: '', tookMs: 0, sendTookMs: -1, timedOut: false, stage: '' };

  let sendInfo;
  try {
    sendInfo = await sendCopyKeystroke();
  } catch (e) {
    return { ...base, tookMs: Date.now() - t0, error: (e && e.message) || 'send failed', stage: 'send' };
  }
  if (!sendInfo.ok) {
    return {
      ...base,
      tookMs: Date.now() - t0,
      sendTookMs: sendInfo.tookMs,
      error: sendInfo.error || '发送复制快捷键失败',
      stage: 'send',
    };
  }

  const beforeNorm = norm(before);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let cur = '';
    try {
      cur = (await read()) || '';
    } catch (e) {
      cur = '';
    }
    if (cur && norm(cur) !== beforeNorm) {
      return { ...base, ok: true, text: cur, tookMs: Date.now() - t0, sendTookMs: sendInfo.tookMs, error: '' };
    }
    await sleep(pollMs);
  }
  return {
    ...base,
    ok: false,
    tookMs: Date.now() - t0,
    sendTookMs: sendInfo.tookMs,
    error: '',
    timedOut: true,
    stage: 'wait',
  };
}

/**
 * 抓取当前选区文本（宿主优先，宿主不可用自动回退一次性通道）。
 *
 * 语义红线：**只有剪贴板内容确实变了才算抓到**；没变/超时一律 ok=false，
 * 由上层翻译成"未获取到选区"，绝不把旧剪贴板当选区返回。
 *
 * @param {object} [opts]
 * @param {string} [opts.before] 发键前的剪贴板文本（比对基准）
 * @param {number} [opts.timeoutMs=1200] 等剪贴板被改写的最长时间
 * @param {number} [opts.pollMs=5] 宿主内轮询粒度（兜底通道自动抬到 ≥15ms）
 * @param {()=>string} [opts.readClipboard] 读剪贴板（兜底通道用；默认取 Electron clipboard）
 * @returns {Promise<{ok:boolean,text:string,tookMs:number,via:'host'|'oneshot',error:string,sendTookMs:number,timedOut:boolean,stage:string}>}
 */
async function captureSelection(opts = {}) {
  const before = opts.before == null ? '' : String(opts.before);
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 1200;
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 5;
  const oneShotOpts = {
    before,
    // 宿主起不来时兜底：给足一次性通道的冷启动余量，但不多给——用户已经在等了
    timeoutMs,
    pollMs,
    readClipboard: opts.readClipboard,
  };

  if (!CaptureHost.supported) {
    // Linux：没有常驻通道，直接走 xdotool + 轮询（原行为）
    return captureSelectionOneShot(oneShotOpts);
  }

  // opts.host 仅测试/探针注入用（验证"宿主不可用 → 自动回退"这条分支），生产不传
  const host = opts.host || getCaptureHost();
  const t0 = Date.now();
  let res;
  try {
    res = await host.capture({ before, timeoutMs, pollMs });
  } catch (e) {
    const stage = (e && e.stage) || 'request';
    const elapsed = Date.now() - t0;
    // 只有"宿主根本没发出按键"的失败才允许回退：
    //   start（进程没起来）/ write（管道已断）——此时前台窗口没收到过 ^c，重试安全。
    //   timeout / exit（按键已发出、甚至已复制）——再发一次会双重复制，且总耗时翻倍，
    //   交给上层报"未获取到选区"，由用户再按一次热键（热键有 busy 保护，不会连击）。
    if (stage === 'start' || stage === 'write') {
      const fb = await captureSelectionOneShot(oneShotOpts);
      if (!fb.ok) fb.hostError = (e && e.message) || String(e);
      return fb;
    }
    return {
      ok: false,
      text: '',
      tookMs: elapsed,
      via: 'host',
      error: (e && e.message) || String(e),
      sendTookMs: -1,
      timedOut: !!e.timedOut || stage === 'timeout',
      stage,
    };
  }

  const tookMs = Date.now() - t0;
  if (res.hit && res.text) {
    // 双重保险：宿主判"变了"但抹掉 CR 后与发键前一致 => 其实是同一份内容（旧剪贴板），按未选中处理
    if (norm(res.text) === norm(before)) {
      return { ok: false, text: '', tookMs, via: 'host', error: '', sendTookMs: res.sendMs, timedOut: false, stage: 'unchanged' };
    }
    return { ok: true, text: res.text, tookMs, via: 'host', error: '', sendTookMs: res.sendMs, timedOut: false, stage: '' };
  }
  return { ok: false, text: '', tookMs, via: 'host', error: '', sendTookMs: res.sendMs, timedOut: true, stage: 'wait' };
}

module.exports = { sendCopyKeystroke, captureSelection, captureSelectionOneShot };
