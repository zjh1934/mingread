// 无障碍反馈（γ 负责 main 侧）：状态语音播报 + 非语音提示音。
//
// 契约（renderer 侧由 β 调用）：
//   window.api.a11y.announce({ text, priority: 'high' | 'normal' })
//   window.api.a11y.cue({ type: 'press' | 'success' | 'error' })
//
// 两条硬性要求与对应做法：
//   1. 不引入任何 npm 依赖 / 原生模块 —— 声音用 Web Audio（Oscillator / decodeAudioData）
//      在一个常驻的隐藏窗口里合成播放。
//   2. 主窗口未聚焦甚至隐藏时也要出声 —— 播放发生在独立隐藏窗口里，
//      与 mainWindow 的可见性/焦点无关（且关掉后台节流，避免被暂停）。
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const C = require('../shared/constants');

// 隐藏窗口没有用户手势，默认会被自动播放策略挂起；这里显式放开
try {
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
} catch (e) {
  /* 命令行开关越早越好；失败不致命，页面里还会 resume() */
}

const AUDIO_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(function () {
  var ctx = null, src = null;

  function ac() {
    if (!ctx) { var Ctor = window.AudioContext || window.webkitAudioContext; ctx = new Ctor(); }
    if (ctx.state === 'suspended') { ctx.resume(); }
    return ctx;
  }

  // 三种提示音：含收尾共 < 100ms，靠"音高走向/波形"区分，不靠音量
  //   press   单音 880Hz 正弦      —— 最轻，表示"收到了"
  //   success 上行双音 660→990Hz   —— 表示"做成了"
  //   error   低频方波+锯齿 220/233Hz 拍频 —— 表示"没成"，音色明显更硬
  var CUES = {
    press:   [{ f: 880, t0: 0,     d: 0.055, g: 0.18, w: 'sine' }],
    success: [{ f: 660, t0: 0,     d: 0.032, g: 0.16, w: 'sine' },
              { f: 990, t0: 0.032, d: 0.034, g: 0.16, w: 'sine' }],
    error:   [{ f: 220, t0: 0,     d: 0.060, g: 0.20, w: 'square' },
              { f: 233, t0: 0,     d: 0.060, g: 0.12, w: 'sawtooth' }]
  };

  function renderTones(list, context) {
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var o = context.createOscillator();
      var g = context.createGain();
      o.type = s.w;
      o.frequency.value = s.f;
      var t = context.currentTime + s.t0;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(s.g, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + s.d);
      o.connect(g); g.connect(context.destination);
      o.start(t); o.stop(t + s.d + 0.02);
    }
  }

  window.__playCue = function (type) {
    renderTones(CUES[type] || CUES.press, ac());
    return true;
  };

  // 预热：建 AudioContext + 用一段 1 样本的静音真正把输出设备/音频线程拉起来
  // （Windows 上首次 WASAPI 打开是几十到上百毫秒，正好压在第一次 cue 上）。
  // 建窗后调一次，之后 cue 只剩排音的时间。
  window.__primeAudio = function () {
    try {
      var c = ac();
      var buf = c.createBuffer(1, 1, c.sampleRate);
      var s = c.createBufferSource();
      var g = c.createGain();
      g.gain.value = 0.0001;
      s.buffer = buf;
      s.connect(g); g.connect(c.destination);
      s.start(0);
      s.onended = function () { try { s.disconnect(); } catch (e) {} };
      return c.state;
    } catch (e) {
      return 'fail:' + e;
    }
  };

  // 离线渲染同一份音色，用于自检：没有声卡也能验证"有声音 + 时长 <100ms"
  window.__renderCue = function (type) {
    var list = CUES[type] || CUES.press;
    var len = 0;
    for (var i = 0; i < list.length; i++) { len = Math.max(len, list[i].t0 + list[i].d); }
    var off = new OfflineAudioContext(1, Math.ceil(44100 * (len + 0.02)), 44100);
    renderTones(list, off);
    return off.startRendering().then(function (buf) {
      var d = buf.getChannelData(0), peak = 0, sum = 0;
      for (var i = 0; i < d.length; i++) { var v = Math.abs(d[i]); if (v > peak) { peak = v; } sum += d[i] * d[i]; }
      return { durationMs: Math.round(buf.duration * 1000), peak: +peak.toFixed(4), rms: +Math.sqrt(sum / d.length).toFixed(4) };
    });
  };

  window.__stopSpeech = function () {
    if (src) { try { src.stop(); } catch (e) { /* 已结束 */ } src = null; }
    return true;
  };

  window.__playSpeech = function (b64, mime) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    var c = ac();
    return c.decodeAudioData(bytes.buffer).then(function (buf) {
      return new Promise(function (resolve) {
        window.__stopSpeech();
        src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        var ms = Math.round(buf.duration * 1000);
        var done = false;
        src.onended = function () { if (!done) { done = true; src = null; resolve(ms); } };
        src.start();
        setTimeout(function () { if (!done) { done = true; src = null; resolve(ms); } }, ms + 3000);
      });
    });
  };

  // v2.4.0 延迟度量专用：与 __playSpeech 同样的播法，但**音频真正开始的那一刻**就 resolve
  // 相对延迟，不等播完。__playSpeech 留给业务逻辑（它要等 ended 才返回时长），两者互不影响。
  // 返回 { startDelayMs, durationMs }：startDelayMs = 进入函数 → 排音完成（≈ 首声时刻）。
  window.__playSpeechTimed = function (b64, mime) {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    var c = ac();
    return c.decodeAudioData(bytes.buffer).then(function (buf) {
      return new Promise(function (resolve) {
        window.__stopSpeech();
        src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        var ms = Math.round(buf.duration * 1000);
        src.onended = function () { src = null; };
        src.start();
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        resolve({ startDelayMs: Math.round(now - t0), durationMs: ms });
      });
    });
  };

  // TTS 不可用时的最后兜底：浏览器内置语音合成。
  // Linux 上 Chromium 没有装语音后端时 getVoices() 是空的，此时 speak() 不出声，
  // 必须如实返回失败，不能让上层以为播报成功了（基线铁律：不要静默失败）。
  window.__speakFallback = function (text) {
    if (!('speechSynthesis' in window)) return { ok: false, reason: 'no-speechSynthesis' };
    var voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return { ok: false, reason: 'no-voices', voices: 0 };
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      return { ok: true, voices: voices.length };
    } catch (e) { return { ok: false, reason: String(e) }; }
  };

  window.__audioState = function () { return ctx ? ctx.state : 'none'; };
})();
</script></body></html>`;

let audioWin = null;
let readyPromise = null;

/** 常驻隐藏音频窗口：启动时预热，保证第一次提示音不用等建窗口 */
function ensureAudioWindow() {
  if (readyPromise && audioWin && !audioWin.isDestroyed()) return readyPromise;
  audioWin = new BrowserWindow({
    show: false,
    width: 120,
    height: 80,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  readyPromise = audioWin
    .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(AUDIO_PAGE))
    .then(() => primeAudio(audioWin))
    .then(() => audioWin)
    .catch(() => null);
  return readyPromise;
}

/**
 * 建窗后预热 AudioContext（压掉第一次 cue 的 context 创建 + 输出设备打开开销）。
 * 预热失败绝不影响窗口可用性：cue 仍会自己 ac() 兜底，失败也照样如实返回 {ok:false}。
 */
async function primeAudio(win) {
  try {
    if (win && !win.isDestroyed()) await win.webContents.executeJavaScript('window.__primeAudio()');
  } catch (e) {
    /* 预热失败不致命 */
  }
}

function disposeAudioWindow() {
  if (audioWin && !audioWin.isDestroyed()) {
    try {
      audioWin.destroy();
    } catch (e) {
      /* noop */
    }
  }
  audioWin = null;
  readyPromise = null;
}

// ---- 播报去重 / 节流 ----
const lastSpokenAt = new Map();
let chain = Promise.resolve();
let pending = 0;
const MAX_PENDING = 4;

function normalizeText(t) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > C.A11Y_ANNOUNCE_MAX_CHARS ? `${s.slice(0, C.A11Y_ANNOUNCE_MAX_CHARS)}…` : s;
}

// 引擎返回的实际音频格式 → 解码用 MIME。禁止写死 audio/mpeg：
// 本地 SAPI（NVSA）返回 wav，在线 Edge 才返回 mp3（见 backends/*.js 的 TtsResult.format）。
const FORMAT_MIME = { wav: 'audio/wav', mp3: 'audio/mpeg' };
function mimeOfFormat(fmt) {
  return FORMAT_MIME[String(fmt || '').toLowerCase()] || 'audio/mpeg';
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: 'TIMEOUT' }), ms)),
  ]);
}

async function stopSpeech() {
  const win = await ensureAudioWindow();
  if (!win) return;
  try {
    await win.webContents.executeJavaScript('window.__stopSpeech()');
  } catch (e) {
    /* noop */
  }
}

/** 真正合成并播放一段语音 */
async function speakNow(text) {
  const win = await ensureAudioWindow();
  let b64 = '';
  let fmt = 'mp3'; // 仅在拿不到引擎格式时的保守默认值
  let mime = mimeOfFormat(fmt);
  try {
    // 只读使用 ttsBridge（δ 独占文件，此处不改其任何实现）
    // eslint-disable-next-line global-require
    const { getBridge } = require('./ttsBridge');
    const r = await getBridge().synthesize(text, {});
    b64 = Buffer.from(r.audioData).toString('base64');
    // 按引擎实际返回格式决定（本地 wav / 在线 mp3），写死 mp3 会让 wav 解码失败
    fmt = r.format || fmt;
    mime = mimeOfFormat(fmt);
  } catch (e) {
    if (win) {
      try {
        const fb = await win.webContents.executeJavaScript(
          `window.__speakFallback(${JSON.stringify(text)})`
        );
        if (fb && fb.ok) {
          return { ok: true, via: 'webspeech', durationMs: 0, degraded: true, voices: fb.voices };
        }
        // 兜底也没声音 => 明确报失败，让上层去提示用户，而不是假装播了
        return {
          ok: false,
          code: 'TTS_UNAVAILABLE',
          message: `语音不可用（${(fb && fb.reason) || '未知原因'}）：${e.message || e}`,
        };
      } catch (e2) {
        /* 继续返回失败 */
      }
    }
    // 不静默失败：把原因交给上层，由上层决定怎么告诉用户
    return { ok: false, code: e.code || C.ERR.TTS_SYNTH_FAIL, message: e.message || String(e) };
  }

  if (!win) return { ok: false, code: 'NO_AUDIO_WINDOW', message: '音频窗口不可用' };
  try {
    const durationMs = await withTimeout(
      win.webContents.executeJavaScript(
        `window.__playSpeech(${JSON.stringify(b64)}, ${JSON.stringify(mime)})`
      ),
      60000
    );
    if (durationMs && durationMs.code === 'TIMEOUT') {
      return { ok: false, code: 'PLAY_TIMEOUT', message: '语音播放超时' };
    }
    return { ok: true, via: 'tts', format: fmt, durationMs: durationMs || 0 };
  } catch (e) {
    // 不静默失败：解码/播放失败（例如本地 wav 解不出来）时先回落到浏览器内置语音，
    // 兜底也不出声才把原因如实上报，让上层提示用户。
    try {
      const fb = await win.webContents.executeJavaScript(
        `window.__speakFallback(${JSON.stringify(text)})`
      );
      if (fb && fb.ok) {
        return {
          ok: true,
          via: 'webspeech',
          durationMs: 0,
          degraded: true,
          recoveredFrom: 'PLAY_FAIL',
          voices: fb.voices,
        };
      }
      return {
        ok: false,
        code: 'PLAY_FAIL',
        message: `语音播放失败（${e.message || e}）；兜底语音也不可用（${(fb && fb.reason) || '未知原因'}）`,
      };
    } catch (e2) {
      return { ok: false, code: 'PLAY_FAIL', message: e.message || String(e) };
    }
  }
}

/**
 * 播报一段状态文本
 * @param {{text:string, priority?:'high'|'normal'}} payload
 * @returns {Promise<{ok:boolean, skipped?:string, via?:string, code?:string, message?:string}>}
 */
async function announce(payload) {
  const p = payload || {};
  const text = normalizeText(p.text);
  if (!text) return { ok: false, code: 'EMPTY_TEXT', message: '播报文本为空' };
  const priority = p.priority === 'high' ? 'high' : 'normal';

  // 去重：同一句话短时间内不重复播报（低视力用户重复按热键时尤其重要）
  const now = Date.now();
  const prev = lastSpokenAt.get(text) || 0;
  if (prev && now - prev < C.A11Y_ANNOUNCE_DEDUPE_MS[priority]) {
    return { ok: true, skipped: 'dedupe' };
  }
  lastSpokenAt.set(text, now);
  if (lastSpokenAt.size > 50) {
    // 简单限速：丢弃最旧的一半
    const keys = Array.from(lastSpokenAt.keys()).sort(
      (a, b) => lastSpokenAt.get(a) - lastSpokenAt.get(b)
    );
    keys.slice(0, Math.floor(keys.length / 2)).forEach((k) => lastSpokenAt.delete(k));
  }

  if (priority === 'high') {
    // 打断：停掉当前语音，并丢弃排队中的普通播报（它们已经过期）
    await stopSpeech();
    const dropped = pending;
    chain = Promise.resolve();
    pending = 0;
    const r = await speakNow(text);
    return { ...r, priority, interrupted: true, dropped };
  }

  if (pending >= MAX_PENDING) return { ok: true, skipped: 'queue_full', priority };
  pending += 1;
  const task = chain.then(() => speakNow(text)).catch((e) => ({ ok: false, message: String(e) }));
  chain = task.then(
    () => undefined,
    () => undefined
  );
  const r = await task;
  pending = Math.max(0, pending - 1);
  return { ...r, priority };
}

/**
 * 播放极短促的非语音提示音（<100ms）
 * @param {'press'|'success'|'error'} type
 */
async function cue(type) {
  const t = C.A11Y_CUE_TYPES.indexOf(type) >= 0 ? type : 'press';
  const win = await ensureAudioWindow();
  if (!win) return { ok: false, code: 'NO_AUDIO_WINDOW', message: '音频窗口不可用' };
  try {
    await win.webContents.executeJavaScript(`window.__playCue(${JSON.stringify(t)})`);
    return { ok: true, type: t };
  } catch (e) {
    return { ok: false, code: 'CUE_FAIL', message: e.message || String(e) };
  }
}

/** 自检：离线渲染三种提示音，返回时长与能量（没有声卡也能验证） */
async function selfTestCues() {
  const win = await ensureAudioWindow();
  if (!win) return { ok: false, code: 'NO_AUDIO_WINDOW' };
  const out = {};
  for (const t of C.A11Y_CUE_TYPES) {
    // eslint-disable-next-line no-await-in-loop
    out[t] = await win.webContents.executeJavaScript(`window.__renderCue(${JSON.stringify(t)})`);
  }
  return { ok: true, cues: out, audioState: await win.webContents.executeJavaScript('window.__audioState()') };
}

/** 在 ipc.js 的 registerIpc 里调用一行即可 */
function registerA11yIpc() {
  ipcMain.handle(C.IPC_A11Y_ANNOUNCE, (_e, payload) => announce(payload || {}));
  ipcMain.handle(C.IPC_A11Y_CUE, (_e, payload) => cue((payload && payload.type) || 'press'));
  ensureAudioWindow(); // 预热：第一次提示音不付出建窗口的延迟
}

module.exports = { registerA11yIpc, announce, cue, selfTestCues, ensureAudioWindow, disposeAudioWindow };
