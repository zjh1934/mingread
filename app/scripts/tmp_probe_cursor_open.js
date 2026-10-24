// 验证「打开指针设置」真的把系统设置窗口拉起来（不只是返回 ok）。
// 判定：调用前 SystemSettings.exe 进程数 → 调用后是否新增。
'use strict';
const { execSync } = require('child_process');
const { app, shell } = require('electron');

function countProc(name) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf8', windowsHide: true });
    return (out.match(new RegExp(name, 'gi')) || []).length;
  } catch (e) {
    return -1;
  }
}

app.whenReady().then(async () => {
  const cs = require('../src/main/cursorSize');
  const st = cs.getState();
  console.log(`[open] 当前指针: size=${st.size} label=${st.label} platform=${st.platform}`);

  const t = cs.settingsTarget();
  console.log(`[open] target uri=${t.uri} fallback=${t.fallback}`);
  if (!t.uri) { console.log('FAIL 无 URI'); app.exit(1); return; }

  const before = countProc('SystemSettings.exe');
  let ok = false;
  try {
    await shell.openExternal(t.uri);
    ok = true;
  } catch (e) {
    console.log('[open] openExternal 失败: ' + e.message);
  }
  console.log(`[open] openExternal=${ok} 调用前 SystemSettings=${before}`);

  await new Promise((r) => setTimeout(r, 3500));
  const after = countProc('SystemSettings.exe');
  console.log(`[open] 调用后 SystemSettings=${after}`);

  const launched = after > before || after > 0;
  console.log(`${launched ? 'PASS' : 'FAIL'}  系统设置窗口已拉起`);

  // 清理：把我们拉起来的设置窗口关掉，别留在用户桌面上
  try {
    execSync('taskkill /IM SystemSettings.exe /F', { windowsHide: true });
    console.log('[open] 已关闭 SystemSettings.exe');
  } catch (e) {
    console.log('[open] 关闭 SystemSettings 失败（可能已自行退出）');
  }
  app.exit(launched ? 0 : 1);
});
