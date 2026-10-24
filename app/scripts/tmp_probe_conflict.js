// E2E 探针 C：热键冲突可感知性（v2.3.1 基线 P1-7 / 指标 G）
//   node scripts/tmp_probe_conflict.js
//
// 链路：holder 先占住 Ctrl+Alt+R → 主进程后启动 → globalShortcut.register 失败
//   → hotkeyTray.reportConflict：a11y.announce 语音播报（主进程侧，窗口未聚焦也能听到）
//     + 托盘气泡 + hotkey:conflict 事件。
// 判定：日志出现 register ok=false 且 conflict announce 被真实调用（ok=true 或明确的失败原因）。
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const OUT = path.join(APP, 'dist', 'probe');
const DISPLAY_NUM = process.env.PROBE_DISPLAY || '99';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[conflict]', ...a);

function killAll() {
  for (const name of ['electron']) {
    try { execFileSync('pkill', ['-x', name], { stdio: 'ignore' }); } catch (e) { /* noop */ }
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const env = { ...process.env, DISPLAY: `:${DISPLAY_NUM}` };
  const report = { ok: false, steps: {} };

  killAll();
  await sleep(500);

  // 1. holder 先占住 Ctrl+Alt+R
  const holder = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), [path.join('scripts', 'probe-hotkey-conflict-holder.js'), '--no-sandbox', '--disable-gpu'], {
    cwd: APP,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const holderLogs = [];
  holder.stdout.on('data', (c) => holderLogs.push(String(c)));
  holder.stderr.on('data', (c) => holderLogs.push(String(c)));
  await sleep(3000);
  log('holder 日志:', holderLogs.join('').trim());
  report.steps.holder = holderLogs.join('').trim();

  // 2. 主进程启动（热键注册必然失败）
  const devUrl = `file://${path.join(APP, 'dist', 'renderer', 'index.html')}`;
  const main = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu'], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: devUrl, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mainLogs = [];
  main.stdout.on('data', (c) => mainLogs.push(String(c)));
  main.stderr.on('data', (c) => mainLogs.push(String(c)));
  await sleep(12000); // 注册失败 + announce（espeak 合成）都要时间
  const text = mainLogs.join('');
  log('--- 主进程 [hotkey] 日志 ---');
  text.split('\n').filter((l) => l.includes('[hotkey]')).forEach((l) => log(l.trim()));

  const regLine = text.split('\n').find((l) => l.includes('[hotkey] register'));
  const announceLine = text.split('\n').find((l) => l.includes('[hotkey] conflict announce'));
  report.steps.mainHotkeyLogs = text.split('\n').filter((l) => l.includes('[hotkey]')).map((l) => l.trim());

  const checks = {
    holderOccupied: /\[holder\] Ctrl\+Alt\+R registered ok=true/.test(holderLogs.join('')),
    mainRegisterFailed: !!regLine && /ok=false/.test(regLine),
    conflictAnnounced: !!announceLine,
    announceSucceeded: !!announceLine && /ok=true/.test(announceLine),
  };
  report.checks = checks;
  // 可感知的最低标准：注册失败被明确报告 + announce 被调用（TTS 失败也不该静默）
  report.ok = checks.holderOccupied && checks.mainRegisterFailed && checks.conflictAnnounced;
  report.logs = text.slice(-3000);

  try { main.kill(); } catch (e) { /* noop */ }
  try { holder.kill(); } catch (e) { /* noop */ }
  killAll();

  fs.writeFileSync(path.join(OUT, 'conflict-report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== 冲突探针报告 =====');
  console.log(JSON.stringify({ ok: report.ok, checks }, null, 2));
  process.exit(report.ok ? 0 : 3);
})().catch((e) => {
  console.error('[conflict] 探针自身异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
