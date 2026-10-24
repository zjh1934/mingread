// 错误/状态历史服务（基线 P2：失败可感知、可回看）
// ---------------------------------------------------------------------------
// 背景：原有反馈只有 Snackbar（4.2 秒消失）+ 语音播报。低视力用户可能正盯着别处、
// 或已疲劳到不想聚焦屏幕，错过之后无从查起。本服务是「状态历史」的唯一存储：
//   · SettingsDialog「记录」页展示（时间 + 内容，可清空）
//   · 持久化到 localStorage，刷新/重启不丢
//   · 兜底捕获全局未处理异常与热键冲突事件（App 级 notify 无法直接挂钩，
//     这里补最关键的漏网事件；桥未就绪时静默降级）
// 上限 100 条，超出丢弃最旧的。
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'langdu-neo-status-history';
export const STATUS_HISTORY_MAX = 100;
const SEVERITIES = ['error', 'warning', 'success', 'info'];

let items = [];
let hydrated = false;
let hooksInstalled = false;
const listeners = new Set();

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** 时间戳 → HH:mm:ss（低视力：等宽数字，不跳位） */
export function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function persist() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    }
  } catch (e) {
    /* 隐私模式等场景下降级为仅内存，不阻塞功能 */
  }
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const arr = raw ? JSON.parse(raw) : [];
    if (Array.isArray(arr)) {
      items = arr.filter((x) => x && typeof x.message === 'string').slice(0, STATUS_HISTORY_MAX);
    }
  } catch (e) {
    items = [];
  }
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(items);
    } catch (e) {
      /* 单个订阅者异常不拖垮其他订阅者 */
    }
  });
}

/**
 * 记录一条状态/错误（新的在前）。
 * @param {string} message 内容（屏幕上看的长文案）
 * @param {object} [opts] { severity:'error'|'warning'|'success'|'info', source?:string }
 * @returns {object|null} 入库的记录（空文案返回 null）
 */
export function record(message, opts = {}) {
  const msg = String(message == null ? '' : message).trim();
  if (!msg) return null;
  hydrate();
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    time: Date.now(),
    severity: SEVERITIES.indexOf(opts.severity) >= 0 ? opts.severity : 'info',
    source: opts.source ? String(opts.source) : '',
    message: msg,
  };
  items = [item, ...items].slice(0, STATUS_HISTORY_MAX);
  persist();
  emit();
  return item;
}

/** 清空全部记录 */
export function clear() {
  hydrate();
  items = [];
  persist();
  emit();
}

/** 读取全部记录（新的在前；返回内部数组的副本，避免调用方改坏） */
export function getAll() {
  hydrate();
  return items.slice();
}

/** 订阅记录变化（写入/清空时触发）；返回取消订阅函数 */
export function subscribe(fn) {
  hydrate();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// 全局兜底钩子（幂等，模块加载时装一次）
//   · window.error / unhandledrejection：渲染层未捕获异常
//   · window.langdu.onHotkeyConflict：热键被占用（App 也会弹 Snackbar，这里留痕）
// ---------------------------------------------------------------------------
function installGlobalHooks() {
  if (hooksInstalled || typeof window === 'undefined') return;
  hooksInstalled = true;

  window.addEventListener('error', (e) => {
    const msg = (e && e.message) || '未知错误';
    record(`程序出现异常：${msg}`, { severity: 'error', source: 'runtime' });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    const msg = (r && (r.message || String(r))) || '未知错误';
    record(`未处理的异步失败：${msg}`, { severity: 'error', source: 'runtime' });
  });

  try {
    const api = window.langdu;
    if (api && typeof api.onHotkeyConflict === 'function') {
      api.onHotkeyConflict((payload) => {
        const acc = (payload && payload.accelerator) || 'F1';
        record(`热键 ${acc} 被其他程序占用，选中朗读暂不可用`, { severity: 'warning', source: 'hotkey' });
      });
    }
  } catch (e) {
    /* 桥未就绪时跳过，不影响其他钩子 */
  }
}

installGlobalHooks();

export default { record, clear, getAll, subscribe, formatTime, STATUS_HISTORY_MAX };
