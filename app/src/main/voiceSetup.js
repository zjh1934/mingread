// 语音编排（精简版）：三级引擎链（本地 NVSA 优先 → espeak 验证专用 → Edge 在线兜底）的状态 base，
// 完整状态由 ttsBridge.getStatus() 覆盖合并；本模块另管 voiceId 持久化与 lastError 广播。
'use strict';

const C = require('../shared/constants');
const { getBridge } = require('./ttsBridge');
const { getSettings, saveSettings } = require('./settingsStore');

const _statusListeners = new Set();

function onStatusChanged(cb) {
  _statusListeners.add(cb);
  return () => _statusListeners.delete(cb);
}

function broadcastStatus() {
  const s = getStatus();
  for (const cb of _statusListeners) {
    try {
      cb(s);
    } catch (e) {
      /* 监听器异常不影响主流程 */
    }
  }
}

let _lastError = null;

function setLastError(err) {
  _lastError = err ? { message: err.message || String(err), at: Date.now() } : null;
  broadcastStatus();
}

function getStatus() {
  const bridge = getBridge();
  const settings = getSettings();
  const available = bridge.isAvailable();
  const voices = bridge.listVoices().map((v) => ({
    id: v.id,
    displayName: v.displayName,
    gender: v.gender,
    locale: v.locale,
    desc: v.desc,
    source: 'online',
    isDefault: !!v.isDefault,
    available,
  }));
  return {
    app: { name: C.APP_NAME, version: C.APP_VERSION },
    // 注意：engine 各字段均为占位默认值，ttsBridge.getStatus() 会用真实引擎状态整体覆盖
    engine: {
      id: 'edge',
      label: '语音引擎',
      online: true,
      ready: available,
      voiceCount: voices.length,
      detail: available ? '语音引擎就绪' : '合成组件不可用（缺少 node-edge-tts 依赖）',
      lastError: _lastError,
    },
    voices,
    voiceId: settings.voiceId,
    edgeEnabled: true,
    autoFallback: true,
    // 兼容旧字段（渲染层/自检脚本仍读这两个）
    offlineReady: false,
    tier: '',
    engines: [],
  };
}

function getPlatformInfo() {
  return {
    isWindows: process.platform === 'win32',
    platform: process.platform,
    arch: process.arch,
  };
}

function setVoiceId(voiceId) {
  const s = saveSettings({ voiceId: String(voiceId || C.DEFAULT_VOICE_ID) });
  broadcastStatus();
  return { ok: true, voiceId: s.voiceId };
}

function saveReadingPrefs(patch) {
  const cur = getSettings();
  const next = saveSettings({
    rate: patch.rate !== undefined ? patch.rate : cur.rate,
    pitch: patch.pitch !== undefined ? patch.pitch : cur.pitch,
    volume: patch.volume !== undefined ? patch.volume : cur.volume,
    hotkey: patch.hotkey !== undefined ? patch.hotkey : cur.hotkey,
    clipboardAuto: patch.clipboardAuto !== undefined ? patch.clipboardAuto : cur.clipboardAuto,
  });
  return { ok: true, settings: next };
}

function warmupVoiceSetup() {
  // 只做一次状态广播，不加载任何模型
  setImmediate(() => broadcastStatus());
}

module.exports = {
  getPlatformInfo,
  warmupVoiceSetup,
  getStatus,
  setVoiceId,
  saveReadingPrefs,
  setLastError,
  onStatusChanged,
  broadcastStatus,
};
