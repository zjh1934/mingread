// 剪贴板监视：clipboardAuto===true 时由 index.js 启动（v2.3.1 默认开，基线 P1-9：
// 低视力用户看清屏幕文字费劲，复制即读是刚需；用户可在设置里关掉）。
// 轮询间隔 900ms；monitor 未启动时不会发送任何 clipboard:new 事件。
//
// v2.3.1 两条保护（基线 P1-9 明确要求「带节流与长度上限」）：
//   1. 节流（THROTTLE_MS=1500，尾沿合并）：用户连续复制多段文字时，不每段都触发朗读。
//      窗口内的第一次立即 emit，后续复制只保留最新一条，窗口结束补发一次
//      ——连续复制时「听到最新的那条」比把队列全读一遍更合理。
//   2. 长度上限（MAX_AUTO_READ_CHARS=20000）：超长文本不无脑朗读（TTS 几十分钟起步）。
//      超长时不发 clipboard:new（不触发朗读），并语音播报跳过原因——不静默失败（基线 P2-12）。
'use strict';

const { clipboard } = require('electron');
// γ 的 a11yFeedback：只读使用其 announce 导出（超长跳过时明确告知），不修改其实现
const a11y = require('./a11yFeedback');

const POLL_MS = 900;
const THROTTLE_MS = 1500;
const MAX_AUTO_READ_CHARS = 20000;
/** 超长播报最小间隔：连续复制多篇超长文本时不要每篇都播一遍 */
const TOO_LONG_ANNOUNCE_MS = 10000;

/**
 * 朗读热键抓选区（readSelection）时会向焦点窗口发 Ctrl+C、读完即还原剪贴板。
 * 若不做抑制，剪贴板监视器会把「抓取瞬间的选区内容」和「还原后的旧内容」当成用户
 * 连续复制两次，触发重复朗读——甚至把旧剪贴板内容读出来（基线指标 H 明令禁止）。
 * 抓取前调用本函数申请一段静默期；期内不 emit、不更新 last（期后按原逻辑正常比对，
 * 用户在静默期内的真实复制不会丢，最多稍延迟）。
 */
let _suppressUntil = 0;
function suppressAutoRead(ms) {
  const until = Date.now() + (Number(ms) > 0 ? Number(ms) : 0);
  if (until > _suppressUntil) _suppressUntil = until;
}

/**
 * @param {() => import('electron').BrowserWindow|null} getWindow
 * @param {() => boolean} getAutoRead 当前是否开启“复制自动朗读”
 * @returns {() => void} 停止函数
 */
function startClipboardMonitor(getWindow, getAutoRead) {
  // 启动时先记录当前剪贴板内容，避免刚打开软件就弹出「检测到剪贴板新内容」
  let last = '';
  try {
    last = clipboard.readText() || '';
  } catch (e) {
    last = '';
  }
  let lastEmitAt = 0;
  let pending = null; // 节流窗口内的最新文本（尾沿补发用）
  let flushTimer = null;
  let lastTooLongAnnounceAt = 0;

  function emit(text, autoRead) {
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('clipboard:new', { text, autoRead: !!autoRead });
        return true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /** 超长文本跳过自动朗读：语音播报原因（normal 优先级：不打断当前朗读，排队也能听到） */
  function announceTooLong(text) {
    const now = Date.now();
    if (now - lastTooLongAnnounceAt < TOO_LONG_ANNOUNCE_MS) return;
    lastTooLongAnnounceAt = now;
    try {
      const p = a11y.announce({
        text: `剪贴板内容过长，共 ${text.length} 字，超过 ${MAX_AUTO_READ_CHARS} 字上限，已跳过自动朗读。可在主界面粘贴后手动朗读。`,
        priority: 'normal',
      });
      if (p && typeof p.then === 'function') {
        p.then((r) => {
          console.log(`[clipboard] too-long announce ok=${!!(r && r.ok)} skipped=${(r && r.skipped) || '-'}`);
        }).catch(() => { /* 播报失败不影响主流程 */ });
      }
    } catch (e) {
      /* 播报通道异常时忽略 */
    }
  }

  /** 节流窗口结束：补发窗口内最新的一条 */
  function flush() {
    flushTimer = null;
    if (pending == null) return;
    const text = pending;
    pending = null;
    lastEmitAt = Date.now();
    const autoRead = !!getAutoRead();
    emit(text, autoRead);
    console.log(`[clipboard] trailing flush len=${text.length} autoRead=${autoRead}`);
  }

  const timer = setInterval(() => {
    let txt = '';
    try {
      txt = clipboard.readText();
    } catch (e) {
      return;
    }
    if (!txt || txt === last) return;
    // 朗读热键抓选区的静默期内：什么都不做（也不更新 last，见 suppressAutoRead 注释）
    if (Date.now() < _suppressUntil) {
      console.log(`[clipboard] change during suppression window, deferred (len=${txt.length})`);
      return;
    }
    last = txt;
    const autoRead = !!getAutoRead();
    // 长度上限：仅在自动朗读开启时把关（关闭时本事件渲染层也会忽略）
    if (autoRead && txt.length > MAX_AUTO_READ_CHARS) {
      announceTooLong(txt);
      console.log(`[clipboard] too long len=${txt.length} > ${MAX_AUTO_READ_CHARS}, auto-read skipped`);
      return;
    }
    const now = Date.now();
    if (now - lastEmitAt >= THROTTLE_MS) {
      // 窗口外：立即emit
      lastEmitAt = now;
      pending = null;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      emit(txt, autoRead);
      console.log(`[clipboard] new text len=${txt.length} autoRead=${autoRead} emit=immediate`);
    } else {
      // 节流窗口内：只保留最新，尾沿补发一次
      pending = txt;
      if (!flushTimer) {
        const wait = THROTTLE_MS - (now - lastEmitAt);
        flushTimer = setTimeout(flush, wait);
      }
      console.log(`[clipboard] new text len=${txt.length} throttled, trailing flush in ${THROTTLE_MS - (now - lastEmitAt)}ms`);
    }
  }, POLL_MS);

  return () => {
    clearInterval(timer);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    pending = null;
  };
}

module.exports = { startClipboardMonitor, suppressAutoRead };
