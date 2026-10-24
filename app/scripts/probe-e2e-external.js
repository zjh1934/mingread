// E2E 探针 A：模拟「外部程序」——一个带可选择文字的独立窗口（等价浏览器/编辑器）。
// 用途：xdotool 在其窗口内鼠标拖选文字 → Ctrl+C 复制，验证主进程的
//   a) 复制即读（clipboardMonitor 检测剪贴板变化 → clipboard:new autoRead=true）
//   b) 划词热键（readSelection 向焦点窗口发 Ctrl+C 抓选区）
// 复制成功时打 [external] copied 日志，作为「外部程序真的执行了复制」的正向证据。
'use strict';

const { app, BrowserWindow } = require('electron');

const TEXT =
  '无障碍测试文本第一行：低视力用户复制即读。\n' +
  '第二行：热键按下两百毫秒内必须有反馈。\n' +
  '第三行：过长文本不应无脑朗读。';

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 640,
    height: 200,
    x: 60,
    y: 880,
    title: 'external-text',
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin:0; padding:18px; font:20px/1.7 sans-serif; background:#fff; color:#000; }
      #t { user-select:text; -webkit-user-select:text; }
    </style></head><body><div id="t">${TEXT.replace(/\n/g, '<br>')}</div>
    <script>
      document.addEventListener('copy', function () {
        var s = window.getSelection().toString();
        console.log('[external] copied len=' + s.length + ' head=' + s.slice(0, 12));
      });
    </script></body></html>`
  ));
  win.webContents.on('console-message', (_e, _l, msg) => console.log(msg));
  console.log('[external] ready');
});
