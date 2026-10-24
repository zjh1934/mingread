// 轻量诊断日志：把关键事件写进 userData/diagnostics.log。
//
// 为什么需要：打包版是 Windows GUI 子系统，console.log 不进 stdout，
// 用户报「放大用不了 / 没有声音」时我们拿不到任何现场信息。
// 这个文件只记关键事件（启动、后端选择、引擎切换、错误），不记录朗读内容、不记录按键，
// 单文件上限 256KB，超出后从头截断，不会无限增长。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;
let filePath = '';
let ready = false;

/** 必须在 app.whenReady 之后调用（此前 app.getPath('userData') 不可靠） */
function init() {
  try {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    filePath = path.join(app.getPath('userData'), 'diagnostics.log');
    ready = true;
    return filePath;
  } catch (e) {
    ready = false;
    return '';
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 写一行诊断日志。
 * @param {string} tag 分类，如 boot / zoom / tts
 * @param {string} msg 内容（不要放朗读文本、剪贴板内容等隐私数据）
 */
function log(tag, msg) {
  if (!ready) return;
  const line = `${stamp()} [${tag}] ${msg}\n`;
  try {
    // 超限则截断重来（保留最近的事件，历史价值低）
    try {
      const st = fs.statSync(filePath);
      if (st.size > MAX_BYTES) fs.writeFileSync(filePath, '');
    } catch (e) {
      /* 文件还不存在 */
    }
    fs.appendFileSync(filePath, line);
  } catch (e) {
    /* 磁盘只读/权限不足：静默放弃，绝不影响主流程 */
  }
  // 同时打到 stdout，开发时能直接看到
  // eslint-disable-next-line no-console
  console.log(line.trimEnd());
}

function getPath() {
  return filePath;
}

module.exports = { init, log, getPath };
