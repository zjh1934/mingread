// 全局键盘钩子（WH_KEYBOARD_LL 低级键盘钩子）——F1 的「旁路捕获层」。
//
// 为什么需要它：Electron 的 globalShortcut 走 RegisterHotKey，该 API 是**独占**的。
// 只要别的程序（网吧管理客户端、旧版朗读女、输入法工具条等）先注册了 F1，
// 我们的 globalShortcut.register('F1') 就必然失败，且没有任何重试能补救。
// 而低级键盘钩子挂在系统输入分发链的最前端，即使热键已被别的进程独占，
// 钩子依然能收到 WM_KEYDOWN —— 这正是「用户按 F1 就必须出声」的兜底路径。
//
// 设计约束（三条都是硬性的）：
//   1. **永不吞事件**：一律 CallNextHookEx 放行。我们只旁听，不改变系统行为，
//      也不做任何键盘内容记录（只比对 vkCode 是否等于目标键）。
//   2. **回调必须极轻**：低级钩子有 300ms 超时，超时会被系统静默摘除（且不报错）。
//      回调里只做「时间戳去重 + setImmediate 派发」，绝不同步做 IO / 合成 / IPC。
//   3. **可缺省**：koffi（FFI 原生模块，MIT 许可，N-API 跨 ABI）不可用时
//      isSupported() 返回 false，调用方回落到原有的「冲突播报 + 自动重试」链路，
//      功能降级但绝不崩。
//
// 生命周期：常驻安装，进程退出时随进程结束（不必显式卸载，但提供 stop()）。
'use strict';

const IS_WIN = process.platform === 'win32';

/** 低级键盘钩子 ID（WinUser.h: WH_KEYBOARD_LL = 13） */
const WH_KEYBOARD_LL = 13;
const WM_KEYDOWN = 0x0100;
const WM_SYSKEYDOWN = 0x0104;
/** 默认监听的键：F1 */
const VK_F1 = 0x70;
/** 同一次按下的去重窗口（自动重复会连发 keydown） */
const DEDUP_MS = 250;

/** @type {null | {error?:string, ok?:object}} */
let apiCache = null;
/** koffi 的 register 句柄：只注册一次，start/stop 反复复用 */
let hookProcBinding = null;

const state = {
  /** @type {any} 钩子句柄 */
  hook: null,
  active: false,
  backend: 'none', // 'koffi' | 'none'
  error: null,
  /** @type {null | ((e:{vkCode:number,at:number,source:string})=>void)} */
  handler: null,
  lastDownAt: 0,
  /** 统计：便于诊断「钩子到底收到没有」 */
  stats: { keyDownSeen: 0, targetHits: 0, dispatched: 0, lastHitAt: 0 },
};

/**
 * 加载 user32 函数。失败不抛：把错误存进 apiCache.error，调用方据此降级。
 * 结构体/proto 名字带 LDN_ 前缀，避免与 zoomController 的 koffi 注册名冲突
 * （koffi 对同名 struct/proto 重复注册会抛错）。
 */
function loadApi() {
  if (apiCache) return apiCache;
  if (!IS_WIN) {
    apiCache = { error: 'not-windows' };
    return apiCache;
  }
  try {
    // eslint-disable-next-line global-require
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // KBDLLHOOKSTRUCT：vkCode 为目标键的虚拟键码
    const KBDLLHOOKSTRUCT = koffi.struct('LDN_KBDLLHOOKSTRUCT', {
      vkCode: 'uint32',
      scanCode: 'uint32',
      flags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uint64',
    });
    const HOOKPROC = koffi.proto('int64 __stdcall LDN_HOOKPROC(int nCode, uint64 wParam, void *lParam)');
    apiCache = {
      ok: {
        koffi,
        KBDLLHOOKSTRUCT,
        HOOKPROC,
        SetWindowsHookExW: user32.func(
          'void *SetWindowsHookExW(int idHook, void *lpfn, void *hmod, uint32 dwThreadId)'
        ),
        UnhookWindowsHookEx: user32.func('int UnhookWindowsHookEx(void *hhk)'),
        CallNextHookEx: user32.func('int64 CallNextHookEx(void *hhk, int nCode, uint64 wParam, void *lParam)'),
      },
    };
  } catch (e) {
    apiCache = { error: (e && e.message) || String(e) };
  }
  return apiCache;
}

/** koffi 是否可用（不实际安装钩子）。用于状态展示与降级判断。 */
function isSupported() {
  const api = loadApi();
  return !!(api && api.ok);
}

function currentError() {
  const api = loadApi();
  return (api && api.error) || state.error || null;
}

/**
 * 安装钩子。
 * @param {(e:{vkCode:number,at:number,source:string})=>void} onKeyDown 目标键按下回调（已在 setImmediate 中执行）
 * @param {{vkCode?:number}} [opts]
 * @returns {boolean} 是否安装成功
 */
function start(onKeyDown, opts = {}) {
  const vkCode = typeof opts.vkCode === 'number' ? opts.vkCode : VK_F1;
  if (typeof onKeyDown !== 'function') {
    state.error = 'handler-required';
    return false;
  }
  if (state.active) {
    state.handler = onKeyDown; // 已装：热切换回调即可
    return true;
  }
  const api = loadApi();
  if (!api.ok) {
    state.error = api.error;
    return false;
  }

  try {
    if (!hookProcBinding) {
      hookProcBinding = api.ok.koffi.register((nCode, wParam, lParam) => {
        try {
          // nCode < 0 表示必须直接放行（Win32 约定）
          if (nCode === 0 && (wParam === WM_KEYDOWN || wParam === WM_SYSKEYDOWN)) {
            const st = api.ok.koffi.decode(lParam, api.ok.KBDLLHOOKSTRUCT);
            if (st) {
              state.stats.keyDownSeen += 1;
              if (st.vkCode === vkCode) {
                const now = Date.now();
                if (now - state.lastDownAt > DEDUP_MS) {
                  state.lastDownAt = now;
                  state.stats.targetHits += 1;
                  state.stats.lastHitAt = now;
                  const fn = state.handler;
                  if (fn) {
                    // 绝不在钩子栈里做重活：系统只给 300ms
                    setImmediate(() => {
                      try {
                        state.stats.dispatched += 1;
                        fn({ vkCode: st.vkCode, at: now, source: 'hook' });
                      } catch (e) {
                        /* 回调异常不外抛 */
                      }
                    });
                  }
                }
              }
            }
          }
        } catch (e) {
          /* 钩子内任何异常都必须吞掉，否则会被系统摘除 */
        }
        return api.ok.CallNextHookEx(state.hook, nCode, wParam, lParam);
      }, api.ok.koffi.pointer(api.ok.HOOKPROC));
    }

    state.handler = onKeyDown;
    // hMod 传 null：WH_KEYBOARD_LL 是全局低级钩子，不需要 DLL 注入
    state.hook = api.ok.SetWindowsHookExW(WH_KEYBOARD_LL, hookProcBinding, null, 0);
    if (!state.hook) {
      state.error = 'SetWindowsHookExW-failed';
      state.backend = 'none';
      return false;
    }
    state.active = true;
    state.backend = 'koffi';
    state.error = null;
    return true;
  } catch (e) {
    state.error = (e && e.message) || String(e);
    state.backend = 'none';
    return false;
  }
}

function stop() {
  if (!state.active) return;
  const api = loadApi();
  try {
    if (api.ok && state.hook) api.ok.UnhookWindowsHookEx(state.hook);
  } catch (e) {
    /* noop */
  }
  state.hook = null;
  state.active = false;
  state.backend = 'none';
}

function getState() {
  return {
    supported: isSupported(),
    active: state.active,
    backend: state.backend,
    error: currentError(),
    stats: { ...state.stats },
  };
}

module.exports = { start, stop, getState, isSupported, currentError, VK_F1, VK_DEFAULT: VK_F1 };
