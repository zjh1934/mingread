// 诊断探针（tmp_probe_*，沙箱专用）：挂钩 window.api.a11y.*，记录谁在什么时候调用了播报/提示音。
//   node scripts/tmp_probe_diag.js
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } else if (m.method) this.events.push(m); }); }
  send(method, params = {}) { const id = ++this.id; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression, timeoutMs = 60000) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : undefined; }
}

const HOOK = `
(function () {
  var iv = setInterval(function () {
    if (!window.api || !window.api.a11y || typeof window.api.a11y.announce !== 'function') return;
    clearInterval(iv);
    ['announce', 'cue'].forEach(function (name) {
      var orig = window.api.a11y[name];
      if (typeof orig !== 'function') return;
      window.api.a11y[name] = function (payload) {
        try { console.log('[HOOK] ' + name + ' t=' + Date.now() + ' ' + JSON.stringify(payload)); } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
    console.log('[HOOK] installed t=' + Date.now());
  }, 5);
})();
`;

(async () => {
  const env = { ...process.env, PULSE_SERVER: 'unix:/run/pulse/native', DISPLAY: ':99' };
  try { execFileSync('pkill', ['-x', 'electron'], { stdio: 'ignore' }); } catch (e) { /* noop */ }
  await sleep(500);
  const el = spawn(path.join(APP, 'node_modules', '.bin', 'electron'), ['.', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9223'], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: `file://${path.join(APP, 'dist', 'renderer', 'index.html')}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLogs = [];
  el.stdout.on('data', (c) => appLogs.push(String(c)));
  el.stderr.on('data', (c) => appLogs.push(String(c)));

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000);
    try {
      const list = await httpGetJson('http://127.0.0.1:9223/json');
      target = list.find((t) => t.type === 'page' && String(t.url || '').includes('index.html'));
      if (target) break;
    } catch (e) { /* retry */ }
  }
  if (!target) { console.error('未找到主窗口'); process.exit(2); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 注入挂钩后重载页面，让挂钩在应用挂载前生效
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(12000); // 等应用挂载 + 状态同步

  // 主动触发一次 announce（唯一文案，避免去重）
  await cdp.eval(`window.api.a11y.announce({ text: '诊断唯一文案甲乙丙丁戊己庚辛壬癸。', priority: 'high' })`, 60000);
  await sleep(6000);

  const consoleMsgs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled').map((e) => `${e.params.timestamp} ${e.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' ')}`);
  console.log('===== 渲染进程 console（HOOK 相关）=====');
  for (const m of consoleMsgs) if (m.includes('[HOOK]')) console.log(m);
  console.log('===== 应用日志（主进程）=====');
  console.log(appLogs.join('').split('\n').filter((l) => l.includes('[hotkey]') || l.includes('[zoom]') || l.includes('floatball')).slice(0, 10).join('\n'));

  try { el.kill(); } catch (e) { /* noop */ }
  process.exit(0);
})().catch((e) => { console.error('诊断探针异常', e); process.exit(2); });
