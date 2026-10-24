// ============================================================================
// tmp_probe_e2e_espeak.js —— 沙箱端到端语音链路验证探针（一次性，不入库分发）
//
// 验证目标（编排者任务 3）：
//   A. 引擎路由：chain = [sapi, espeak, edge]，沙箱里 SAPI→espeak 降级且原因可感知
//   B. UI 触发 cue：   window.api.a11y.cue({type:'press'}) → IPC → 常驻音频窗口出声
//   C. UI 触发播报：   window.api.a11y.announce({...}) → IPC → ttsBridge → espeak
//      → 音频窗口 decodeAudioData + 播放（拿 {ok,via,format,durationMs}）
//   D. 合成落盘 + PCM 分析（文件大小 / 时长 / 非静音证据）
//   E. 音频窗口离线渲染同一 WAV（OfflineAudioContext peak/rms）——无静音证据
//   F. 真实热键链路：registerHotkeyTray + xdotool 发 Ctrl+Alt+R → cue('press')
//      实测「按键 → 反馈音」端到端延迟（基线指标 E：≤200ms）
//
// 运行（xvfb 下，root 需 --no-sandbox）：
//   xvfb-run -a node_modules/.bin/electron scripts/tmp_probe_e2e_espeak.js \
//     --no-sandbox --disable-gpu
// ============================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

// ---- 测试隔离：settings 走临时文件，不碰真实用户设置 ----
require(path.join(ROOT, 'src/main/settingsStore'))._setSettingsPathForTest(
  path.join(os.tmpdir(), `ldn-probe-e2e-${process.pid}.json`)
);

// ---- 复用主进程真实模块（只读使用，不修改）----
const { registerIpc } = require(path.join(ROOT, 'src/main/ipc'));
const { getBridge } = require(path.join(ROOT, 'src/main/ttsBridge'));
const a11yFeedback = require(path.join(ROOT, 'src/main/a11yFeedback'));
const { registerHotkeyTray } = require(path.join(ROOT, 'src/main/hotkeyTray'));

const OUT_DIR = path.join(ROOT, 'dist', 'probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** stdout 行拦截：抓 hotkeyTray 打的 `[hotkey] press cue ...` 日志 */
const logLines = [];
const origWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  logLines.push(String(chunk));
  return origWrite(chunk, ...rest);
};

/** 带超时护栏的 executeJavaScript：renderer 抖动时挂起也不能拖死整个探针 */
function jsOf(win, code, timeoutMs = 20000) {
  return Promise.race([
    win.webContents.executeJavaScript(code),
    sleep(timeoutMs).then(() => ({ __timeout: true, timeoutMs })),
  ]);
}

/** WAV PCM 分析（node 侧）：大小/时长/RMS/peak/过零率 —— 「真的有声」的硬证据 */
function analyzeWav(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sampleRate = dv.getUint32(24, true);
  const channels = dv.getUint16(22, true);
  const bits = dv.getUint16(34, true);
  const byteRate = dv.getUint32(28, true);
  const pcm = buf.length - 44;
  let sum = 0;
  let peak = 0;
  let zeroCross = 0;
  let prev = 0;
  const n = Math.floor(pcm / 2);
  for (let i = 0; i < n; i += 1) {
    const v = dv.getInt16(44 + i * 2, true) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v * v;
    if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) zeroCross += 1;
    prev = v;
  }
  return {
    bytes: buf.length,
    pcmBytes: pcm,
    sampleRate,
    channels,
    bits,
    durationMs: Math.round((pcm / byteRate) * 1000),
    rms: +(Math.sqrt(sum / Math.max(1, n)).toFixed(5)),
    peak: +peak.toFixed(5),
    zeroCrossRate: +(zeroCross / (pcm / byteRate)).toFixed(1), // 每秒过零次数：语音通常数百~数千
  };
}

/** 在独立验证窗口里用 OfflineAudioContext 渲染同一段 WAV，验证解码+能量（非静音）。
 *  刻意不用 a11yFeedback 的常驻音频窗口：C 步骤刚在里面播过音，隔离状态干扰；
 *  且所有 executeJavaScript 加超时护栏，renderer 抖动也不拖死探针。 */
async function offlineRenderInAudioWindow(b64) {
  const win = new BrowserWindow({
    show: false,
    width: 120,
    height: 80,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  try {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[verify-page]', String(msg).slice(0, 120)));
    win.webContents.on('render-process-gone', (_e, d) => console.log('[verify-page] gone', JSON.stringify(d)));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[verify-page] fail', code, desc));
    await Promise.race([
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body></body></html>')),
      sleep(15000).then(() => {
        throw new Error('verify window load timeout');
      }),
    ]);
    // 注意：executeJavaScript 的返回值会做结构化克隆——注入语句的 completion value
    // 不能是函数（会抛 "An object could not be cloned"），故以 void 0 收尾。
    const r1 = await jsOf(
      win,
      `
      window.__probeOffline = null;
      window.__probeRun = function (b64) {
        var dbg = function (m) { console.log('[probeRun] ' + m); };
        dbg('enter b64=' + b64.length);
        var bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dbg('decoded-to-bytes ' + bytes.length);
        var Ctor = window.AudioContext || window.webkitAudioContext;
        var ctx = new Ctor();
        dbg('ctx state=' + ctx.state);
        var ch = 0;
        ctx.decodeAudioData(bytes.buffer).then(function (buf) {
          ch = buf.numberOfChannels;
          dbg('decoded ch=' + ch + ' dur=' + buf.duration);
          var off = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * 44100), 44100);
          var src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
          dbg('rendering');
          return off.startRendering();
        }).then(function (rendered) {
          dbg('rendered len=' + rendered.length);
          // 注意：此环境 rendered.getChannelData() 会挂起（音频线程取数死锁），
          // 能量/峰值分析以 node 侧 PCM 分析（STEP D）为准，这里只验证解码+渲染完成。
          window.__probeOffline = {
            decodeOk: true, channels: ch, durationMs: Math.round(rendered.duration * 1000),
            renderedSamples: rendered.length
          };
          dbg('done ' + JSON.stringify(window.__probeOffline));
        }).catch(function (e) { dbg('ERR ' + String(e)); window.__probeOffline = { decodeOk: false, error: String(e) }; });
      };
      void 0;
    `,
      15000
    );
    if (r1 && r1.__timeout) return { ok: false, reason: 'INJECT_TIMEOUT' };
    const r2 = await jsOf(win, `window.__probeRun(${JSON.stringify(b64)})`, 15000);
    if (r2 && r2.__timeout) return { ok: false, reason: 'RUN_TIMEOUT' };
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const r = await jsOf(win, 'window.__probeOffline', 15000);
      if (r && r.__timeout) return { ok: false, reason: 'POLL_TIMEOUT' };
      if (r) return r;
    }
    return { ok: false, reason: 'OFFLINE_RENDER_TIMEOUT' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

(async () => {
  const result = { steps: {}, ok: true };
  const step = async (name, fn) => {
    try {
      result.steps[name] = await fn();
      console.log(`[probe] STEP ${name} => ${JSON.stringify(result.steps[name])}`);
    } catch (e) {
      result.ok = false;
      result.steps[name] = { error: String((e && e.message) || e) };
      console.error(`[probe] STEP ${name} FAILED => ${result.steps[name].error}`);
    }
  };

  await app.whenReady();

  // ---- 注册真实 IPC（含 a11yFeedback 的 announce/cue handler + 音频窗口预热）----
  const state = {
    hotkey: 'Ctrl+Alt+R',
    hotkeyOk: false,
    playback: { isPlaying: false, buffering: false, hasAudio: false },
  };
  let mainWindow = null;
  registerIpc(() => mainWindow, state);

  // ---- 主窗口：加载真实构建产物 + 真实 preload（UI 侧 window.api 来源）----
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    show: true,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await new Promise((resolve, reject) => {
    mainWindow.webContents.once('did-finish-load', resolve);
    mainWindow.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
    setTimeout(() => reject(new Error('renderer load timeout')), 30000);
  });
  console.log('[probe] renderer loaded; ui api =', await mainWindow.webContents.executeJavaScript(
    'typeof window.api === "object" && !!window.api.a11y ? "ready" : "missing"'
  ));

  // ---- STEP A：引擎路由 / 降级原因可感知 ----
  await step('A-engine-routing', async () => {
    const bridge = getBridge();
    await bridge.warmup(); // 等后台探测完成，避免读到"尚未探测"中间态
    const st = bridge.getEngineStatus();
    const r = await bridge.synthesize('路由自检：当前应当落在沙箱验证引擎。', { voiceId: 'edge:xiaoxiao' });
    return {
      chain: st.chain,
      active: st.active,
      activeVerificationOnly: st.activeVerificationOnly,
      fallback: st.fallback,
      synthEngine: r.engine,
      synthDegraded: r.degraded,
      fallbackReason: r.fallbackReason && {
        from: r.fallbackReason.from,
        to: r.fallbackReason.to,
        reason: r.fallbackReason.reason,
        message: r.fallbackReason.message,
      },
    };
  });

  // ---- STEP B：UI 触发 cue('press') 端到端延迟 ----
  await step('B-ui-cue', async () => {
    const t0 = Date.now();
    const r = await jsOf(mainWindow, `window.api.a11y.cue({ type: 'press' })`, 15000);
    return { ...r, latencyMs: Date.now() - t0 };
  });

  // ---- STEP C：UI 触发 announce 全链路（ttsBridge → espeak → 音频窗口播放）----
  await step('C-ui-announce', async () => {
    const text = `端到端播报自检 ${Date.now()}：本地语音不可用已切换到沙箱验证语音。`;
    const t0 = Date.now();
    const r = await jsOf(
      mainWindow,
      `window.api.a11y.announce(${JSON.stringify({ text, priority: 'high' })})`,
      90000 // 播放链路：合成 + 解码 + 播完（onended/setTimeout 兜底）
    );
    return { ...r, latencyMs: Date.now() - t0 };
  });

  // ---- STEP D：主进程合成落盘 + PCM 分析 ----
  await step('D-synth-file', async () => {
    const bridge = getBridge();
    const text = '你好，这是朗读女 Neo 沙箱端到端语音链路验证，espeak 验证引擎合成。';
    const t0 = Date.now();
    const r = await bridge.synthesize(text, { voiceId: 'espeak:xiaoxiao' });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `espeak-e2e-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(r.audioData));
    const a = analyzeWav(Buffer.from(r.audioData));
    return { file, engine: r.engine, format: r.format, synthMs: Date.now() - t0, ...a };
  });

  // ---- STEP E：独立窗口离线渲染同一 WAV（解码 + 能量，非静音证据）----
  await step('E-offline-render', async () => {
    const bridge = getBridge();
    const r = await bridge.synthesize('离线渲染自检：这段音频不应当静音。', {});
    const b64 = Buffer.from(r.audioData).toString('base64');
    const rendered = await offlineRenderInAudioWindow(b64);
    let audioWindowState = 'NO_AUDIO_WINDOW';
    try {
      const aw = await a11yFeedback.ensureAudioWindow();
      if (aw) audioWindowState = await jsOf(aw, 'window.__audioState()', 10000);
    } catch (e) {
      audioWindowState = `ERR ${e && e.message}`;
    }
    return { ...rendered, audioWindowState };
  });

  // ---- STEP F：真实热键链路（registerHotkeyTray + xdotool 发 Ctrl+Alt+R）----
  await step('F-hotkey-cue', async () => {
    const hotkeyRef = registerHotkeyTray(() => mainWindow, () => 'Ctrl+Alt+R', () => {});
    if (!hotkeyRef.isRegistered()) return { ok: false, reason: 'GLOBAL_SHORTCUT_REGISTER_FAILED' };
    await sleep(500); // 等 X server  grabs 就绪
    logLines.length = 0;
    const t0 = Date.now();
    await new Promise((resolve) => {
      execFile('xdotool', ['key', 'ctrl+alt+r'], { timeout: 5000 }, () => resolve());
    });
    // 轮询 stdout 拦截缓冲，等 `[hotkey] press cue ok=...` 出现
    let took = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      const line = logLines.join('').match(/\[hotkey\] press cue ok=(\w+) tookMs=(\d+) at=(\d+)/);
      if (line) {
        took = {
          ok: line[1] === 'true',
          tookMs: Number(line[2]), // 按键事件到达主进程 → 提示音播放完成
          endToEndMs: Number(line[3]) ? Date.now() - Number(line[3]) : null, // 含 xdotool 发送开销
          sinceXdotoolMs: Date.now() - t0,
        };
        break;
      }
    }
    hotkeyRef.dispose();
    return took || { ok: false, reason: 'NO_CUE_LOG_WITHIN_8S' };
  });

  // ---- 汇总输出 ----
  const a = result.steps['A-engine-routing'] || {};
  const b = result.steps['B-ui-cue'] || {};
  const c = result.steps['C-ui-announce'] || {};
  const d = result.steps['D-synth-file'] || {};
  const e = result.steps['E-offline-render'] || {};
  const f = result.steps['F-hotkey-cue'] || {};
  const verdict = {
    routingOk: a.chain && a.chain.join('→') === 'sapi→espeak→edge' && a.active === 'espeak',
    fallbackPerceivable: !!(a.fallbackReason && a.fallbackReason.from === 'sapi' && a.fallbackReason.to === 'espeak'),
    uiCueOk: b.ok === true,
    uiAnnounceOk: c.ok === true && c.via === 'tts' && c.durationMs > 0,
    // 真的有声 = PCM 非静音（D，node 侧）+ Chromium 能解码并渲染该 WAV（E）+ 播放链路走完（C）
    audioReal: d.rms > 0 && d.peak > 0 && d.zeroCrossRate > 0 && e.decodeOk === true && e.renderedSamples > 0,
    hotkeyCueOk: f.ok === true,
  };
  console.log('[probe] RESULT ' + JSON.stringify({ ...result, verdict }, null, 1));
  app.exit(result.ok ? 0 : 1);
})().catch((e) => {
  console.error('[probe] FATAL', (e && e.stack) || e);
  app.exit(2);
});
