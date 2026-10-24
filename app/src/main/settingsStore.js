// 应用设置持久化（userData/settings.json）
// v2.3：settings.json 是 hotkey / clipboardAuto / floatBallEnabled / floatBallPos 的系统设置权威源。
// v2.4.0（用户 2026-10-24 明确要求）：默认热键回到 F1（"选中文字按 F1 即读"），推翻 v2.3.1 的
//       Ctrl+Alt+R 默认（基线 P2-11 的"帮助键语义冲突"顾虑让位于用户明确意愿；Ctrl+Alt+R 降为备选）。
//       复制即读 clipboardAuto 默认开（低视力用户看清屏幕文字费劲，是刚需）。
//       旧配置兼容：仅当已存值等于历史默认值（Control+Alt+S / Ctrl+Alt+R）时才迁移为新默认 F1，
//       用户自选热键一律保留，不强行改掉。
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../shared/constants');
// v2.3 屏幕缩放默认值：从 shared/zoomDefaults 引入（单一来源）。
// 注意不要改回 require('./zoomController')：那会让设置层反向依赖控制器，
// 与 zoomController → a11yFeedback → ttsBridge → … → settingsStore 组成循环依赖。
const { ZOOM_DEFAULTS } = require('../shared/zoomDefaults');

let _settingsPath = null;

/** v2.4.0 默认热键：F1（用户明确要求；Ctrl+Alt+R 为备选预设） */
const DEFAULT_HOTKEY = 'F1';
/** 历史默认热键：见到它一律迁移为新默认（用户自选值不在其列，保留不动） */
const LEGACY_DEFAULT_HOTKEYS = ['Control+Alt+S', 'Ctrl+Alt+R'];

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
    // v2.4.0：默认热键 F1（用户明确要求，Ctrl+Alt+R 为备选）
    hotkey: DEFAULT_HOTKEY,
    // v2.3.1 剪贴板「复制即读」：低视力场景刚需，默认开（基线 P1-9），带节流与长度上限；
    // 用户可在设置里关掉（存了 false 的老配置不受影响）
    clipboardAuto: true,
    // v2.4.0：按热键时的「滴」提示音。默认**关**——用户反馈「选中以后按完热键它会滴的一声，
    // 这一声没有必要」：本地引擎 150ms 就出声，提示音反而像干扰；无声选区时也有语音播报兜底。
    // 需要即时确认感的用户可在 设置 → 常用 里打开。
    hotkeyCue: false,
    // v3.2 朗读方式：'hotkey' 选中后按热键 | 'hover' 指针停在文字上自动读。
    // 默认热键——它是这个产品的主用法，也是用户已经形成的习惯；
    // 悬停需要用户主动选择（它更"自动"，误触风险也更高）。
    readMode: 'hotkey',
    // 悬停停多久触发（毫秒）。650ms 是「明显停住」但又不让人觉得迟钝的折中。
    hoverDelayMs: 650,
    // v3.2.1 悬停「详细度」，对齐 macOS Hover Text 的 Low/Medium/High：
    //   low 只读指针所在那一句 / medium 读整段（默认）/ high 读本段+后续
    hoverDetail: 'medium',
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
    // W-VOICESRC 音色源：用户自己添加的仓库（[{id, kind:'url'|'file', location, name}]）。
    // 内置源不进这里（它由 voicePackSources 的 pin 提供），所以空数组 = 只有内置源。
    voiceSources: [],
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
    // 启动迁移：热键为空或等于历史默认值（Control+Alt+S / Ctrl+Alt+R）→ F1，并立即持久化一次。
    // 用户自选值（如 Ctrl+Alt+F1 / Shift+F1）不在 LEGACY_DEFAULT_HOTKEYS 里，原样保留
    if (!merged.hotkey || LEGACY_DEFAULT_HOTKEYS.indexOf(merged.hotkey) !== -1) {
      merged.hotkey = DEFAULT_HOTKEY;
      persist(merged);
    }
    return merged;
  } catch (e) {
    // 文件不存在/损坏：返回默认值（hotkey 已是 F1，无需迁移）
    return d;
  }
}

function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  persist(next);
  return next;
}

module.exports = { getSettings, saveSettings, _setSettingsPathForTest };
