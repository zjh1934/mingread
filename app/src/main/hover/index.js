// 悬停朗读服务：管理 OCR 宿主与悬停检测的生命周期，并负责把命中的文本送进朗读链路。
//
// 两种朗读方式**互斥**（用户明确要「二选一」）：
//   hotkey —— 选中文字后按热键（原有）
//   hover  —— 指针在文字上停住不动就自动读
// 互斥的含义是严格互斥：切到 hover 后热键不再触发朗读，避免两种触发同时存在导致误读。
//
// 为什么切模式时才启动 OCR：常驻进程要吃 ~30MB 内存，只在真正用得上时才起。
// 但切换的那一刻就异步预热，让用户第一次悬停时不用等 786ms 的引擎初始化。
'use strict';

const { screen } = require('electron');
const { OcrHost } = require('./ocrHost');
const { HoverReader } = require('./hoverReader');
const a11y = require('../a11yFeedback');

let _ocr = null;
let _reader = null;
let _getWindow = null;
let _isBusy = null;
let _mode = 'hotkey';
let _prewarmed = false;

function _send(channel, payload) {
  try {
    const win = typeof _getWindow === 'function' ? _getWindow() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
      return true;
    }
  } catch (e) {
    /* 窗口不可用时由调用方播报 */
  }
  return false;
}

function _announce(text, priority) {
  try {
    const p = a11y.announce({ text, priority: priority || 'normal' });
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch (e) {
    /* 播报失败不影响朗读 */
  }
}

function _ensureEngine() {
  if (_ocr) return _ocr;
  _ocr = new OcrHost();
  // 预热不阻塞：失败原因留到真正悬停时再播报，避免启动即报错
  _ocr.start().then(() => {
    _prewarmed = true;
    console.log(`[hover] OCR 引擎就绪 lang=${_ocr.lang}`);
  }).catch((e) => {
    console.warn('[hover] OCR 预热失败：' + (e && e.message));
  });
  return _ocr;
}

/** 指针是否落在主窗口矩形内（入参是物理像素，bounds 是 DIP，必须换算） */
function _isSelfPoint(px, py) {
  try {
    const win = typeof _getWindow === 'function' ? _getWindow() : null;
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const sf = (d && d.scaleFactor) || 1;
    const left = b.x * sf;
    const top = b.y * sf;
    const right = (b.x + b.width) * sf;
    const bottom = (b.y + b.height) * sf;
    return px >= left && px <= right && py >= top && py <= bottom;
  } catch (e) {
    return false;
  }
}

function init(getWindow, isBusy) {
  _getWindow = getWindow;
  _isBusy = typeof isBusy === 'function' ? isBusy : () => false;
}

function getMode() {
  return _mode;
}

/**
 * 切换朗读方式
 * @param {'hotkey'|'hover'} mode
 */
function setMode(mode) {
  const next = mode === 'hover' ? 'hover' : 'hotkey';
  _mode = next;

  if (next === 'hover') {
    _ensureEngine();
    if (!_reader) {
      _reader = new HoverReader({
        ocr: _ocr,
        isBusy: () => (_isBusy ? _isBusy() : false),
        isSelfPoint: _isSelfPoint,
        onText: (text, meta) => {
          const delivered = _send('hover:read', { text, meta });
          if (!delivered) {
            _announce('悬停读到了文字，但主窗口不可用，这次没有朗读。', 'high');
          }
        },
        onIssue: (msg) => _announce(msg, 'high'),
      });
    }
    _reader.start();
    console.log('[hover] 悬停朗读已启动');
  } else {
    if (_reader) {
      _reader.stop();
      console.log('[hover] 悬停朗读已停止');
    }
  }
  return _mode;
}

function getStats() {
  return {
    mode: _mode,
    prewarmed: _prewarmed,
    ocrLang: _ocr ? _ocr.lang : '',
    reader: _reader ? _reader.stats : null,
  };
}

function dispose() {
  if (_reader) {
    _reader.dispose();
    _reader = null;
  }
  if (_ocr) {
    _ocr.dispose();
    _ocr = null;
  }
  _prewarmed = false;
}

module.exports = { init, setMode, getMode, getStats, dispose };
