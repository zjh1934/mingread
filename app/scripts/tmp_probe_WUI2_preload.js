// W-UI2 探针专用 preload：只为「速查卡」截图/自检提供最小桥，
// 不参与产品运行（产品用的是 src/preload/index.js）。
// 提供：getSystemSettings（验证热键从 store 读）+ a11y（验证展开时确实播报）。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('langdu', {
  getSystemSettings: () => ipcRenderer.invoke('probe:systemSettings'),
  onSystemSettings: () => () => {},
  reportPlaybackState: () => {},
  onPlaybackCmd: () => () => {},
  a11y: {
    announce: (p) => ipcRenderer.send('probe:a11y', { kind: 'announce', text: (p && p.text) || '', priority: (p && p.priority) || 'normal' }),
    cue: (p) => ipcRenderer.send('probe:a11y', { kind: 'cue', type: (p && p.type) || 'press' }),
  },
});
