// 缩放覆盖层窗口的预加载脚本（contextIsolation: true, sandbox: false）
//
// 链路（Electron 32）：desktopCapturer 只在主进程可用 →
//   覆盖层向主进程要 sourceId（zoom:getSource）→ 本进程 getUserMedia 取流 → 挂到 <video id="screen">。
//   MediaStream 无法跨 contextBridge 传递，所以直接在预加载里挂 srcObject。
//
// v2.3 集成改造（相对 LensZoom 毛坯）：
//   - 新增 onActivate / onDisplayChanged：主进程在激活/跨显示器迁移时通知覆盖层重新取流；
//   - startCapture 幂等：重复调用先停旧流再取新流，避免多屏切换后黑屏或双流占用。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zoomAPI', {
  /**
   * 向主进程索取指定显示器的 screen source id，然后在本地取流并挂到 <video id="screen">。
   * 重复调用会先停掉旧流，保证多显示器切换时画面正确。
   */
  startCapture: async (displayId) => {
    try {
      const video = document.getElementById('screen');
      if (video && video.srcObject) {
        try {
          video.srcObject.getTracks().forEach((t) => t.stop());
        } catch (e) { /* noop */ }
        video.srcObject = null;
      }
      const sourceId = await ipcRenderer.invoke('zoom:getSource', displayId);
      if (!sourceId) return { ok: false, error: '主进程没有返回可用的屏幕源' };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            minFrameRate: 30,
            maxFrameRate: 60,
          },
        },
      });
      if (video) {
        video.srcObject = stream;
        try {
          await video.play();
        } catch (e) { /* 自动播放策略下 muted 仍可能延迟，忽略 */ }
      }
      return { ok: true, sourceId };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  },

  // 主进程每帧推来的状态：{zoom, originX, originY, width, height, showHud, fps, integer}
  onState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('zoom:state', listener);
    return () => ipcRenderer.removeListener('zoom:state', listener);
  },

  // v2.3：主进程通知「某显示器上激活了缩放」，载荷 {displayId}
  onActivate: (cb) => {
    const listener = (_e, payload) => cb(payload || {});
    ipcRenderer.on('zoom:activate', listener);
    return () => ipcRenderer.removeListener('zoom:activate', listener);
  },

  // v2.3：主进程检测到光标跨到另一显示器，载荷 {displayId} → 重新取流
  onDisplayChanged: (cb) => {
    const listener = (_e, payload) => cb(payload || {});
    ipcRenderer.on('zoom:display-changed', listener);
    return () => ipcRenderer.removeListener('zoom:display-changed', listener);
  },

  // v2.3：退出缩放 → 停流（覆盖层窗口随后被隐藏）
  onDeactivate: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('zoom:deactivate', listener);
    return () => ipcRenderer.removeListener('zoom:deactivate', listener);
  },

  reportError: (msg) => ipcRenderer.send('zoom:error', String(msg)),
});
