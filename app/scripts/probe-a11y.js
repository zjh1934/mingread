// 探针：在真实 Electron 渲染进程里跑 announcer.js，验证语音播报链路与去重/节流行为。
// 主进程侧由 γ 实现，这里用一个假 a11y 桥（window.api.a11y）记录所有 announce / cue 调用。
// 结果写到 /tmp/a11y-probe-result.json（不依赖 stdout），用法：node scripts/probe-a11y.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-probe-'));
const OUT = path.join(os.tmpdir(), 'a11y-probe-result.json');

// 1) 用 esbuild 把 ESM 服务打包成可直接内联的 IIFE
const bundled = execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'renderer', 'services', 'announcer.js'),
    '--bundle',
    '--format=iife',
    '--global-name=Announcer',
    '--platform=browser',
  ],
  { encoding: 'utf8' }
);

fs.writeFileSync(
  path.join(TMP, 'preload.js'),
  `'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  a11y: {
    announce: (p) => ipcRenderer.send('a11y:announce', p || {}),
    cue: (p) => ipcRenderer.send('a11y:cue', p || {}),
    report: (r) => ipcRenderer.send('a11y:report', r || {}),
  },
});
`
);

fs.writeFileSync(
  path.join(TMP, 'main.js'),
  `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const OUT = process.env.A11Y_PROBE_OUT;
const log = [];
const t0 = Date.now();
ipcMain.on('a11y:announce', (_e, p) => log.push({ t: Date.now() - t0, kind: 'announce', text: p.text, priority: p.priority }));
ipcMain.on('a11y:cue', (_e, p) => log.push({ t: Date.now() - t0, kind: 'cue', type: p.type }));
ipcMain.on('a11y:report', (_e, r) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: true, results: r, log }, null, 2));
  app.quit();
});
app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
});
setTimeout(() => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: 'timeout', log }, null, 2));
  app.quit();
}, 25000);
`
);

const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="out">running</div>
<script>${bundled}</script>
<script>
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const A = window.Announcer;
  A.configure({ enabled: true, minGapMs: 800, highMinGapMs: 250, dedupWindowMs: 3000, cueGapMs: 150 });
  A.reset();

  // 场景 1：开始朗读
  A.announce('start');
  await sleep(900);

  // 场景 2：用户反复按热键失败 → 同一状态连发 8 次，只应播 1 次
  for (let i = 0; i < 8; i += 1) A.announce('noSelection', {}, { priority: 'high' });
  await sleep(900);

  // 场景 3：节流合并 → 100ms 内三条不同文案，只出第一条 + 最后一条
  A.say('x1', '文本一');
  A.say('x2', '文本二');
  A.say('x3', '文本三');
  await sleep(900);

  // 场景 4：高优先级插话 → 间隔 300ms（< minGap 800ms）也应立刻播报
  await sleep(600);
  A.say('net', '网络已断开，朗读需要联网', { priority: 'high' });
  await sleep(300);
  A.say('timer', '定时时间到，已停止朗读', { priority: 'high' });
  await sleep(900);

  // 场景 5：提示音去重 → 连按 3 次只响一声，间隔够再响
  A.cue('press');
  A.cue('press');
  A.cue('press');
  await sleep(230);
  A.cue('press');
  await sleep(900);

  // 场景 6：去重窗口过后同一状态可再次播报（不能永久静音）
  A.configure({ dedupWindowMs: 400, minGapMs: 300 });
  A.reset();
  A.announce('start');
  await sleep(500);
  A.announce('start');
  await sleep(500);

  // 十类状态预置文案
  const presets = {
    start: {}, pause: {}, stop: {}, synthesizing: {}, synthFailed: {}, networkOffline: {},
    hotkeyConflict: { hotkey: 'F1' }, noSelection: {}, emptyText: {}, timerStop: {},
  };
  const texts = {};
  Object.keys(presets).forEach((k) => { texts[k] = A.MESSAGES[k](presets[k]); });

  window.api.a11y.report({ texts });
})().catch((e) => {
  window.api.a11y.report({ fatal: String(e && e.message ? e.message : e) });
});
</script></body></html>`;

fs.writeFileSync(path.join(TMP, 'index.html'), page);

const electronPath = require(path.join(ROOT, 'node_modules', 'electron'));
try {
  fs.unlinkSync(OUT);
} catch (e) {
  /* 首次运行无输出文件 */
}

const child = spawn('xvfb-run', ['-a', electronPath, path.join(TMP, 'main.js'), '--no-sandbox', '--disable-gpu'], {
  env: { ...process.env, A11Y_PROBE_OUT: OUT },
  stdio: 'ignore',
});

const deadline = Date.now() + 40000;
const wait = () => {
  if (fs.existsSync(OUT)) {
    const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const log = data.log || [];
    const says = log.filter((l) => l.kind === 'announce');
    const cues = log.filter((l) => l.kind === 'cue');
    const texts = (data.results && data.results.texts) || {};

    console.log('=== 真实 window.api.a11y 调用记录 ===');
    log.forEach((l) => {
      console.log(
        `  +${String(l.t).padStart(4)}ms ${l.kind === 'cue' ? `[cue:${l.type}]` : `[${l.priority}] ${l.text}`}`
      );
    });

    const count = (t) => says.filter((s) => s.text === t).length;
    const checks = [];
    const rec = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
    rec('链路通：announce 真的打到 window.api.a11y', says.length > 0, `播报 ${says.length} 条`);
    rec('cue 链路通', cues.length > 0, `提示音 ${cues.length} 次，type=${cues.map((c) => c.type).join(',')}`);
    rec('1. 开始朗读播报', count('已开始朗读') >= 1, texts.start);
    rec('2. 同一状态连发 8 次只播 1 次（去重）', count(texts.noSelection || 'x') === 1, `实际 ${count(texts.noSelection || 'x')} 次`);
    rec('3. 节流合并：中间那条被丢掉', count('文本一') === 1 && count('文本二') === 0 && count('文本三') === 1, '文本一/文本三 各 1 次，文本二 0 次');
    const netAt = says.findIndex((s) => s.text.indexOf('网络已断开') === 0);
    const timerAt = says.findIndex((s) => s.text.indexOf('定时时间到') === 0);
    rec(
      '4. 高优先级可插话（间隔 <800ms 仍播报）',
      netAt >= 0 && timerAt >= 0 && says[timerAt].t - says[netAt].t < 800,
      `间隔 ${netAt >= 0 && timerAt >= 0 ? says[timerAt].t - says[netAt].t : 'N/A'}ms`
    );
    rec('5. 提示音去重：连按 3 次只响 1 声，间隔够再响', cues.length === 2, `实际 ${cues.length} 次`);
    rec(
      '6. 十类状态文案齐备且简短（≤30 字、中文）',
      Object.keys(texts).length === 10 && Object.values(texts).every((t) => /[一-龥]/.test(t) && t.length <= 30),
      Object.values(texts).join(' / ')
    );
    rec('7. 去重窗口过后同状态可再播（不会永久静音）', count('已开始朗读') >= 2, `已开始朗读 ${count('已开始朗读')} 次`);

    console.log('\n=== 断言 ===');
    checks.forEach((c) => console.log(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.name} — ${c.detail}`));
    const fail = checks.filter((c) => !c.ok).length;
    console.log(`\n结果：PASS=${checks.length - fail} FAIL=${fail}`);
    child.kill();
    process.exit(fail ? 1 : 0);
  }
  if (Date.now() > deadline) {
    console.error('探针超时');
    child.kill();
    process.exit(1);
  }
  setTimeout(wait, 400);
};
wait();
