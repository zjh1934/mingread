// 系统鼠标指针大小：读当前值 + 一键打开系统的指针设置界面
//
// 定位：**程序不改系统设置，只负责把你送到系统那个界面**。
// 理由：
//   1. 低视力用户找不到「设置 → 轻松使用 → 鼠标指针」这条路，这才是真痛点；
//   2. 直接改注册表（CursorBaseSize）虽然可行，但绕过了系统 UI，用户之后
//      想再调就找不到地方，也不知道是自己改的；
//   3. 各系统都有成熟的可视化调节（带实时预览），交给它更稳。
//
// 各平台入口（这是「适配主流操作系统」的落点）：
//   Windows  ms-settings:easeofaccess-cursorandpointersize（设置 → 轻松使用 → 鼠标指针）
//   macOS    x-apple.systempreferences:com.apple.Accessibility-Display-Settings.extension
//            （系统设置 → 辅助功能 → 显示 → 指针）
//   Linux    gnome-control-center universal-access（仅 GNOME；其他桌面如实报不支持）
//
// 读当前值只为「界面上告诉用户现在多大」，不写任何系统设置。
'use strict';

const { execFileSync } = require('child_process');

const PLATFORM = process.platform;

// 档位表：用于把实际像素值翻译成人话
const WIN_LEVELS = [
  { size: 32, label: '标准' },
  { size: 48, label: '较大' },
  { size: 64, label: '大' },
  { size: 96, label: '特大' },
];
const MAC_LEVELS = [
  { size: 1, label: '标准' },
  { size: 1.5, label: '较大' },
  { size: 2, label: '大' },
  { size: 3, label: '特大' },
];
const LINUX_LEVELS = [
  { size: 24, label: '标准' },
  { size: 32, label: '较大' },
  { size: 48, label: '大' },
  { size: 64, label: '特大' },
];

function levels() {
  if (PLATFORM === 'win32') return WIN_LEVELS;
  if (PLATFORM === 'darwin') return MAC_LEVELS;
  return LINUX_LEVELS;
}

function nearestLevel(size) {
  const arr = levels();
  let best = 0;
  let bestDiff = Infinity;
  arr.forEach((lv, i) => {
    const d = Math.abs(Number(lv.size) - Number(size));
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------
// Windows：koffi 直读注册表
// ---------------------------------------------------------------------------
// 为什么不用 reg.exe：部分机器（含本机）的安全策略把 reg.exe 列入程序黑名单，
// 直接 spawn 会被拦。advapi32 是系统 DLL，任何策略下都在。
// 注意 koffi 的 _Inout_：lpType / lpcbData 是「进有初值、出有结果」，
// 写成 _Out_ 会被清零，导致调用返回 ERROR_MORE_DATA(234)、永远读不到值。
const REG_SUBKEY = 'Control Panel\\Cursors';
const REG_VALUE = 'CursorBaseSize';
const HKEY_CURRENT_USER = 0x80000001n;
const KEY_QUERY_VALUE = 0x0001;
const REG_DWORD = 4;

let _winApi = null;
function winApi() {
  if (_winApi) return _winApi;
  // eslint-disable-next-line global-require
  const koffi = require('koffi');
  const advapi32 = koffi.load('advapi32.dll');
  _winApi = {
    RegOpenKeyExW: advapi32.func(
      'long RegOpenKeyExW(void *hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ void **phkResult)'
    ),
    RegQueryValueExW: advapi32.func(
      'long RegQueryValueExW(void *hKey, str16 lpValueName, void *lpReserved, _Inout_ uint32 *lpType, _Out_ uint8 *lpData, _Inout_ uint32 *lpcbData)'
    ),
    RegCloseKey: advapi32.func('long RegCloseKey(void *hKey)'),
  };
  return _winApi;
}

function winRead() {
  try {
    const api = winApi();
    const phk = [null];
    if (api.RegOpenKeyExW(HKEY_CURRENT_USER, REG_SUBKEY, 0, KEY_QUERY_VALUE, phk) !== 0) return 32;
    const hk = phk[0];
    const typeOut = [0];
    const buf = Buffer.alloc(8);
    const lenOut = [8];
    const rc = api.RegQueryValueExW(hk, REG_VALUE, null, typeOut, buf, lenOut);
    api.RegCloseKey(hk);
    if (rc === 0 && typeOut[0] === REG_DWORD && lenOut[0] >= 4) return buf.readUInt32LE(0);
  } catch (e) {
    /* 读不到 = 从未改过，系统默认 32 */
  }
  return 32;
}

// ---------------------------------------------------------------------------
// macOS / Linux
// ---------------------------------------------------------------------------
function macRead() {
  try {
    const out = execFileSync('defaults', ['read', 'com.apple.universalaccess', 'mouseDriverCursorSize'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const n = parseFloat(out.trim());
    return Number.isFinite(n) ? n : 1;
  } catch (e) {
    return 1;
  }
}

function linuxRead() {
  try {
    const out = execFileSync('gsettings', ['get', 'org.gnome.desktop.interface', 'cursor-size'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : 24;
  } catch (e) {
    return null; // 非 GNOME 或没装 gsettings
  }
}

function readRaw() {
  if (PLATFORM === 'win32') return winRead();
  if (PLATFORM === 'darwin') return macRead();
  return linuxRead();
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------
/**
 * 当前指针大小状态（只读，不改系统）
 * @returns {{platform:string, supported:boolean, size:number|null, levelIndex:number,
 *            levelCount:number, label:string, levels:Array, hint:string}}
 */
function getState() {
  const arr = levels();
  const size = readRaw();
  const supported = size !== null && size !== undefined;
  const idx = supported ? nearestLevel(size) : 0;
  return {
    platform: PLATFORM,
    supported,
    size: supported ? size : null,
    levelIndex: idx,
    levelCount: arr.length,
    label: supported ? arr[idx].label : '未知',
    levels: arr.map((l) => ({ size: l.size, label: l.label })),
    hint:
      PLATFORM === 'win32'
        ? '会打开 Windows 设置里的「鼠标指针」页，那里能实时预览并调大小'
        : PLATFORM === 'darwin'
          ? '会打开系统设置 → 辅助功能 → 显示 → 指针'
          : '会尝试打开 GNOME 辅助功能设置',
  };
}

/**
 * 系统「鼠标指针大小」设置页的打开方式。
 * 返回 { ok, uri, scheme, fallback, message }
 * 调用方（IPC 层）拿 uri 去 shell.openExternal。
 */
function settingsTarget() {
  if (PLATFORM === 'win32') {
    return {
      ok: true,
      // Windows 10 1809+ / 11 的「轻松使用 → 鼠标指针」页
      uri: 'ms-settings:easeofaccess-cursorandpointersize',
      // Win7/极简系统没有 ms-settings 时的兜底：传统控制面板的鼠标属性
      fallback: 'control.exe',
      message: '正在打开系统设置里的鼠标指针页面',
    };
  }
  if (PLATFORM === 'darwin') {
    return {
      ok: true,
      uri: 'x-apple.systempreferences:com.apple.Accessibility-Display-Settings.extension',
      fallback: '',
      message: '正在打开系统设置 → 辅助功能 → 显示',
    };
  }
  return {
    ok: true,
    uri: '',
    fallback: 'gnome-control-center universal-access',
    message: '正在打开桌面环境的辅助功能设置',
  };
}

module.exports = { getState, settingsTarget };
