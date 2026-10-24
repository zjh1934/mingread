// 平台能力探测：回答"这台机器能不能抓系统选区、靠什么抓"。
//
// 设计原则（基线铁律 2：不要静默失败）：
//   探测结果必须能翻译成一句用户听得懂的原因，上层据此播报，而不是悄悄退化。
//
// 只做探测，不做动作；发键动作在 keystroke.js。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** 在 PATH 里找可执行文件，返回绝对路径；找不到返回 '' */
function findBin(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).concat([''])
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (e) {
        /* 继续找 */
      }
    }
  }
  return '';
}

/** 找到了还不算，真跑一次 --version 确认可执行（避免 PATH 里有残骸） */
function verifyBin(bin, args) {
  if (!bin) return false;
  try {
    execFileSync(bin, args, { timeout: 1500, stdio: 'pipe', input: '' });
    return true;
  } catch (e) {
    try {
      execFileSync(bin, [], { timeout: 1500, stdio: 'pipe', input: '' });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * @typedef {object} Capabilities
 * @property {string} platform          process.platform
 * @property {string} displayServer     'x11' | 'wayland' | 'gdi' | 'none'
 * @property {string} display           DISPLAY 环境变量值（X11）
 * @property {boolean} wayland          是否 Wayland 会话
 * @property {string} strategy          'x11-xdotool' | 'win32-sendkeys' | 'none'
 * @property {string} code              策略对应的状态码（见 CODE）
 * @property {string} reason            可直接播报给用户的中文原因
 * @property {boolean} captureOk        能否尝试抓选区
 * @property {{xdotool:string,xclip:string,xsel:string,powershell:string}} tools 绝对路径，'' 表示不可用
 * @property {string} clipReader        'xclip' | 'xsel' | 'electron'
 */

let _cache = null;

function detect(opts = {}) {
  if (_cache && !opts.force) return _cache;

  const platform = process.platform;
  const wayland = !!(process.env.WAYLAND_DISPLAY && String(process.env.WAYLAND_DISPLAY).trim());
  const display = String(process.env.DISPLAY || '').trim();

  const tools = { xdotool: '', xclip: '', xsel: '', powershell: '' };

  /** @type {Capabilities} */
  const caps = {
    platform,
    displayServer: 'none',
    display,
    wayland,
    tools,
    strategy: 'none',
    code: 'UNSUPPORTED_PLATFORM',
    reason: '',
    captureOk: false,
    clipReader: 'electron',
  };

  if (platform === 'win32') {
    caps.displayServer = 'gdi';
    tools.powershell = findBin('powershell.exe') || findBin('powershell');
    if (tools.powershell) {
      caps.strategy = 'win32-sendkeys';
      caps.code = 'OK';
      caps.reason = '';
      caps.captureOk = true;
    } else {
      caps.code = 'TOOL_MISSING';
      caps.reason = '未找到 PowerShell，无法抓取选区。';
    }
    _cache = caps;
    return caps;
  }

  if (platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd' && platform !== 'netbsd') {
    caps.code = 'UNSUPPORTED_PLATFORM';
    caps.reason = `当前系统（${platform}）暂不支持抓取系统选区。`;
    _cache = caps;
    return caps;
  }

  // ---- Linux / BSD ----
  tools.xdotool = findBin('xdotool');
  tools.xclip = findBin('xclip');
  tools.xsel = findBin('xsel');
  if (tools.xclip) caps.clipReader = 'xclip';
  else if (tools.xsel) caps.clipReader = 'xsel';

  if (!display && !wayland) {
    caps.displayServer = 'none';
    caps.code = 'NO_DISPLAY';
    caps.reason = '当前没有可用的图形显示服务（DISPLAY 为空），无法抓取选区。';
    _cache = caps;
    return caps;
  }

  if (wayland && !display) {
    caps.displayServer = 'wayland';
    caps.code = 'WAYLAND_UNSUPPORTED';
    caps.reason = '检测到 Wayland 会话，xdotool 无法注入按键，请在 X11（Xorg）会话下使用划词朗读。';
    _cache = caps;
    return caps;
  }

  caps.displayServer = 'x11';

  if (!tools.xdotool) {
    caps.code = 'TOOL_MISSING';
    caps.reason = '缺少 xdotool，无法抓取选区。请先安装：sudo apt install xdotool xclip';
    _cache = caps;
    return caps;
  }

  if (!verifyBin(tools.xdotool, ['--version'])) {
    caps.code = 'TOOL_MISSING';
    caps.reason = 'xdotool 不可执行（可能缺少 X11 权限或依赖），无法抓取选区。';
    _cache = caps;
    return caps;
  }

  // xclip / xsel 都缺也能跑（读剪贴板走 Electron 自身），只是少一条兜底通路
  caps.strategy = 'x11-xdotool';
  caps.code = 'OK';
  caps.reason = '';
  caps.captureOk = true;
  _cache = caps;
  return caps;
}

module.exports = { detect, findBin, verifyBin };
