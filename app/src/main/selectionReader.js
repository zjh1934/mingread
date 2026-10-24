// 划词朗读：按全局热键（默认 F1，可在设置中更换）时抓取"系统任意位置选中的文字"。
//
// v2.3（γ 重写）：
//   1. 抓选区走平台适配层 platform/：Linux-X11 用 xdotool key ctrl+c，
//      Windows 走 WScript.Shell.SendKeys("^c")，探测到不能用就明确报原因。
//   2. **不允许静默退化**（基线 P2-12 / 指标 H）：
//      抓不到就是抓不到，返回 code='NO_SELECTION' + 一句可直接播报的话，
//      绝不再悄悄把几分钟前的旧剪贴板当成"选区"读出来。
//      只有调用方**显式**传 allowClipboardFallback=true 时才读剪贴板，
//      且返回 stale=true + source='clipboard'，上层必须先说一句"这是剪贴板内容"。
//   3. 超时按平台重估：X11 发键实测约 30ms、剪贴板进程内读约 1~3ms，
//      原 1.5s 会把每一次失败都变成 1.5s 的"按了没反应"（低视力用户会重复按键）。
//      现 X11 默认 600ms、Windows 默认 1200ms（PowerShell 冷启动更慢），可覆盖。
//   4. 不再写哨兵：实测 Xvfb+openbox 下，一旦由 Electron（Chromium）写入剪贴板，
//      Chromium 就成为 CLIPBOARD 所有者，之后外部 xclip -o 会挂死、Electron 自身
//      读到的也一直是自己写进去的旧值，外来程序 Ctrl+C 写进来的内容读不到。
//      改成"发键前读一份、发键后轮询到与旧值不同为止"，既避开所有权问题，
//      又不改变语义（复制结果与旧剪贴板相同 => 内容一样，读哪个都不亏）。
'use strict';

const { clipboard } = require('electron');
const platform = require('./platform');
// 抓取通道直达 platform/keystroke：platform/index.js 的出口没有 captureSelection，
// 而「发键+读剪贴板」的合体动作只有常驻宿主能一次做完（见 captureHost.js 文件头）。
const keystroke = require('./platform/keystroke');

// Get-Clipboard -Raw 对超长文本可能截断；超过这个长度就用进程内读复核（1~3ms）
const HOST_TEXT_SUSPECT_LEN = 32000;

/** 文本来源：上层必须据此区分播报 */
const SOURCE = {
  SELECTION: 'selection',
  CLIPBOARD: 'clipboard',
  NONE: 'none',
};

/** 状态码：上层可据此决定播报文案 / 是否提示安装依赖 */
const CODE = {
  OK: 'OK',
  NO_SELECTION: 'NO_SELECTION',
  NO_DISPLAY: 'NO_DISPLAY',
  WAYLAND_UNSUPPORTED: 'WAYLAND_UNSUPPORTED',
  TOOL_MISSING: 'TOOL_MISSING',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  SEND_KEY_FAILED: 'SEND_KEY_FAILED',
  CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
  CAPTURE_ERROR: 'CAPTURE_ERROR',
};

/** 每个失败码一句人话（可直接送 TTS） */
const MESSAGE = {
  [CODE.OK]: '',
  [CODE.NO_SELECTION]: '未获取到选区，请重新选中文字后再按朗读热键。',
  [CODE.NO_DISPLAY]: '当前没有可用的图形显示服务，无法抓取选区。',
  [CODE.WAYLAND_UNSUPPORTED]: '检测到 Wayland 会话，暂不支持抓取选区，请切换到 X11 会话。',
  [CODE.TOOL_MISSING]: '缺少抓选区所需的命令行工具，无法抓取选区。',
  [CODE.UNSUPPORTED_PLATFORM]: '当前系统暂不支持抓取选区。',
  [CODE.SEND_KEY_FAILED]: '发送复制快捷键失败，可能没有可复制的窗口焦点。',
  [CODE.CAPTURE_TIMEOUT]: '等待复制结果超时，未获取到选区。',
  [CODE.CAPTURE_ERROR]: '抓取选区时发生错误。',
};

const CLIPBOARD_FALLBACK_MESSAGE = '未获取到选区，下面读的是剪贴板里的内容，不是你刚才选中的文字。';

function defaultTimeout(strategy) {
  return strategy === 'win32-sendkeys' ? 1200 : 600;
}

/** 统一出口构造，保证字段齐全 */
function makeResult(o) {
  return {
    ok: o.code === CODE.OK,
    text: o.text || '',
    source: o.source || SOURCE.NONE,
    code: o.code || CODE.CAPTURE_ERROR,
    message: o.message !== undefined ? o.message : MESSAGE[o.code] || '',
    stale: !!o.stale,
    strategy: o.strategy || 'none',
    tookMs: o.tookMs || 0,
    detail: o.detail || undefined,
  };
}

/**
 * 读取当前选中文字
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 等剪贴板被改写的最长时间
 * @param {number} [opts.pollMs] 轮询间隔
 * @param {boolean} [opts.allowClipboardFallback] 显式允许剪贴板兜底（默认 false = 不静默退化）
 * @returns {Promise<{ok:boolean,text:string,source:'selection'|'clipboard'|'none',code:string,message:string,stale:boolean,strategy:string,tookMs:number,detail?:object}>}
 */
async function readSelection(opts = {}) {
  const caps = platform.getCapabilities();
  const strategy = caps.strategy;
  const timeoutMs = opts.timeoutMs || defaultTimeout(strategy);
  // 轮询间隔默认交给平台层（宿主 5ms；兜底通道自己会抬到 ≥15ms），这里只透传显式覆盖
  const pollMs = opts.pollMs;
  const startedAt = Date.now();
  const took = () => Date.now() - startedAt;

  // 1. 备份原剪贴板（无论如何最后都要还回去）
  let backup = '';
  let backupHtml = '';
  try {
    backup = clipboard.readText() || '';
    backupHtml = clipboard.readHTML() || '';
  } catch (e) {
    backup = '';
    backupHtml = '';
  }

  // 发键前的剪贴板快照：用来判断 Ctrl+C 到底有没有写入新内容
  // （不再写哨兵，见文件头第 4 条；因此复制结果与旧剪贴板完全相同时无法区分，概率极低且内容一致）
  const before = backup;

  const restore = () => {
    try {
      if (backupHtml) clipboard.write({ text: backup, html: backupHtml });
      else if (backup) clipboard.writeText(backup);
      else clipboard.clear();
    } catch (e) {
      /* 还原失败不影响主流程 */
    }
  };

  // 剪贴板兜底：唯一出口，且必须打上 stale=true
  const fallback = (code, extra) => {
    const base = { strategy, tookMs: took(), ...(extra || {}) };
    if (opts.allowClipboardFallback === true && backup && backup.trim()) {
      restore();
      return makeResult({
        ...base,
        text: backup.trim(),
        source: SOURCE.CLIPBOARD,
        code,
        message: CLIPBOARD_FALLBACK_MESSAGE,
        stale: true,
      });
    }
    restore();
    return makeResult({ ...base, source: SOURCE.NONE, code });
  };

  // 2. 平台不支持：直接返回原因，不做任何抓选区动作
  if (!caps.captureOk) {
    return fallback(caps.code === 'OK' ? CODE.CAPTURE_ERROR : caps.code, {
      detail: { reason: caps.reason, displayServer: caps.displayServer, display: caps.display },
    });
  }

  // 3. 抓取：一次 captureSelection（Windows 走常驻宿主，发键与 5ms 粒度轮询都在宿主内；
  //    宿主不可用时平台层自动回退"一次性 PowerShell + Node 轮询"）。
  //    命中判据仍旧是"剪贴板内容 != 发键前"，语义与 v2.3 完全一致。
  let text = '';
  let sendInfo = null;
  let via = 'none';
  try {
    const cap = await keystroke.captureSelection({
      before,
      timeoutMs,
      pollMs,
      // 兜底通道要有自己的快照读：进程内读 1~3ms，比外部工具稳（见 platform/index.js 注释）
      readClipboard: () => clipboard.readText() || '',
    });
    via = cap.via || 'none';
    sendInfo = { tookMs: cap.sendTookMs == null ? -1 : cap.sendTookMs };
    if (cap.ok && cap.text) {
      text = cap.text;
      // 已知坑：Get-Clipboard -Raw 对超长文本可能截断。此时剪贴板里还是刚复制的内容，
      // 用进程内读复核一次（1~3ms），只在"更长且同前缀"时采用，避免拿别的东西冒充选区。
      if (text.length >= HOST_TEXT_SUSPECT_LEN) {
        try {
          const live = clipboard.readText() || '';
          if (live.length > text.length && live.slice(0, 64) === text.slice(0, 64)) text = live;
        } catch (e) {
          /* 复核失败就用宿主读到的 */
        }
      }
    } else if (cap.error) {
      return fallback(cap.stage === 'send' ? CODE.SEND_KEY_FAILED : CODE.CAPTURE_ERROR, {
        detail: { error: cap.error, via, sendTookMs: sendInfo.tookMs },
      });
    }
    // 无 error 且无 text：没选中（或等到超时）——落到下面的 NO_SELECTION
  } catch (e) {
    console.error('[selection] capture failed:', e && e.message);
    return fallback(CODE.CAPTURE_ERROR, { detail: { error: e && e.message } });
  }

  // 4. 还原用户原剪贴板
  restore();

  if (text && text.trim()) {
    return makeResult({
      text: text.trim(),
      source: SOURCE.SELECTION,
      code: CODE.OK,
      message: '',
      stale: false,
      strategy,
      tookMs: took(),
      detail: { sendTookMs: sendInfo ? sendInfo.tookMs : -1, timeoutMs, via },
    });
  }

  // 5. 没有选中（Ctrl+C 没改写剪贴板）—— 不静默读旧剪贴板
  return fallback(CODE.NO_SELECTION, {
    detail: { sendTookMs: sendInfo ? sendInfo.tookMs : -1, timeoutMs, via },
  });
}

module.exports = { readSelection, SOURCE, CODE, MESSAGE };
