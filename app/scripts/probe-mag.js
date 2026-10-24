// 放大镜后端可行性探针（阶段 0，只读为主）。
//
// 目的：验证 koffi 能否驱动 Windows Magnification API。这是「用系统合成器替代覆盖层抓屏」
// 方案的唯一硬前提 —— 如果这里不通，整个 Magnification 路线作废，不必再投入。
//
// 安全设计（重要）：
//   · 默认 --readonly：只做 MagInitialize / MagGetFullscreenTransform / MagUninitialize，
//     **不改变**系统放大状态，不会让用户桌面卡在放大态。
//   · --set：额外做一次「放大到 1.5x → 读回 → 立刻复位 1.0」，全程 try/finally + 进程退出前复位。
//
// 用法（PowerShell 工具）：
//   node scripts/probe-mag.js                # 只读
//   node scripts/probe-mag.js --set          # 读 + 短暂放大并复位
'use strict';

const SET_MODE = process.argv.includes('--set');

const out = {
  at: new Date().toISOString(),
  mode: SET_MODE ? 'read-write' : 'readonly',
  dllLoaded: false,
  initialized: false,
  before: null,
  setResult: null,
  afterSet: null,
  restored: null,
  uninitialized: null,
  error: null,
};

let mag = null;
let api = null;
let initialized = false;

function safeUninit() {
  try {
    if (initialized && api && api.MagUninitialize) {
      out.uninitialized = !!api.MagUninitialize();
      initialized = false;
    }
  } catch (e) {
    out.uninitError = (e && e.message) || String(e);
  }
}

function restoreTo1x() {
  try {
    if (api && api.MagSetFullscreenTransform) {
      out.restored = !!api.MagSetFullscreenTransform(1.0, 0, 0);
    }
  } catch (e) {
    out.restoreError = (e && e.message) || String(e);
  }
}

try {
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  mag = koffi.load('Magnification.dll'); // 系统自带（System32），无需分发
  out.dllLoaded = true;

  api = {
    MagInitialize: mag.func('bool MagInitialize()'),
    MagUninitialize: mag.func('bool MagUninitialize()'),
    MagSetFullscreenTransform: mag.func('bool MagSetFullscreenTransform(float magLevel, int xOffset, int yOffset)'),
    MagGetFullscreenTransform: mag.func('bool MagGetFullscreenTransform(float *magLevel, int *xOffset, int *yOffset)'),
  };

  initialized = !!api.MagInitialize();
  out.initialized = initialized;
  if (!initialized) throw new Error('MagInitialize 返回 false');

  // ---- 读当前全屏放大状态（不改）----
  {
    const lv = [0];
    const ox = [0];
    const oy = [0];
    const ok = api.MagGetFullscreenTransform(lv, ox, oy);
    out.before = { ok: !!ok, level: lv[0], x: ox[0], y: oy[0] };
  }

  // ---- 可选：短暂放大并立刻复位 ----
  if (SET_MODE) {
    out.setResult = !!api.MagSetFullscreenTransform(1.5, 0, 0);
    const lv = [0];
    const ox = [0];
    const oy = [0];
    const ok = api.MagGetFullscreenTransform(lv, ox, oy);
    out.afterSet = { ok: !!ok, level: lv[0], x: ox[0], y: oy[0] };

    restoreTo1x();
    const lv2 = [0];
    const ox2 = [0];
    const oy2 = [0];
    const ok2 = api.MagGetFullscreenTransform(lv2, ox2, oy2);
    out.afterRestore = { ok: !!ok2, level: lv2[0] };
  }
} catch (e) {
  out.error = (e && e.message) || String(e);
} finally {
  // 无论成败都复位 + 反初始化，避免桌面卡在放大态
  if (SET_MODE) restoreTo1x();
  safeUninit();
}

// 判定：DLL 加载 + 初始化成功 + 能读到倍率，三者齐备才算「路线可行」
out.verdict =
  out.dllLoaded && out.initialized && out.before && out.before.ok
    ? out.mode === 'read-write' && out.afterSet
      ? out.afterSet.level === 1.5 && out.afterRestore && out.afterRestore.level === 1
        ? 'PASS'
        : 'PARTIAL'
      : 'PASS'
    : 'FAIL';

console.log(JSON.stringify(out, null, 2));
try {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'dist', 'probe');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mag-probe.json'), JSON.stringify(out, null, 2), 'utf8');
} catch (e) {
  /* noop */
}
process.exit(out.verdict === 'FAIL' ? 1 : 0);
