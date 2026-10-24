// 预加载脚本：仅经 contextBridge 暴露白名单 API（nodeIntegration:false / contextIsolation:true）。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 音色与合成
  getVoices: () => ipcRenderer.invoke('tts:listVoices'),
  splitSentences: (text) => ipcRenderer.invoke('tts:splitSentences', { text }),
  synthesizeOne: (text, opts) => ipcRenderer.invoke('tts:synthOne', { text, opts }),
  synthesize: (text, opts) => ipcRenderer.invoke('tts:synthesize', { text, opts }),

  voice: {
    getStatus: () => ipcRenderer.invoke('voice:getStatus'),
    setVoiceId: (id) => ipcRenderer.invoke('voice:setVoiceId', id),
    savePrefs: (patch) => ipcRenderer.invoke('voice:savePrefs', patch || {}),
    refresh: () => ipcRenderer.invoke('voice:refresh'),
    preview: (payload) => ipcRenderer.invoke('voice:preview', payload || {}),
    onStatusChanged: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('voice:statusChanged', listener);
      return () => ipcRenderer.removeListener('voice:statusChanged', listener);
    },
  },

  // v2.4.0 离线语音一键部署（NVSA 本地引擎）：首启引导组件 VoiceDeployGate 用
  voiceDeploy: {
    getState: () => ipcRenderer.invoke('voice:deploy:getState'),
    detect: () => ipcRenderer.invoke('voice:deploy:detect'),
    install: () => ipcRenderer.invoke('voice:deploy:install'),
    /** W-VOICESRC：从音色源清单里装单个音色（key 见 list().voices[].key） */
    installVoice: (key) => ipcRenderer.invoke('voice:deploy:installVoice', key),
    onStateChanged: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('voice:deploy:state', listener);
      return () => ipcRenderer.removeListener('voice:deploy:state', listener);
    },
  },

  // W-VOICESRC 音色源：内置源 + 用户自建仓库（https 清单或本地 .json）
  voiceSources: {
    /** 载入并合并全部源（逐源降级：坏源只体现在 sources[].error / errors[]） */
    list: () => ipcRenderer.invoke('voice:source:list'),
    /** 丢弃缓存重新抓取（用户源改动后手动刷新） */
    refresh: () => ipcRenderer.invoke('voice:source:refresh'),
    /** 添加源：{ location: 'https://…/voices.json' } 或 { location: 'C:\\…\\voices.json', name? } */
    add: (payload) => ipcRenderer.invoke('voice:source:add', payload || {}),
    remove: (id) => ipcRenderer.invoke('voice:source:remove', id),
    /** 打开本地清单选择器，返回绝对路径或 null */
    pickFile: () => ipcRenderer.invoke('voice:source:pick'),
  },

  // 划词朗读
  readSelection: () => ipcRenderer.invoke('selection:read'),

  // 文件
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveDialog: (defaultName) => ipcRenderer.invoke('dialog:save', { defaultName }),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  setClipboardAuto: (v) => ipcRenderer.invoke('clipboard:auto', v),

  // 导出与字幕
  exportAudio: (payload) => ipcRenderer.invoke('tts:export', payload),
  subtitle: (sentences, format) => ipcRenderer.invoke('tts:subtitle', { sentences, format }),

  // 系统
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  setHotkey: (v) => ipcRenderer.invoke('settings:hotkey', v),

  // v2.2 系统设置（主进程 settings.json 为权威源）
  getSystemSettings: () => ipcRenderer.invoke('settings:getSystem'),
  saveSystemSettings: (patch) => ipcRenderer.invoke('settings:saveSystem', patch || {}),
  onSystemSettings: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('settings:system', listener);
    return () => ipcRenderer.removeListener('settings:system', listener);
  },
  /** 热键注册冲突：{accelerator} */
  onHotkeyConflict: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('hotkey:conflict', listener);
    return () => ipcRenderer.removeListener('hotkey:conflict', listener);
  },
  /** 渲染 → 主进程：播放状态上报（主进程节流后转发悬浮球） */
  reportPlaybackState: (s) => ipcRenderer.send('playback:reportState', s || {}),
  /** 悬浮球播放指令：{cmd:'play'|'pause'|'stop'|'prev'|'next'} */
  onPlaybackCmd: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('playback:cmd', listener);
    return () => ipcRenderer.removeListener('playback:cmd', listener);
  },

  // v2.2 桌面悬浮球
  floatBall: {
    cmd: (c) => ipcRenderer.send('floatBall:cmd', c),
    dragStart: () => ipcRenderer.send('floatBall:dragStart'),
    dragMove: (d) => ipcRenderer.send('floatBall:dragMove', d),
    dragEnd: () => ipcRenderer.send('floatBall:dragEnd'),
    onState: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('floatBall:state', listener);
      return () => ipcRenderer.removeListener('floatBall:state', listener);
    },
  },

  // v2.3 屏幕缩放（复刻 macOS 缩放，LensZoom 集成）
  zoom: {
    get: () => ipcRenderer.invoke('zoom:get'),
    set: (patch) => ipcRenderer.invoke('zoom:set', patch || {}),
    togglePause: () => ipcRenderer.invoke('zoom:togglePause'),
    nudge: (up) => ipcRenderer.invoke('zoom:nudge', !!up),
    reset: () => ipcRenderer.invoke('zoom:reset'),
    onChanged: (cb) => {
      const listener = (_e, payload) => cb(payload);
      ipcRenderer.on('zoom:changed', listener);
      return () => ipcRenderer.removeListener('zoom:changed', listener);
    },
  },

  // 主进程 → 渲染进程事件
  onClipboard: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('clipboard:new', listener);
    return () => ipcRenderer.removeListener('clipboard:new', listener);
  },
  /** F1 划词：{text, source:'selection'|'clipboard'|'none'} */
  onReadSelection: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('hotkey:read-selection', listener);
    return () => ipcRenderer.removeListener('hotkey:read-selection', listener);
  },
  onReadClipboard: (cb) => {
    const l = () => cb();
    ipcRenderer.on('hotkey:read-clipboard', l);
    return () => ipcRenderer.removeListener('hotkey:read-clipboard', l);
  },

  // v2.3 无障碍反馈（main 侧由 a11yFeedback.js 实现）
  a11y: {
    /** 语音播报：{text, priority:'high'|'normal'}；high 打断当前朗读，normal 排队 */
    announce: (payload) => ipcRenderer.invoke('a11y:announce', payload || {}),
    /** 非语音提示音：{type:'press'|'success'|'error'}，<100ms */
    cue: (payload) => ipcRenderer.invoke('a11y:cue', payload || {}),
  },
};

contextBridge.exposeInMainWorld('langdu', api);
// 同一份 a11y 契约另挂到 window.api，便于 renderer 侧按 window.api.a11y.* 调用
contextBridge.exposeInMainWorld('api', { a11y: api.a11y });
