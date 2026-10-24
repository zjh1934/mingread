// 状态播报服务：把「发生了什么」用语音说出来，并给出非语音的即时反馈音。
//
// 背景：本项目此前所有状态反馈只有视觉通道（Snackbar / 颜色 / 图标），
// 用户在别的应用里按热键失败时完全不知情。本服务是语音通道的唯一出口。
//
// IPC 契约（编排者定版，γ 在 main 侧实现）：
//   window.api.a11y.announce({ text, priority: 'high' | 'normal' })
//   window.api.a11y.cue({ type: 'press' | 'success' | 'error' })
// 桥未就绪时整体静默降级：不抛错、不阻塞界面（桥名同时兼容 window.langdu.a11y）。
//
// 三条硬规则（低视力用户会被吵死，所以必须去重 + 节流）：
//   1. 同一句话在 dedupWindowMs 内只播一次（合并，不排队重复）
//   2. 相邻两条播报至少间隔 minGapMs；期间到达的低优先级消息只保留最后一条（合并）
//   3. priority='high' 允许更快插话（错误、关键状态），用于打断当前朗读

const DEFAULT_CONFIG = {
  enabled: true,
  minGapMs: 800, // 常规播报之间的最小间隔
  highMinGapMs: 250, // high 优先级可提前插话的最小间隔
  dedupWindowMs: 3000, // 相同文案在这个窗口内合并为一条
  cueGapMs: 150, // 同一类提示音的最小间隔
};

let config = { ...DEFAULT_CONFIG };

// 最近一次真正发出的播报
let last = { key: '', text: '', at: 0 };
// 节流窗口内被挂起的播报（只保留最后一条 = 合并）
let pending = null;
const cueAt = { press: 0, success: 0, error: 0 };
let warnedMissing = false;

function now() {
  return Date.now();
}

function transport() {
  if (typeof window === 'undefined') return null;
  try {
    return (
      (window.api && window.api.a11y) || (window.langdu && window.langdu.a11y) || null
    );
  } catch (e) {
    return null;
  }
}

function dispatch(method, payload) {
  const t = transport();
  if (!t || typeof t[method] !== 'function') {
    if (!warnedMissing) {
      warnedMissing = true;
      // 桥未就绪只提示一次，避免刷屏；功能降级为纯视觉反馈
      console.warn('[announcer] a11y 桥未就绪，语音播报降级为纯视觉');
    }
    return false;
  }
  try {
    t[method](payload);
    return true;
  } catch (e) {
    return false;
  }
}

function clearPending() {
  if (pending && pending.timer) clearTimeout(pending.timer);
  pending = null;
}

function emit(item) {
  clearPending();
  last = { key: item.key || '', text: item.text, at: now() };
  return dispatch('announce', { text: item.text, priority: item.priority === 'high' ? 'high' : 'normal' });
}

/**
 * 播报一条状态。
 * @param {string} key   去重键（同一状态用同一个 key）；传 null 则用文本本身做键
 * @param {string} text  播报文本（中文、简短、能让人知道下一步干嘛）
 * @param {object} opts  { priority:'high'|'normal', minInterval:number（默认 dedupWindowMs） }
 * @returns {boolean} 是否真正发出（false 表示被去重或节流丢弃）
 */
export function say(key, text, opts = {}) {
  if (!config.enabled) return false;
  const msg = String(text == null ? '' : text).trim();
  if (!msg) return false;

  const t = now();
  const minInterval = Number.isFinite(opts.minInterval) ? opts.minInterval : config.dedupWindowMs;
  // 规则 1：完全相同的文案（或同 key 同文案）在窗口内合并为一条
  if (last.text === msg && t - last.at < minInterval) return false;

  const item = { key: key || msg, text: msg, priority: opts.priority === 'high' ? 'high' : 'normal' };
  const gap = t - last.at;

  // 规则 3：高优先级可以更快插话
  if (last.at === 0 || gap >= config.minGapMs || (item.priority === 'high' && gap >= config.highMinGapMs)) {
    return emit(item);
  }

  // 规则 2：节流窗口内只保留最后一条（后来的覆盖先来的 = 合并）
  clearPending();
  const wait = Math.max(0, config.minGapMs - gap);
  item.timer = setTimeout(() => {
    item.timer = null;
    if (pending === item) {
      pending = null;
      emit(item);
    }
  }, wait);
  pending = item;
  return false;
}

/**
 * 非语音反馈音：<100ms 的极短促声音，用于「已收到指令」。
 * @param {'press'|'success'|'error'} type
 */
export function cue(type) {
  if (!config.enabled) return false;
  const kind = ['press', 'success', 'error'].indexOf(type) >= 0 ? type : 'press';
  const t = now();
  if (t - (cueAt[kind] || 0) < config.cueGapMs) return false;
  cueAt[kind] = t;
  return dispatch('cue', { type: kind });
}

/** 丢弃尚未发出的挂起播报（例如「正在合成」被「已开始朗读」取代时） */
export function cancelPending() {
  clearPending();
  return true;
}

export function configure(patch) {
  if (patch && typeof patch === 'object') config = { ...config, ...patch };
  return { ...config };
}

export function getConfig() {
  return { ...config };
}

/** 忘记历史（换文档 / 停止朗读后调用，避免跨场景误判为重复） */
export function reset() {
  clearPending();
  last = { key: '', text: '', at: 0 };
}

// ---------------------------------------------------------------------------
// 预置播报文案：站在使用者角度写——听完要知道「现在怎样 / 下一步干嘛」
// 值为函数时接收 params，返回播报文本。
// ---------------------------------------------------------------------------
export const MESSAGES = {
  start: () => '已开始朗读',
  pause: () => '已暂停',
  resume: () => '继续朗读',
  stop: () => '已停止',
  synthesizing: () => '正在合成，请稍候',
  synthFailed: () => '合成失败，请检查网络后重试',
  networkOffline: () => '网络已断开，朗读需要联网，请检查网络连接后重试',
  hotkeyConflict: (p = {}) =>
    p.hotkey
      ? `热键 ${p.hotkey} 被其他程序占用，请在设置里换一个热键`
      : '热键被其他程序占用，请在设置里换一个热键',
  noSelection: () => '未获取到选区，请重新选中文字再按热键',
  readClipboard: () => '没读到选中文字，已朗读剪贴板里的内容',
  emptyText: () => '没有可朗读的文本，请先输入或导入文本',
  timerStop: () => '定时时间到，已停止朗读',
  timerSet: (p = {}) => `已设置 ${p.minutes} 分钟后自动停止`,
  saved: () => '设置已保存',
  sentence: (p = {}) => {
    const n = Number(p.index) + 1;
    const m = Number(p.total);
    return m > 0 ? `第 ${n} 句，共 ${m} 句` : `第 ${n} 句`;
  },
  seek: (p = {}) => `已跳到 ${p.time || '开头'}`,
  rateChanged: (p = {}) => {
    const v = Number(p.rate) || 0;
    return v === 0 ? '语速已恢复正常' : `语速已调${v > 0 ? '快' : '慢'}，${v > 0 ? '+' : ''}${v}`;
  },
  themeChanged: (p = {}) => `已切换到${p.themeMode === 'dark' ? '深色' : '浅色'}主题`,
  hotkeyChanged: (p = {}) => `热键已改为 ${p.hotkey}`,
  hotkeyFailed: () => '热键设置失败，可能被其他程序占用，请换一个',
  flagToggled: (p = {}) => `${p.label}已${p.value ? '开启' : '关闭'}`,
  importDone: (p = {}) => (p.title ? `已导入《${p.title}》，共 ${p.chapters} 章` : `已导入 ${p.files} 个文件`),
  exportDone: () => '导出完成',
  exportFailed: () => '导出失败，请重试',
  voiceChanged: (p = {}) => `已切换到${p.name || '新音色'}`,
};

/**
 * 按预置状态播报。
 * @param {keyof MESSAGES} name
 * @param {object} params
 * @param {object} opts  { priority, minInterval }
 */
export function announce(name, params = {}, opts = {}) {
  const tpl = MESSAGES[name];
  if (!tpl) return false;
  const text = typeof tpl === 'function' ? tpl(params || {}) : String(tpl);
  return say(name, text, opts);
}

const announcer = {
  say,
  cue,
  announce,
  announcePreset: announce,
  cancelPending,
  configure,
  getConfig,
  reset,
  MESSAGES,
};

export default announcer;
