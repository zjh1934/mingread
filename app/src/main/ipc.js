// ipcMain 注册：TTS（Edge 单一方案）/ 划词朗读 / 文件 / 导出 / 系统能力。
'use strict';

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, clipboard } = require('electron');
const { getBridge } = require('./ttsBridge');
const voiceSetup = require('./voiceSetup');
const exporter = require('./exporter');
const { readSelection } = require('./selectionReader');
const { registerA11yIpc } = require('./a11yFeedback');
const settingsStore = require('./settingsStore');
const voiceSources = require('./voiceSources');
const { startClipboardMonitor } = require('./clipboardMonitor');
const floatBall = require('./floatBall');
const zoomController = require('./zoomController');
const cursorSize = require('./cursorSize');

function b64(u8) {
  return Buffer.from(u8).toString('base64');
}

function sendToWindow(getWindow, channel, payload) {
  const win = getWindow && getWindow();
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      /* 渲染进程未就绪时丢弃 */
    }
  }
}

/** 读取文本文件：优先 UTF-8，失败则按 GBK 解码（中文 txt 常见），避免乱码 */
function readTextFile(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e2) {
      return buf.toString('utf8');
    }
  }
}

/** ---- v2.2 系统设置（settings.json 为权威源）---- */

// registerIpc 注入的上下文（模块级 helper 共享）
let _getWindow = null;
let _state = null;

/** 当前系统设置快照（供 settings:getSystem 与 settings:system 广播共用） */
function systemSettingsSnapshot() {
  let s = {};
  try {
    s = settingsStore.getSettings();
  } catch (e) {
    /* 用 state 兜底 */
  }
  return {
    hotkey: _state.hotkey || s.hotkey || 'F1',
    clipboardAuto: !!_state.clipboardAuto,
    floatBallEnabled: s.floatBallEnabled !== false,
    hotkeyOk: !!_state.hotkeyOk,
    // α-视觉增强（低视力）：字号档位与悬浮球尺寸，权威源同样在 settings.json
    fontScale: Number(s.fontScale) || 1,
    floatBallSize: Number(s.floatBallSize) || 56,
  };
}

function broadcastSystemSettings() {
  sendToWindow(_getWindow, 'settings:system', systemSettingsSnapshot());
}

/** 剪贴板监视启停（仅 clipboardAuto===true 时运行） */
function applyClipboardAuto(on) {
  if (on) {
    if (typeof _state.stopClipboard === 'function') return;
    _state.stopClipboard = startClipboardMonitor(_getWindow, () => _state.clipboardAuto);
    console.log('[clipboard] monitor started (900ms)');
  } else if (typeof _state.stopClipboard === 'function') {
    _state.stopClipboard();
    _state.stopClipboard = null;
    console.log('[clipboard] monitor stopped');
  }
}

/** 应用热键：校验 → state → reregister → 记录 hotkeyOk */
function applyHotkey(hotkey) {
  const hk = typeof hotkey === 'string' ? hotkey.trim() : '';
  if (!hk) return { ok: false, error: '热键不能为空' };
  _state.hotkey = hk;
  if (_state.hotkeyRef && typeof _state.hotkeyRef.reregister === 'function') {
    _state.hotkeyRef.reregister();
  }
  _state.hotkeyOk = !!(
    _state.hotkeyRef &&
    typeof _state.hotkeyRef.isRegistered === 'function' &&
    _state.hotkeyRef.isRegistered()
  );
  return { ok: true, hotkey: hk, hotkeyOk: _state.hotkeyOk };
}

/**
 * 保存系统设置（patch 可含 hotkey / clipboardAuto / floatBallEnabled / floatBallPos / zoom* 前缀键）。
 * 每项落盘 settings.json；返回 {ok:true, settings} 或 {ok:false, error}。
 * v2.3：zoom* 前缀键（zoomEnabled/zoomFrameLimit/zoomClickThrough/zoomFollowMode/zoomTrigger 等）
 * 一并持久化，并调 zoomController.applySettingsPatch 热应用；zoomEnabled=false 时控制器 deactivate。
 */
function saveSystemSettings(patch) {
  const p = patch || {};
  const persist = {};
  try {
    if ('hotkey' in p) {
      const r = applyHotkey(p.hotkey);
      if (!r.ok) return { ok: false, error: r.error };
      persist.hotkey = r.hotkey;
    }
    if ('clipboardAuto' in p) {
      _state.clipboardAuto = !!p.clipboardAuto;
      persist.clipboardAuto = _state.clipboardAuto;
      applyClipboardAuto(_state.clipboardAuto);
    }
    if ('floatBallEnabled' in p) {
      persist.floatBallEnabled = !!p.floatBallEnabled;
      floatBall.setEnabled(!!p.floatBallEnabled);
    }
    if ('floatBallPos' in p) {
      persist.floatBallPos = p.floatBallPos || null;
      if (p.floatBallPos) floatBall.setPosition(p.floatBallPos);
      else floatBall.resetPosition();
    }
    // α-视觉增强（低视力）：字号档位 / 悬浮球尺寸 → persist + 运行时热应用
    if ('fontScale' in p) persist.fontScale = Number(p.fontScale) || 1;
    if ('floatBallSize' in p) {
      persist.floatBallSize = Number(p.floatBallSize) || 56;
      if (typeof floatBall.applySettingsPatch === 'function') {
        floatBall.applySettingsPatch({ floatBallSize: persist.floatBallSize });
      }
    }
    // v2.3 屏幕缩放：识别 zoom* 前缀键 → persist + 运行时热应用
    const zoomKeys = Object.keys(p).filter((k) => k.indexOf('zoom') === 0);
    if (zoomKeys.length > 0) {
      zoomKeys.forEach((k) => {
        persist[k] = p[k];
      });
      const zoomCtl = zoomController.getZoomController();
      if (zoomCtl && typeof zoomCtl.applySettingsPatch === 'function') zoomCtl.applySettingsPatch(p);
    }
    const settings = settingsStore.saveSettings(persist);
    broadcastSystemSettings();
    // 热键重注册 / 开关变化：同步广播给悬浮球
    floatBall.broadcastState();
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** ---- 播放状态桥接（渲染 → 主 → 悬浮球），服务端节流 ≥300ms ---- */
let lastReportAt = 0;
let reportTimer = null;
let pendingReport = null;

function processPlaybackReport(payload) {
  const p = payload || {};
  _state.playback = {
    isPlaying: !!p.isPlaying,
    buffering: !!p.buffering,
    hasAudio: !!p.hasAudio,
  };
  floatBall.broadcastState();
}

function registerIpc(getWindow, state) {
  _getWindow = getWindow;
  _state = state;
  ipcMain.handle('app:info', () => {
    // eslint-disable-next-line global-require
    const C = require('../shared/constants');
    return { name: C.APP_NAME, version: C.APP_VERSION };
  });

  // ---- 语音状态（只有一条链路）----
  ipcMain.handle('voice:getStatus', () => {
    try {
      return getBridge().getStatus();
    } catch (e) {
      return { error: { message: e.message }, voices: [], engine: { ready: false } };
    }
  });

  ipcMain.handle('voice:setVoiceId', (_e, id) => voiceSetup.setVoiceId(id));
  ipcMain.handle('voice:savePrefs', (_e, patch) => voiceSetup.saveReadingPrefs(patch || {}));
  ipcMain.handle('voice:refresh', () => {
    voiceSetup.broadcastStatus();
    return getBridge().getStatus();
  });

  // ---- v2.4.0 离线语音一键部署（本地 NVSA 引擎，用户诉求「不要延迟」的根治项）----
  // 状态机在 voiceDeploy.js；这里只暴露三件事：读状态 / 触发检测 / 触发安装。
  // 安装过程最多弹一次 UAC；任何失败都不影响使用 —— Edge 兜底链始终完整。
  // 延迟加载：voiceDeploy 会间接用到 ttsBridge，避免与顶部 require 形成循环依赖。
  const voiceDeploy = require('./voiceDeploy').getVoiceDeploy();
  ipcMain.handle('voice:deploy:getState', () => voiceDeploy.getSnapshot());
  ipcMain.handle('voice:deploy:detect', () => voiceDeploy.detect({ announce: false }));
  ipcMain.handle('voice:deploy:install', () => voiceDeploy.install());
  // W-VOICESRC：只装「某个音色源里的一件」；状态机与 install() 共用，失败分支一致
  ipcMain.handle('voice:deploy:installVoice', (_e, key) => voiceDeploy.installVoice(key));
  voiceDeploy.onStateChanged((s) => sendToWindow(getWindow, 'voice:deploy:state', s));

  // ---- W-VOICESRC 音色源（用户自建仓库）----
  // 这里只做「增删查」：清单的抓取/校验/合并在 voiceSources.js，UI 不碰文件与网络。
  const voiceSourceEntries = () => {
    try {
      const s = settingsStore.getSettings();
      return Array.isArray(s.voiceSources) ? s.voiceSources : [];
    } catch (e) {
      return [];
    }
  };

  const listVoiceSources = async () => {
    try {
      return await voiceSources.loadSources();
    } catch (e) {
      return {
        ok: false,
        at: Date.now(),
        sources: [],
        voices: voiceSources.builtinVoices(),
        warnings: [],
        errors: [{ sourceId: 'builtin', code: 'SRC_LOAD', message: e.message || String(e) }],
      };
    }
  };

  ipcMain.handle('voice:source:list', () => listVoiceSources());
  ipcMain.handle('voice:source:refresh', async () => {
    voiceSources.invalidateCache();
    return listVoiceSources();
  });

  ipcMain.handle('voice:source:add', async (_e, payload) => {
    const made = voiceSources.makeSourceEntry(payload || {});
    if (!made.ok) return { ok: false, error: made.error };
    const prev = voiceSourceEntries();
    // 同一地址重复添加 = 更新（id 由地址派生），不会在列表里出现两条
    const next = prev.filter((x) => !x || x.id !== made.entry.id).concat([{ ...made.entry, addedAt: Date.now() }]);
    settingsStore.saveSettings({ voiceSources: next });
    voiceSources.invalidateCache();
    const result = await listVoiceSources();
    const source = result.sources.find((s) => s.id === made.entry.id) || null;
    return { ok: true, entry: made.entry, source, result };
  });

  ipcMain.handle('voice:source:remove', (_e, id) => {
    const key = typeof id === 'string' ? id.trim() : '';
    if (!key) return { ok: false, error: { code: 'SRC_ENTRY_INVALID', message: '缺少要删除的源 id' } };
    const next = voiceSourceEntries().filter((x) => !x || x.id !== key);
    settingsStore.saveSettings({ voiceSources: next });
    voiceSources.invalidateCache();
    return { ok: true, voiceSources: next };
  });

  // 本地清单选择器：只认 .json，避免用户误选别的文件
  ipcMain.handle('voice:source:pick', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win || undefined, {
      title: '选择音色源清单（JSON）',
      properties: ['openFile'],
      filters: [
        { name: '音色源清单', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled || !res.filePaths || !res.filePaths.length ? null : res.filePaths[0];
  });

  // 试听
  ipcMain.handle('voice:preview', async (_e, payload) => {
    const { voiceId, text, opts } = payload || {};
    try {
      const res = await getBridge().synthesize(text || '你好，我是明读，这是音色试听。', {
        ...(opts || {}),
        voiceId,
      });
      return {
        ok: true,
        audioData: b64(res.audioData),
        sampleRate: res.sampleRate,
        durationMs: res.durationMs,
        // v2.4：本地 SAPI 输出 wav，Edge 输出 mp3，格式由引擎决定（不再写死 mp3）
        format: res.format || 'mp3',
        engine: res.engine,
        notice: res.degraded ? '本地语音不可用，当前使用在线语音' : undefined,
      };
    } catch (e) {
      voiceSetup.setLastError(e);
      return { ok: false, code: e.code, message: e.message };
    }
  });

  // ---- 划词朗读：抓取系统当前选中文字 ----
  ipcMain.handle('selection:read', async () => {
    try {
      const r = await readSelection();
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, message: e.message || String(e) };
    }
  });

  // ---- v2.3 无障碍反馈（β renderer → γ main）：状态播报 + 非语音提示音 ----
  registerA11yIpc();

  // ---- 合成 ----
  ipcMain.handle('tts:listVoices', () => {
    try {
      return getBridge().listVoices();
    } catch (e) {
      return [];
    }
  });

  ipcMain.handle('tts:splitSentences', (_e, payload) => {
    // eslint-disable-next-line global-require
    const { splitSentences } = require('./util');
    return { ok: true, sentences: splitSentences((payload && payload.text) || '') };
  });

  /** 单句合成（逐句流式播放用） */
  ipcMain.handle('tts:synthOne', async (_e, payload) => {
    const { text, opts } = payload || {};
    try {
      const r = await getBridge().synthesize(text, opts || {});
      return {
        ok: true,
        audioData: b64(r.audioData),
        sampleRate: r.sampleRate,
        durationMs: r.durationMs,
        // v2.4：格式由引擎决定（本地 sapi=wav / 在线 edge=mp3）
        format: r.format || 'mp3',
        engine: r.engine,
        fellBack: !!r.degraded,
        notice: r.degraded ? '本地语音不可用，当前使用在线语音' : undefined,
      };
    } catch (e) {
      voiceSetup.setLastError(e);
      return { ok: false, code: e.code || 'TTS_SYNTH_FAIL', message: e.message };
    }
  });

  /** 整段合成（导出用；内部按段切分后拼接） */
  ipcMain.handle('tts:synthesize', async (_e, payload) => {
    const { text, opts } = payload || {};
    try {
      const r = await getBridge().synthesize(text, opts || {});
      return {
        ok: true,
        audioData: b64(r.audioData),
        sampleRate: r.sampleRate,
        durationMs: r.durationMs,
        sentences: r.sentences,
        // v2.4：格式由引擎决定（本地 sapi=wav / 在线 edge=mp3）
        format: r.format || 'mp3',
        engine: r.engine,
      };
    } catch (e) {
      voiceSetup.setLastError(e);
      return { ok: false, code: e.code || 'TTS_SYNTH_FAIL', message: e.message };
    }
  });

  ipcMain.handle('tts:export', async (_e, payload) => {
    const { text, opts, outPath, baseName } = payload || {};
    return exporter.exportCurrent({ text, opts, outPath, baseName });
  });

  ipcMain.handle('tts:subtitle', (_e, payload) => {
    const { sentences, format } = payload || {};
    return format === 'lrc' ? exporter.generateLrc(sentences || []) : exporter.generateSrt(sentences || []);
  });

  // ---- 文件 / 剪贴板 ----
  ipcMain.handle('file:read', (_e, filePath) => {
    try {
      if (path.extname(filePath).toLowerCase() === '.epub') {
        // eslint-disable-next-line global-require
        const { readEpub } = require('./epubReader');
        return readEpub(filePath);
      }
      return { ok: true, content: readTextFile(filePath) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('clipboard:read', () => {
    try {
      return clipboard.readText();
    } catch (e) {
      return '';
    }
  });

  ipcMain.handle('clipboard:auto', (_e, value) => {
    // 兼容旧调用：内部转走 saveSystem 逻辑（state + 监视启停 + 落盘 + 广播）
    const r = saveSystemSettings({ clipboardAuto: !!value });
    return !!r.ok;
  });

  ipcMain.handle('dialog:openFile', async () => {
    const win = getWindow();
    const res = await dialog.showOpenDialog(win || undefined, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本 / 电子书', extensions: ['txt', 'md', 'epub'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths;
  });

  ipcMain.handle('dialog:save', async (_e, payload) => {
    const win = getWindow();
    const res = await dialog.showSaveDialog(win || undefined, {
      defaultPath: (payload && payload.defaultName) || '朗读音频.mp3',
      // 本地 SAPI 产出 wav，在线 Edge 产出 mp3：两种都要能选，否则 wav 会被强制改名
      filters: [
        { name: 'MP3', extensions: ['mp3'] },
        { name: 'WAV', extensions: ['wav'] },
      ],
    });
    return res.canceled ? null : res.filePath;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    try {
      shell.openExternal(url);
      return true;
    } catch (e) {
      return false;
    }
  });

  // ---- v3.1 系统鼠标指针设置（只读当前值 + 打开系统设置页）----
  // 注意：这里不接受渲染层传进来的 URI。URI 由主进程按平台决定，
  // 免得把一个「打开设置」通道变成任意协议启动器。
  ipcMain.handle('system:cursorSize:get', () => cursorSize.getState());

  ipcMain.handle('system:cursorSize:openSettings', async () => {
    const t = cursorSize.settingsTarget();
    if (t.uri) {
      try {
        await shell.openExternal(t.uri);
        return { ok: true, message: t.message, via: t.uri };
      } catch (e) {
        // 极简系统可能没注册 ms-settings 协议，落到兜底入口
      }
    }
    if (t.fallback) {
      try {
        // eslint-disable-next-line global-require
        const { spawn } = require('child_process');
        const parts = t.fallback.split(' ').filter(Boolean);
        spawn(parts[0], parts.slice(1), { detached: true, stdio: 'ignore', windowsHide: false }).unref();
        return { ok: true, message: t.message, via: t.fallback };
      } catch (e) {
        return { ok: false, message: `打不开系统设置：${e && e.message ? e.message : e}` };
      }
    }
    return { ok: false, message: '当前系统不支持一键打开指针设置' };
  });

  // ---- v2.2 系统设置（settings.json 权威源）----
  ipcMain.handle('settings:getSystem', () => systemSettingsSnapshot());

  ipcMain.handle('settings:saveSystem', (_e, patch) => saveSystemSettings(patch || {}));

  // 兼容旧渲染层调用：内部转走 saveSystem 逻辑（persist + reregister + 广播）
  ipcMain.handle('settings:hotkey', (_e, value) => {
    const r = saveSystemSettings({ hotkey: value });
    return !!r.ok;
  });

  // ---- 播放状态桥接：渲染 → 主进程 → 悬浮球（服务端节流 ≥300ms，带尾沿补偿）----
  ipcMain.on('playback:reportState', (_e, payload) => {
    const now = Date.now();
    const wait = 300 - (now - lastReportAt);
    if (wait <= 0) {
      if (reportTimer) {
        clearTimeout(reportTimer);
        reportTimer = null;
      }
      pendingReport = null;
      lastReportAt = now;
      processPlaybackReport(payload);
    } else {
      // 节流窗口内：只保留最新载荷，到点后补发一次，避免末态丢失
      pendingReport = payload;
      if (!reportTimer) {
        reportTimer = setTimeout(() => {
          reportTimer = null;
          lastReportAt = Date.now();
          const p = pendingReport;
          pendingReport = null;
          processPlaybackReport(p);
        }, wait);
      }
    }
  });

  // ---- 悬浮球 IPC（窗口与处理函数在 floatBall.js）----
  // v2.3：透传整个载荷（menu 命令带 width/height，用于球窗口临时扩容）
  ipcMain.on('floatBall:cmd', (_e, payload) => {
    floatBall.handleCmd(typeof payload === 'string' ? { cmd: payload } : payload || {});
  });
  ipcMain.on('floatBall:dragStart', () => floatBall.handleDragStart());
  ipcMain.on('floatBall:dragMove', (_e, payload) => floatBall.handleDragMove(payload || {}));
  ipcMain.on('floatBall:dragEnd', () => floatBall.handleDragEnd());

  voiceSetup.onStatusChanged((s) => sendToWindow(getWindow, 'voice:statusChanged', s));

  return { broadcastSystemSettings, systemSettingsSnapshot };
}

module.exports = { registerIpc };
