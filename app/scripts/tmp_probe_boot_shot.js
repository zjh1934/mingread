// 验证「启动骨架」在窗口显示后确实存在，且只在 React 真正挂载后才移除。
// 关键：必须走打包路径（loadFile）。dev 分支会连 localhost:5173，探针环境下没有该服务，
// 会加载失败页 —— 第一次写这个探针就踩到了（骨架恒为 null）。
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');

const fileUrl = pathToFileURL(path.join(__dirname, '..', 'dist', 'renderer', 'index.html')).href;
process.env.VITE_DEV_SERVER_URL = fileUrl;

const mod = require('../src/main/index.js');

app.whenReady().then(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const probe = async (label) => {
    const win = mod.getMainWindow();
    if (!win) return console.log(`[${label}] no window`);
    try {
      const r = await win.webContents.executeJavaScript(`(() => {
        const b = document.getElementById('ldn-boot');
        const bar = b ? b.querySelector('.ldn-boot-bar') : null;
        const cs = b ? getComputedStyle(b) : null;
        const root = document.getElementById('root');
        return {
          skeleton: !!b,
          text: b ? b.innerText.replace(/\\s+/g, ' ').trim() : '',
          bg: cs ? cs.backgroundColor : '',
          barW: bar ? Math.round(bar.getBoundingClientRect().width) : 0,
          rootKids: root ? root.childElementCount : -1,
          rootText: root ? (root.innerText || '').trim().slice(0, 18) : '',
        };
      })()`);
      console.log(`[${label}] ${JSON.stringify(r)}`);
    } catch (e) {
      console.log(`[${label}] eval failed: ${e.message}`);
    }
  };

  await wait(1600);
  await probe('t1.6s');
  await wait(1200);
  await probe('t2.8s');
  await wait(1400);
  await probe('t4.2s');
  app.exit(0);
});
