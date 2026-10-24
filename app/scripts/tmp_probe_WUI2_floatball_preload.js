// W-UI2 探针专用 preload：模拟 window.langdu.floatBall 桥，记录悬浮球页面发出的每一个调用。
// 只用于自检，不参与产品运行。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('langdu', {
  floatBall: {
    cmd: (c) => ipcRenderer.send('probe:cmd', c),
    dragStart: () => ipcRenderer.send('probe:cmd', { evt: 'dragStart' }),
    dragMove: (d) => ipcRenderer.send('probe:cmd', { evt: 'dragMove', d }),
    dragEnd: () => ipcRenderer.send('probe:cmd', { evt: 'dragEnd' }),
    onState: (cb) => {
      ipcRenderer.on('probe:state', (_e, s) => cb(s));
      return () => {};
    },
  },
});
