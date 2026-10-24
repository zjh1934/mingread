// E2E 探针 D：朗读热键重注册不再连带清除缩放热键（v2.3.1 修复验证）
//   node scripts/tmp_probe_zoom_survive.js
//
// 旧设计缺陷：hotkeyTray.register() 用 globalShortcut.unregisterAll() 会把 zoomController 的
//   Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0 一起清掉（靠事后补注册兜底，很脆）。
// 新设计：只精准注销自己上一个朗读热键。
// 验证：① 缩放热键先能激活 overlay；② 经两次 setHotkey 重注册后，缩放热键仍能激活 overlay。
'use strict';

const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'dist', 'probe');
const CDP_PORT = 9223;
const DISPLAY_NUM = process.env.PROBE_DISPLAY || '99';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[zoom-survive]', ...a);

function killAll() {
  try { execFileSync('pkill', ['-x', 'electron'], { stdio: 'ignore' }); } catch (e) { /* noop */ }
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpEval(ws, expression, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error('CDP evaluate 超时')), timeoutMs);
    const onMsg = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      } catch (e) { /* 非 JSON 帧忽略 */ }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

function xdo(args) {
  return new Promise((resolve) => {
    execFile('xdotool', args, { env: { ...process.env, DISPLAY: `:${DISPLAY_NUM}` } }, (_e, so) => resolve(String(so || '').trim()));
  });
}

async function zoomOverlayVisible() {
  const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => []);
  return list.some((t) => String(t.url || '').includes('zoom-overlay'));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, DISPLAY: `:${DISPLAY_NUM}` };
  const report = { ok: false, steps: {} };

  killAll();
  await sleep(500);

  const devUrl = `file://${path.join(APP, 'dist', 'renderer', 'index.html')}`;
  const main = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  main.stdout.on('data', (c) => logs.push(String(c)));
  main.stderr.on('data', (c) => logs.push(String(c)));

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      const list = await httpGetJson(`http://127.0.0.1:${CDP_PORT}/json`);
      target = list.find((t) => t.type === 'page' && String(t.url || '').includes('index.html'));
      if (target) break;
    } catch (e) { /* CDP 未起 */ }
  }
  if (!target) { console.error('未找到主窗口 CDP 目标'); try { main.kill(); } catch (e) { /* noop */ } process.exit(2); }
  log('主窗口就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 失败')), { once: true });
  });
  for (let i = 0; i < 20; i += 1) {
    const r = await cdpEval(ws, `!!(window.langdu && window.langdu.saveSystemSettings)`, 10000).catch(() => false);
    if (r) break;
    await sleep(500);
  }
  log('CDP 已连接，桥就绪');

  // ① 打开缩放总开关（nudge 才会动作）
  await cdpEval(ws, `window.langdu.saveSystemSettings({ zoomEnabled: true })`, 30000);
  await sleep(1500);
  report.steps.zoomEnabled = true;
  const before = await zoomOverlayVisible();
  log('激活前 overlay 可见:', before);

  // ② 缩放热键生效一次（基线）
  await xdo(['key', '--clearmodifiers', 'ctrl+alt+equal']);
  await sleep(2500);
  const firstActivate = await zoomOverlayVisible();
  log('Ctrl+Alt+= 第一次激活 overlay:', firstActivate);
  report.steps.firstActivate = firstActivate;

  // ③ 退出缩放
  await xdo(['key', '--clearmodifiers', 'ctrl+alt+0']);
  await sleep(1500);

  // ④ 两次朗读热键重注册（旧设计在此会清掉缩放热键）
  await cdpEval(ws, `window.langdu.setHotkey('Ctrl+Alt+Shift+R')`, 30000);
  await sleep(2000);
  await cdpEval(ws, `window.langdu.setHotkey('Ctrl+Alt+R')`, 30000);
  await sleep(2000);
  const regLines = logs.join('').split('\n').filter((l) => l.includes('[hotkey] register')).map((l) => l.trim());
  log('热键注册日志:', JSON.stringify(regLines));
  report.steps.regLines = regLines;

  // ⑤ 重注册后再按缩放热键：应仍然生效
  await xdo(['key', '--clearmodifiers', 'ctrl+alt+equal']);
  await sleep(2500);
  const afterReregister = await zoomOverlayVisible();
  log('重注册后 Ctrl+Alt+= 仍能激活 overlay:', afterReregister);
  report.steps.afterReregister = afterReregister;

  // 收尾：恢复默认（缩放关、热键已是 Ctrl+Alt+R）
  await xdo(['key', '--clearmodifiers', 'ctrl+alt+0']).catch(() => {});
  await cdpEval(ws, `window.langdu.saveSystemSettings({ zoomEnabled: false })`, 30000).catch(() => {});
  await sleep(500);
  try { main.kill(); } catch (e) { /* noop */ }
  killAll();

  const checks = {
    zoomHotkeyWorkedFirst: firstActivate === true,
    zoomHotkeySurvivesReregister: afterReregister === true,
    hotkeyReregisteredTwice: regLines.filter((l) => /ok=true/.test(l)).length >= 3, // 初始 + 两次切换
  };
  report.checks = checks;
  report.ok = Object.values(checks).every(Boolean);
  report.logs = logs.join('').slice(-3000);
  fs.writeFileSync(path.join(OUT, 'zoom-survive-report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 缩放热键存活探针报告 =====');
  console.log(JSON.stringify({ ok: report.ok, checks }, null, 2));
  process.exit(report.ok ? 0 : 3);
})().catch((e) => {
  console.error('[zoom-survive] 探针自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
