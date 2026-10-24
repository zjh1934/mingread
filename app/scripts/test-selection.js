// Electron 上下文测试：划词读取的回退与剪贴板还原（无选中时应回退为剪贴板内容并保持原样）
'use strict';
const { app, clipboard } = require('electron');
const { readSelection } = require('../src/main/selectionReader');

app.whenReady().then(async () => {
  const original = '原始剪贴板内容-应被还原';
  clipboard.writeText(original);
  const r = await readSelection({ timeoutMs: 600 });
  const after = clipboard.readText();
  console.log(
    JSON.stringify(
      {
        got: r,
        clipboardAfter: after,
        restored: after === original,
      },
      null,
      2
    )
  );
  app.quit();
});
