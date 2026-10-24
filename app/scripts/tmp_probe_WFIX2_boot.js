// W-FIX2 探针：首次启动「黑屏 → 白屏闪烁」是否消除（时间线 + 首帧像素）
//   运行： unset ELECTRON_RUN_AS_NODE; ./node_modules/electron/dist/electron.exe scripts/tmp_probe_WFIX2_boot.js
//
// 做法（尽量贴近真实启动，而不是"看起来不闪"）：
//   1) 在 require 主进程入口【之前】包一层 BrowserWindow，拿到真实主窗口的事件时间线；
//   2) 用一个本地静态服务器托管 dist/renderer，让主进程走真实 loadURL 路径
//      （未打包时主进程读 VITE_DEV_SERVER_URL，等价于 dev 服务器，但跑的是真实构建产物）；
//   3) 窗口第一次可见（'show'）时立即 capturePage 取中心像素，证明首帧不是深色 #0f1115；
//   4) 可见后连续采样 1.5s 像素，证明不会「先浅后深/先深后浅」二次跳变；
//   5) 同时记录 React 挂载时刻与首屏骨架移除时刻，说明骨架只遮空白首帧。
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const electron = require('electron');

const { app } = electron;
const RealBrowserWindow = electron.BrowserWindow;

const APP_DIR = path.join(__dirname, '..');
const DIST_RENDERER = path.join(APP_DIR, 'dist', 'renderer');
const REPORT_JSON = path.join(APP_DIR, 'dist', 'probe', 'wfix2-boot.json');
const REPORT_TXT = path.join(__dirname, 'tmp_probe_WFIX2_boot.txt');

// 隔离 userData：本机可能已有运行中的产品实例，共用 %APPDATA%\LangduNvNeo 会让
// Chromium 缓存目录被占（实测报 "Unable to move the cache: 拒绝访问"），把启动拖到 7s+，
// 测出来的就不是首屏本身的耗时了。主进程按 process.env.APPDATA 拼 userData，故这里改环境变量。
const ISOLATED_APPDATA = path.join(APP_DIR, 'dist', 'probe', 'wfix2-userdata');
try {
  fs.mkdirSync(ISOLATED_APPDATA, { recursive: true });
  process.env.APPDATA = ISOLATED_APPDATA;
} catch (e) {
  /* 隔离失败不致命 */
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const report = {
  ok: false,
  env: {
    appDir: APP_DIR,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    distExists: fs.existsSync(path.join(DIST_RENDERER, 'index.html')),
  },
  windowOptions: null,
  timeline: [],
  firstVisible: null,
  postShowSamples: [],
  renderer: { bootSkeleton: [], reactMountedAt: null, skeletonRemovedAt: null },
  checks: {},
  notes: [],
};

// ---- 时间线：统一以 whenReady 为零点 ----
let t0 = 0;
const marks = [];
function mark(event, extra) {
  const at = Date.now();
  marks.push({ event, ms: t0 ? at - t0 : 0, wall: at, ...(extra || {}) });
}

app.whenReady().then(() => {
  t0 = Date.now();
  mark('whenReady');
});

// 探针隔离：本机可能已有正在运行的「朗读女 Neo」实例占着单实例锁，
// 那会让 bootstrap() 直接 app.quit()（探针什么都测不到）。这里只对本次探针短路该锁。
app.requestSingleInstanceLock = () => true;

// ---- 像素采样 ----
function sampleHex(img) {
  const size = img.getSize();
  const bmp = img.toBitmap(); // BGRA, 每像素 4 字节
  const px = (x, y) => {
    const i = (y * size.width + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
  };
  const hex = (c) =>
    '#' + [c.r, c.g, c.b].map((v) => Number(v).toString(16).padStart(2, '0')).join('');
  const cx = Math.floor(size.width / 2);
  const cy = Math.floor(size.height / 2);
  const center = px(cx, cy);
  // 中心 5x5 均值：避开抗锯齿单点噪声
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const c = px(Math.min(size.width - 1, Math.max(0, cx + dx)), Math.min(size.height - 1, Math.max(0, cy + dy)));
      sr += c.r;
      sg += c.g;
      sb += c.b;
      n += 1;
    }
  }
  return {
    size: { w: size.width, h: size.height },
    centerRGB: [center.r, center.g, center.b],
    centerHex: hex(center),
    center5x5Hex: hex({ r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) }),
    luma: Math.round(0.2126 * center.r + 0.7152 * center.g + 0.0722 * center.b),
  };
}

async function grab(win, label) {
  try {
    const img = await win.webContents.capturePage();
    if (!img || img.isEmpty()) return { label, empty: true };
    return { label, ...sampleHex(img), textPixels: countTextPixels(img, { r: 245, g: 246, b: 250 }) };
  } catch (e) {
    return { label, error: e && e.message };
  }
}

// 中心区域「非底色」像素计数：用来证明骨架上的文字真的画出来了（不是一块纯色板）
function countTextPixels(img, bg) {
  const size = img.getSize();
  const bmp = img.toBitmap();
  const x0 = Math.floor(size.width * 0.2);
  const x1 = Math.floor(size.width * 0.8);
  const y0 = Math.floor(size.height * 0.3);
  const y1 = Math.floor(size.height * 0.7);
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * size.width + x) * 4;
      const d = Math.abs(bmp[i] - bg.b) + Math.abs(bmp[i + 1] - bg.g) + Math.abs(bmp[i + 2] - bg.r);
      if (d > 60) n += 1;
    }
  }
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms)),
  ]);
}

// 场景 B：验证「HTML 已到、bundle 未到」的空窗期骨架真的上屏，且 React 挂载后被移除。
// 两段式，避免被渲染进程的慢 IPC 干扰（本机 executeJavaScript/capturePage 单次往返可达 1s）：
//   B1：把 .js 拖后 15s —— 空窗期足够长，任何 15s 内的取样都必然发生在 bundle 之前；
//       判据是 document.readyState === 'loading' 且 #ldn-boot 存在（= 骨架已渲染、bundle 未执行）。
//   B2：把延迟清零重新加载 —— 验证骨架在 React 挂载后确实被移除，不残留遮挡。
async function runSkeletonScenario(url) {
  const out = { b1DelayMs: 15000 };
  const w = new RealBrowserWindow({
    width: 900,
    height: 600,
    show: false,
    backgroundColor: '#f5f6fa',
    // 独立 partition（无 persist 前缀 = 内存会话），确保没有 disk cache 命中
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, partition: 'wfix2-skeleton-nocache' },
  });
  const t = Date.now();
  const probeDom = () =>
    w.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('root'); const b = document.getElementById('ldn-boot'); return { boot: !!b, kids: r ? r.childElementCount : -1, bootText: b ? b.innerText.replace(/\\s+/g, ' ').trim() : '', ready: document.readyState, t: Math.round(performance.now()) }; })()`
    );
  try {
    // ---- B1：空窗期骨架 ----
    delayJsMs = out.b1DelayMs;
    const started = new Promise((resolve) => w.webContents.once('did-start-loading', resolve));
    w.loadURL(`${url}?b1=${Date.now()}`);
    await withTimeout(started, 5000, 'did-start-loading');
    await sleep(400);
    w.show();
    out.showAtMs = Date.now() - t;
    await sleep(150);
    try {
      const img = await withTimeout(w.webContents.capturePage(), 5000, 'capturePage');
      const px = sampleHex(img);
      out.centerHex = px.centerHex;
      out.luma = px.luma;
      out.textPixels = countTextPixels(img, { r: 245, g: 246, b: 250 });
      out.captureAtMs = Date.now() - t;
      fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
      fs.writeFileSync(path.join(APP_DIR, 'dist', 'probe', 'wfix2-skeleton.png'), img.toPNG());
    } catch (e) {
      out.captureError = e.message;
    }
    out.domDuringGap = null; // 说明：bundle 未执行时 executeJavaScript 会挂起（等 document 加载完），
    // 因此空窗期只能用截图取证（wfix2-skeleton.png），没有可用的 DOM 通道。
    // 骨架「挂载后被移除」由主窗口的 DOM 采样证明（report.renderer.bootSkeleton：boot=false 且 kids>0）。
  } catch (e) {
    out.error = (e && e.message) || String(e);
  } finally {
    delayJsMs = 0;
    if (!w.isDestroyed()) w.destroy();
  }
  return out;
}

// ---- 静态服务器：托管真实构建产物 ----
// delayJsMs > 0 时把 .js 响应拖后，用来构造「HTML 已到、bundle 未到」的真实骨架窗口
let delayJsMs = 0;
function serveDist() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
      const file = path.join(DIST_RENDERER, rel);
      if (!file.startsWith(DIST_RENDERER) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const send = () => {
        if (res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        fs.createReadStream(file).pipe(res);
      };
      const isJs = path.extname(file).toLowerCase() === '.js';
      if (report.serverLog) {
        report.serverLog.push({ rel, isJs, delayed: isJs && delayJsMs > 0, delayJsMs, at: Date.now() });
      }
      if (isJs && delayJsMs > 0) setTimeout(send, delayJsMs);
      else send();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

// ---- 主窗口取证：拦截 electron 模块的 BrowserWindow（主进程入口在 require 时解构它）----
// 不能直接给 electron.BrowserWindow 赋值（该导出是只读 getter），所以包一层 Module._load。
let tracedWin = null;
function TracedBrowserWindow(options) {
  const win = new RealBrowserWindow(options);
  try {
    if (!tracedWin && options && options.width >= 900) {
      tracedWin = win;
      let liveBg = '';
      try {
        liveBg = win.getBackgroundColor ? win.getBackgroundColor() : '';
      } catch (e) {
        liveBg = '';
      }
      report.windowOptions = {
        show: options.show,
        backgroundColor: options.backgroundColor,
        width: options.width,
        height: options.height,
        visibleAtCreate: win.isVisible(),
        getBackgroundColorAtCreate: liveBg,
      };
      trace(win);
    }
  } catch (e) {
    report.notes.push('traced window: ' + (e && e.message));
  }
  return win;
}
TracedBrowserWindow.prototype = RealBrowserWindow.prototype;
Object.setPrototypeOf(TracedBrowserWindow, RealBrowserWindow);

function installBrowserWindowSpy() {
  const Module = require('module');
  const origLoad = Module._load;
  let shim = null;
  Module._load = function patchedLoad(request) {
    const exp = origLoad.apply(this, arguments);
    if (request === 'electron' && exp && exp.BrowserWindow) {
      if (!shim) {
        shim = new Proxy(exp, {
          get(target, prop) {
            if (prop === 'BrowserWindow') return TracedBrowserWindow;
            return target[prop];
          },
        });
      }
      return shim;
    }
    return exp;
  };
}

function trace(win) {
  mark('window-created', { visible: win.isVisible() });
  win.webContents.on('did-start-loading', () => mark('did-start-loading'));
  win.webContents.on('dom-ready', () => mark('dom-ready'));
  win.webContents.on('did-finish-load', () => mark('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => mark('did-fail-load', { code, desc, url }));
  win.once('ready-to-show', () => {
    mark('ready-to-show', { visible: win.isVisible() });
    grab(win, 'hidden-first-paint').then((s) => {
      report.hiddenFirstPaint = s;
    });
  });
  win.once('show', () => {
    mark('show', { visible: win.isVisible() });
    // 第一次可见后立刻取像素（异步，但仍在同一批首帧上）
    grab(win, 'first-visible').then((s) => {
      report.firstVisible = { ...s, msAfterShow: t0 ? Date.now() - t0 : 0 };
    });
    // 连续采样：证明不会二次跳色
    let i = 0;
    const poll = setInterval(async () => {
      i += 1;
      const s = await grab(win, `post-${i}`);
      report.postShowSamples.push(s);
      if (i >= 15) clearInterval(poll);
    }, 100);
    // React 挂载 / 骨架移除观测
    let d = 0;
    const domPoll = setInterval(async () => {
      d += 1;
      try {
        const st = await win.webContents.executeJavaScript(
          `(() => { const r = document.getElementById('root'); return { boot: !!document.getElementById('ldn-boot'), kids: r ? r.childElementCount : -1, ready: document.readyState }; })()`
        );
        const at = Date.now() - t0;
        report.renderer.bootSkeleton.push({ ms: at, ...st });
        if (report.renderer.reactMountedAt == null && st.kids > 0) report.renderer.reactMountedAt = at;
        if (report.renderer.skeletonRemovedAt == null && st.boot === false) report.renderer.skeletonRemovedAt = at;
      } catch (e) {
        /* 页面切换中，忽略 */
      }
      if (d >= 20) clearInterval(domPoll);
    }, 100);
  });
}

// ---- 主流程 ----
(async () => {
  let server = null;
  try {
    if (!report.env.distExists) throw new Error('dist/renderer/index.html 不存在，先跑 vite build');

    const srv = await serveDist();
    server = srv.server;
    process.env.VITE_DEV_SERVER_URL = srv.url;
    report.env.devServerUrl = srv.url;

    // 关键顺序：先装 BrowserWindow 取证，再 require 主进程入口
    installBrowserWindowSpy();
    require(path.join(APP_DIR, 'src', 'main', 'index.js'));

    // 等窗口显示 + 采样窗口结束（最多 12s，覆盖 5s 兜底路径）
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      const shown = marks.some((m) => m.event === 'show');
      if (shown && report.postShowSamples.length >= 15) break;
    }
    // 给异步 grab 收尾
    await new Promise((r) => setTimeout(r, 600));

    // ---- 场景 B：HTML 已到、bundle 未到 → 验证首屏骨架真的上屏，且挂载后被移除 ----
    try {
      report.serverLog = [];
      report.skeletonScenario = await runSkeletonScenario(srv.url);
    } catch (e) {
      report.skeletonScenario = { error: (e && e.stack) || String(e) };
    }
  } catch (e) {
    report.error = (e && e.stack) || String(e);
  } finally {
    report.timeline = marks;

    const bg = (report.windowOptions && report.windowOptions.backgroundColor) || '';
    const firstRGB = report.firstVisible && report.firstVisible.centerRGB;
    const firstLuma = report.firstVisible && report.firstVisible.luma;
    const darkSamples = report.postShowSamples.filter((s) => typeof s.luma === 'number' && s.luma < 60);
    const showMark = marks.find((m) => m.event === 'show');
    const readyMark = marks.find((m) => m.event === 'ready-to-show');
    const finishMark = marks.find((m) => m.event === 'did-finish-load');

    report.checks = {
      showFalseInitially: !!(report.windowOptions && report.windowOptions.show === false),
      bgNotDarkLiteral: bg.toLowerCase() !== '#0f1115',
      bgMatchesLightTheme: bg.toLowerCase() === '#f5f6fa',
      hiddenUntilReadyToShow: !!(showMark && readyMark && showMark.ms >= readyMark.ms),
      readyToShowArrived: !!readyMark,
      showDelayMs: showMark && readyMark ? showMark.ms - readyMark.ms : null,
      firstFrameNotDark: typeof firstLuma === 'number' ? firstLuma > 150 : false,
      firstFrameIsLightThemeBg: !!(report.firstVisible && report.firstVisible.centerHex),
      noDarkFrameAfterShow: darkSamples.length === 0,
      reactMountedAfterShow: !!(
        report.renderer.reactMountedAt != null &&
        showMark &&
        report.renderer.reactMountedAt >= showMark.ms
      ),
      skeletonRemoved: report.renderer.skeletonRemovedAt != null,
      didFinishLoadSeen: !!finishMark,
    };

    // 场景 B 的检查项（骨架）
    const sc = report.skeletonScenario || {};
    report.checks.skeletonPaintedInGap =
      typeof sc.textPixels === 'number' && sc.textPixels > 200 && typeof sc.captureAtMs === 'number';
    report.checks.skeletonCaptureBeforeBundle = !!(sc.captureAtMs != null && sc.captureAtMs < sc.b1DelayMs);
    report.checks.skeletonHasTextPixels = typeof sc.textPixels === 'number' && sc.textPixels > 200;
    report.checks.skeletonRemovedAfterMount = !!(
      report.renderer.skeletonRemovedAt != null &&
      report.renderer.bootSkeleton.some((s) => s.boot === false && s.kids > 0)
    );
    report.checks.skeletonFrameNotDark = typeof sc.luma === 'number' ? sc.luma > 150 : false;

    // only meaningful checks decide ok
    report.ok = [
      'showFalseInitially',
      'bgNotDarkLiteral',
      'bgMatchesLightTheme',
      'hiddenUntilReadyToShow',
      'readyToShowArrived',
      'firstFrameNotDark',
      'noDarkFrameAfterShow',
      'skeletonRemoved',
      'didFinishLoadSeen',
      'skeletonPaintedInGap',
      'skeletonCaptureBeforeBundle',
      'skeletonHasTextPixels',
      'skeletonRemovedAfterMount',
      'skeletonFrameNotDark',
    ].every((k) => report.checks[k]);

    // 打印
    console.log('\n===== W-FIX2 boot timeline (ms since whenReady) =====');
    marks.forEach((m) => {
      const extra = Object.keys(m)
        .filter((k) => !['event', 'ms', 'wall'].includes(k))
        .map((k) => `${k}=${JSON.stringify(m[k])}`)
        .join(' ');
      console.log(`  ${String(m.ms).padStart(6)}ms  ${m.event}${extra ? '  ' + extra : ''}`);
    });
    console.log('\n----- 首帧（窗口首次可见） -----');
    console.log('  windowOptions.backgroundColor :', bg);
    console.log('  首帧中心像素 / 5x5 均值 / 亮度 :', report.firstVisible && report.firstVisible.centerHex, '/', report.firstVisible && report.firstVisible.center5x5Hex, '/', firstLuma);
    console.log('  可见后 15 次采样（100ms 间隔） :', report.postShowSamples.map((s) => s.centerHex).join(' '));
    console.log('  React 挂载 @', report.renderer.reactMountedAt, 'ms ；骨架移除 @', report.renderer.skeletonRemovedAt, 'ms');
    console.log('\n----- checks -----');
    Object.keys(report.checks).forEach((k) => console.log(`  ${report.checks[k] ? 'PASS' : 'FAIL'}  ${k} = ${JSON.stringify(report.checks[k])}`));
    if (report.error) console.log('\n[error]', report.error);
    console.log(`\n[result] ok=${report.ok}`);

    try {
      fs.mkdirSync(path.dirname(REPORT_JSON), { recursive: true });
      fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), 'utf8');
      const lines = [];
      lines.push('W-FIX2 首次启动闪烁探针');
      lines.push(`electron=${report.env.electron} chrome=${report.env.chrome}`);
      lines.push(`backgroundColor=${bg} show=${report.windowOptions && report.windowOptions.show}`);
      lines.push('');
      lines.push('timeline(ms since whenReady):');
      marks.forEach((m) => lines.push(`  ${m.ms}\t${m.event}`));
      lines.push('');
      lines.push(`firstVisible center=${report.firstVisible && report.firstVisible.centerHex} luma=${firstLuma}`);
      lines.push(`postShow samples=${report.postShowSamples.map((s) => s.centerHex).join(',')}`);
      lines.push(`checks=${JSON.stringify(report.checks)}`);
      lines.push(`ok=${report.ok}`);
      fs.writeFileSync(REPORT_TXT, lines.join('\n') + '\n', 'utf8');
      console.log('[report]', REPORT_JSON);
      console.log('[report]', REPORT_TXT);
    } catch (e) {
      console.error('[report] 写文件失败:', e && e.message);
    }

    try {
      // eslint-disable-next-line global-require
      require(path.join(APP_DIR, 'src', 'main', 'platform', 'captureHost')).resetCaptureHost();
    } catch (e) {
      /* noop */
    }
    if (server) server.close();
    setTimeout(() => app.exit(report.ok ? 0 : 3), 200);
  }
})();
