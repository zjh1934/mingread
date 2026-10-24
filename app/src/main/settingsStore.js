// 应用设置持久化（userData/settings.json）
// v2.3：settings.json 是 hotkey / clipboardAuto / floatBallEnabled / floatBallPos 的系统设置权威源。
//       默认唯一热键 F1；启动时把 v2.0 遗留的旧默认热键（Control+Alt+S）迁移为 F1 并立即落盘。
// v2.3.1（无障碍基线 P1-9 / P2-11）：
//       - 默认热键改为 Ctrl+Alt+R（F1 是 Windows 通用「帮助」键，语义冲突，仅保留为可选预设）；
//       - 复制即读 clipboardAuto 默认开（低视力用户看清屏幕文字费劲，是刚需）；
//       - 旧配置兼容：仅当已存值等于历史默认值（F1 / Control+Alt+S）时才迁移为新默认，
//         用户自选热键一律保留，不强行改掉。
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../shared/constants');
// v2.3 屏幕缩放（LensZoom 集成）：默认值从 zoomController 引入，保持单一来源
const { ZOOM_DEFAULTS } = require('./zoomController');

let _settingsPath = null;

/** v2.3.1 默认热键（基线 P2-11）：Ctrl+Alt+R。F1 仅作为设置里的可选预设保留 */
const DEFAULT_HOTKEY = 'Ctrl+Alt+R';
/** 历史默认热键：见到它一律迁移为新默认（用户自选值不在其列，保留不动） */
const LEGACY_DEFAULT_HOTKEYS = ['F1', 'Control+Alt+S'];

function settingsPath() {
  if (!_settingsPath) {
    // eslint-disable-next-line global-require
    const { app } = require('electron');
    _settingsPath = path.join(app.getPath('userData'), 'settings.json');
  }
  return _settingsPath;
}

/** 测试注入路径（避免依赖 Electron app） */
function _setSettingsPathForTest(p) {
  _settingsPath = p;
}

function defaults() {
  return {
    edgeEnabled: C.EDGE_FALLBACK_DEFAULT,
    autoFallback: true,
    voiceId: C.DEFAULT_VOICE_ID,
    rate: C.RATE_DEFAULT,
    pitch: C.PITCH_DEFAULT,
    volume: C.VOLUME_DEFAULT,
    theme: 'auto',
    // v2.3.1：默认热键 Ctrl+Alt+R（基线 P2-11，F1 仅留作可选预设）
    hotkey: DEFAULT_HOTKEY,
    // v2.3.1 剪贴板「复制即读」：低视力场景刚需，默认开（基线 P1-9），带节流与长度上限；
    // 用户可在设置里关掉（存了 false 的老配置不受影响）
    clipboardAuto: true,
    // 桌面悬浮球（鼠标入口），默认开
    floatBallEnabled: true,
    // 悬浮球位置 {x,y} | null（null = 默认右下角）
    floatBallPos: null,
    msEulaAccepted: false,
    // v2.3 屏幕缩放（复刻 macOS 缩放）：zoomEnabled/zoomModifier/zoomFollowMode/zoomMin/
    // zoomMax/zoomInteger/zoomSmoothing/zoomSwallowScroll/zoomClickThrough/zoomShowHud/zoomFrameLimit
    ...ZOOM_DEFAULTS,
    // 触发模式：auto = 有 koffi/uiohook 用滚轮、都没有则自动降级热键；hotkey = 强制热键
    zoomTrigger: 'auto',
    // α-视觉增强（低视力）：字号档位 1 / 1.25 / 1.5 / 2，桌面悬浮球尺寸 56 / 80 / 112
    fontScale: 1,
    floatBallSize: 56,
  };
}

/** 把合并后的设置写回磁盘（迁移/修正在 load 阶段同步生效） */
function persist(merged) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function getSettings() {
  const d = defaults();
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const merged = { ...d, ...j };
    // 启动迁移：热键为空或等于历史默认值（F1 / Control+Alt+S）→ Ctrl+Alt+R，并立即持久化一次。
    // 用户自选值（如 Ctrl+Alt+F1）不在 LEGACY_DEFAULT_HOTKEYS 里，原样保留
    if (!merged.hotkey || LEGACY_DEFAULT_HOTKEYS.indexOf(merged.hotkey) !== -1) {
      merged.hotkey = DEFAULT_HOTKEY;
      persist(merged);
    }
    return merged;
  } catch (e) {
    // 文件不存在/损坏：返回默认值（hotkey 已是 Ctrl+Alt+R，无需迁移）
    return d;
  }
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  persist(next);
  return next;
}

module.exports = { getSettings, saveSettings, _setSettingsPathForTest };
