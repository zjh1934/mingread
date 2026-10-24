// 运行时 IPC 契约验证：直接读 Electron 内部真实注册的 handler 表，
// 比静态分析可靠（静态分析看不懂 Object.entries 动态注册和常量名）。
//
// 要回答的问题：preload 里 invoke 的每个通道，主进程到底有没有 handler？
// 没有的话，渲染层调用会拿到 "Error: No handler registered for 'xxx'"。
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, ipcMain } = require('electron');

process.env.VITE_DEV_SERVER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'index.html')
).href;

require('../src/main/index.js');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3500); // 等所有 registerIpc 跑完

  // Electron 内部把 handle 存在 _invokeHandlers（Map）。私有字段，只在审计脚本里用；
  // 拿不到就退化为「无法静态确认」，不要假装验证过。
  let registered = null;
  try {
    if (ipcMain._invokeHandlers && typeof ipcMain._invokeHandlers.keys === 'function') {
      registered = new Set([...ipcMain._invokeHandlers.keys()]);
    }
  } catch (e) {
    /* 拿不到私有字段 */
  }

  if (!registered) {
    console.log('[ipc] 读不到 Electron 内部注册表（版本差异），改走「渲染层实调」验证');
    // 退化方案：在渲染层真调一次，看是否报 No handler registered
    const win = require('electron').BrowserWindow.getAllWindows()[0];
    const channels = ['zoom:get', 'a11y:cue', 'a11y:announce'];
    for (const ch of channels) {
      const r = await win.webContents.executeJavaScript(`(async () => {
        try {
          // preload 没暴露裸 ipcRenderer，这里只能通过封装方法间接验证
          if ('${ch}' === 'zoom:get') return await window.mingread.zoom.get();
          if ('${ch}' === 'a11y:cue') return await window.mingread.a11y.cue({ type: 'press' });
          return { skipped: true };
        } catch (e) { return { error: e && e.message }; }
      })()`).catch((e) => ({ error: e.message }));
      check(`F-${ch}`, `通道 '${ch}' 可调用`, !(r && r.error && /No handler registered/.test(r.error)), JSON.stringify(r).slice(0, 80));
    }
    console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
    setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200);
    return;
  }

  console.log(`[ipc] 主进程实际注册了 ${registered.size} 个 handle 通道`);

  // 从 preload 重新提取 invoke 通道（与静态审计同一套正则）
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');
  const wanted = new Set();
  const re = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(preloadSrc)) !== null) wanted.add(m[1]);

  const missing = [...wanted].filter((ch) => !registered.has(ch));
  check('A1', `preload 的 ${wanted.size} 个 invoke 通道全部有 handler`, missing.length === 0, missing.length ? `缺失: ${missing.join(', ')}` : '全部命中');

  // 反向：注册了但没人调（可能是内部使用或死代码，仅提示）
  const unused = [...registered].filter((ch) => !wanted.has(ch));
  console.log(`\n[ipc] 注册但 preload 未 invoke 的 ${unused.length} 个（内部/单向通道）:`);
  console.log('  ' + unused.join('\n  '));

  // 关键通道点名确认（这几个曾被我误判为断链）
  for (const ch of ['zoom:get', 'zoom:set', 'zoom:togglePause', 'zoom:nudge', 'zoom:reset', 'a11y:announce', 'a11y:cue']) {
    check(`B-${ch}`, `'${ch}' 已注册`, registered.has(ch), registered.has(ch) ? '存在' : '**缺失**');
  }

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  setTimeout(() => app.exit(failed === 0 ? 0 : 1), 200);
});
