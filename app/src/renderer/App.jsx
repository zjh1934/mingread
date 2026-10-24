import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Snackbar, Alert, Button, IconButton, Popover, Badge, CircularProgress, Tooltip, Typography } from '@mui/material';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import TimerIcon from '@mui/icons-material/Timer';
import TuneIcon from '@mui/icons-material/Tune';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
// v2.4.0 IA：无播放态下的「朗读下方文本」入口图标
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

import { useSettings } from './store/settingsStore';
import { useStreamingPlayback } from './hooks/useStreamingPlayback';
import { useTts } from './hooks/useTts';
import announcer from './services/announcer';
import { fs, su } from './theme'; // α：px → rem/calc(px*scale)，随字号档位缩放

import TopBar from './components/TopBar';
import Editor from './components/Editor';
import Controls from './components/Controls';
import VoicePicker from './components/VoicePicker';
import TimerPanel from './components/TimerPanel';
import TuningPanel from './components/TuningPanel';
import SettingsDialog from './components/SettingsDialog';
// v2.4.0：离线语音（NVSA 本地引擎）一键部署引导。未就绪时在内容区顶部显示一张卡片，
// 装好后组件自身返回 null，不占首屏、不干扰朗读。
import VoiceDeployGate from './components/VoiceDeployGate';
// v2.4.0 IA 重构：首屏状态卡（把「选中→按 F1」这条主用法放到第一眼位置）
import HeroStatus from './components/HeroStatus';

const SAMPLE_TEXT =
  '朗读女 Neo 是面向低视力人群的无障碍辅助工具：屏幕放大、高对比度、把看不清的文字读出来。\n\n语音默认走本地 NVSA（离线、百毫秒级），不可用时自动回落到微软 Edge 在线神经语音（晓晓 / 云希）。\n\n在任意程序里选中文字后按 F1，可以直接朗读选中的内容，不会覆盖这里的文本。';

function bridge() {
  return typeof window !== 'undefined' ? window.langdu : null;
}

export default function App() {
  const themeMode = useSettings((s) => s.themeMode);
  const setSettings = useSettings((s) => s.set);
  const voiceStatus = useSettings((s) => s.voiceStatus);
  const voiceId = useSettings((s) => s.voiceId);
  const rate = useSettings((s) => s.rate);
  const pitch = useSettings((s) => s.pitch);
  const volume = useSettings((s) => s.volume);
  const hotkey = useSettings((s) => s.hotkey);
  const hotkeyOk = useSettings((s) => s.hotkeyOk);

  const [text, setText] = useState(SAMPLE_TEXT);
  const [chapters, setChapters] = useState([]);
  const [bookTitle, setBookTitle] = useState('');
  const [activeChapter, setActiveChapter] = useState(-1);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snack, setSnack] = useState(null);
  const [zoomState, setZoomState] = useState(null); // 屏幕缩放运行时状态 {active, zoom, paused, trigger}
  const [previewingId, setPreviewingId] = useState(null);
  // v2.4.0 IA：播放器默认收起。首屏先回答「这个窗口怎么用」，用户真的要读文本时才展开播放器。
  // 否则默认的 131 字示例文本会让播放器永远占满首屏，把主用法（选中→F1）挤到角落。
  const [playerOpened, setPlayerOpened] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectionChars, setSelectionChars] = useState(0);
  // 主界面信息架构（朗读即状态页）：Editor 默认收起；次级入口用弹层承载
  const [editorOpen, setEditorOpen] = useState(false);
  const [voiceAnchor, setVoiceAnchor] = useState(null);
  const [timerAnchor, setTimerAnchor] = useState(null);
  const [tuneAnchor, setTuneAnchor] = useState(null);

  const textRef = useRef(text);
  textRef.current = text;
  const previewAudioRef = useRef(null);
  const manualStopAtRef = useRef(0); // 最近一次「手动停止」时间戳：用于区分停止与定时到点
  const timerArmedRef = useRef(false); // 定时关闭是否已上膛
  const synthTimerRef = useRef(null); // 「正在合成」延迟播报计时器
  const playStateRef = useRef({ isPlaying: false, timerActive: false });
  const engineReadyRef = useRef(null); // null=尚未确认过可用（避免启动占位状态误报）
  const cmdRef = useRef({}); // 悬浮球 / 托盘下发的播放指令映射（带语音播报）

  /**
   * 双通道反馈：视觉 Snackbar + 语音播报。
   * @param {string} message 视觉文案（可以长，屏幕上看）
   * @param {string} severity info | success | warning | error
   * @param {object} opts { duration, say（播报文案，false=不播报）, priority, key }
   *   播报文案默认取 message；长文案请显式传简短的 say，避免念一大段。
   */
  const notify = useCallback((message, severity = 'info', opts = {}) => {
    setSnack({ message, severity, key: Date.now(), duration: opts.duration });
    if (opts.say === false) return;
    const text = typeof opts.say === 'string' ? opts.say : message;
    announcer.say(opts.key || text, text, { priority: opts.priority });
  }, []);

  const playback = useStreamingPlayback({
    onError: (msg) => notify(msg, 'warning'),
    onFatal: (msg) => notify(msg, 'error', { priority: 'high', duration: 8000 }),
    onNotice: (msg) => notify(msg, 'info'),
  });
  const { exporting, preview, exportAudio } = useTts();

  // 语音状态：启动读取一次 + 订阅主进程变化
  useEffect(() => {
    const api = bridge();
    useSettings.getState().refreshStatus();
    let off;
    try {
      off = api?.voice?.onStatusChanged?.((next) => {
        if (next) useSettings.getState().setVoiceStatus(next);
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  // 系统设置（热键/复制即读/悬浮球）：主进程是权威源，启动 hydrate + 持续同步广播
  useEffect(() => {
    let off;
    try {
      bridge()
        ?.getSystemSettings?.()
        .then((s) => {
          if (s) useSettings.getState().applySystemSettings(s);
        })
        .catch(() => {
          /* 主进程未就绪时保持默认值，保存设置时会再次下发 */
        });
      off = bridge()?.onSystemSettings?.((s) => {
        if (s) useSettings.getState().applySystemSettings(s);
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  // 热键被其他程序占用：明确提示如何解决
  useEffect(() => {
    let off;
    try {
      off = bridge()?.onHotkeyConflict?.((payload) => {
        const acc = (payload && payload.accelerator) || useSettings.getState().hotkey || 'F1';
        // 视觉给完整解决路径，语音只说结论 + 下一步
        notify(
          `热键 ${acc} 被其他程序占用，选中朗读暂不可用。请关闭占用 ${acc} 的程序，或在 设置 → 热键 中更换`,
          'warning',
          { duration: 8000, say: false }
        );
        announcer.announce('hotkeyConflict', { hotkey: acc }, { priority: 'high' });
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, [notify]);

  // 屏幕缩放运行时状态：激活时在顶部显示一条细状态条（倍率保留 1 位小数）
  useEffect(() => {
    let off;
    try {
      off = bridge()?.zoom?.onChanged?.((payload) => {
        if (payload && typeof payload === 'object') setZoomState(payload);
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  // 播放状态上报主进程（供悬浮球/托盘展示），组件内节流 ≥500ms（≤2 次/秒）
  const reportRef = useRef({ last: 0, timer: null });
  useEffect(() => {
    const state = { isPlaying: !!playback.isPlaying, buffering: !!playback.buffering, hasAudio: !!playback.hasAudio };
    const r = reportRef.current;
    const fire = () => {
      r.last = Date.now();
      r.timer = null;
      try {
        bridge()?.reportPlaybackState?.(state);
      } catch (e) {
        /* 上报失败不影响播放 */
      }
    };
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = null;
    }
    const wait = 500 - (Date.now() - r.last);
    if (wait <= 0) fire();
    else r.timer = setTimeout(fire, wait);
    return () => {
      if (r.timer) {
        clearTimeout(r.timer);
        r.timer = null;
      }
    };
  }, [playback.isPlaying, playback.buffering, playback.hasAudio]);
  useEffect(
    () => () => {
      if (reportRef.current.timer) clearTimeout(reportRef.current.timer);
    },
    []
  );

  // 悬浮球/托盘下发的播放控制指令（走带播报的包装函数，保证两个入口反馈一致）
  useEffect(() => {
    let off;
    try {
      off = bridge()?.onPlaybackCmd?.((payload) => {
        const cmd = payload && payload.cmd;
        const fn = cmdRef.current[cmd];
        if (typeof fn === 'function') fn();
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      if (typeof off === 'function') off();
    };
  }, []);

  // 音色 / 语速 / 语调 / 音量变化：防抖后交给播放器「从当前句用新参数重合成」
  const updatePlaybackOpts = playback.updateOptions;
  useEffect(() => {
    const t = setTimeout(() => {
      updatePlaybackOpts({ voiceId, rate, pitch, volume });
    }, 450);
    return () => clearTimeout(t);
  }, [voiceId, rate, pitch, volume, updatePlaybackOpts]);

  // 卸载时释放试听音频
  useEffect(
    () => () => {
      const a = previewAudioRef.current;
      if (a) {
        a.pause();
        if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      }
    },
    []
  );

  const stopPreview = useCallback(() => {
    const a = previewAudioRef.current;
    if (a) {
      a.pause();
      if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      previewAudioRef.current = null;
    }
    setPreviewingId(null);
  }, []);

  const handleRead = useCallback(
    async (rawText, options = {}) => {
      const content = String(rawText != null ? rawText : textRef.current).trim();
      if (!content) {
        notify('请先输入或导入要朗读的文本', 'warning', { say: false });
        announcer.announce('emptyText', {}, { priority: 'high' });
        return;
      }
      // 试听音频与正文朗读互斥，避免两路声音重叠
      stopPreview();
      setSelectionChars(options.fromSelection ? content.replace(/\s/g, '').length : 0);
      const s = useSettings.getState();
      const res = await playback.start(content, {
        voiceId: s.voiceId,
        rate: s.rate,
        pitch: s.pitch,
        volume: s.volume,
      });
      if (res && res.ok === false) {
        notify(`朗读失败：${res.error}`, 'error', { say: false, priority: 'high', duration: 8000 });
        announcer.announce('synthFailed', {}, { priority: 'high' });
        return;
      }
      // 立即播报「已开始朗读」：不必等第一句出声，用户才知道指令生效了
      announcer.announce('start');
    },
    [notify, playback, stopPreview]
  );

  const readRef = useRef(handleRead);
  readRef.current = handleRead;

  // 播放控制：先出反馈音（让用户知道指令已收到），再播报新状态
  const handlePlay = useCallback(() => {
    announcer.cue('press');
    if (playback.isPlaying) return;
    const resuming = !!playback.hasAudio;
    playback.play();
    announcer.announce(resuming ? 'resume' : 'start');
  }, [playback]);

  const handlePause = useCallback(() => {
    announcer.cue('press');
    if (!playback.isPlaying) return;
    playback.pause();
    announcer.announce('pause');
  }, [playback]);

  const handleStop = useCallback(() => {
    announcer.cue('press');
    if (!playback.hasAudio) return;
    manualStopAtRef.current = Date.now();
    playback.stop();
    announcer.reset();
    announcer.announce('stop');
  }, [playback]);

  const handlePrev = useCallback(() => {
    announcer.cue('press');
    if (!playback.hasAudio) return;
    playback.prev();
  }, [playback]);

  const handleNext = useCallback(() => {
    announcer.cue('press');
    if (!playback.hasAudio) return;
    playback.next();
  }, [playback]);

  const handleJump = useCallback(
    (index) => {
      if (!playback.hasAudio) return;
      playback.seekToSentence(index);
    },
    [playback]
  );

  cmdRef.current = { play: handlePlay, pause: handlePause, stop: handleStop, prev: handlePrev, next: handleNext };

  // 播放状态播报：开始 / 暂停 / 停止 / 正在合成 / 定时关闭触发
  useEffect(() => {
    const prev = playStateRef.current;
    const cur = { isPlaying: !!playback.isPlaying, timerActive: !!playback.timerActive };
    playStateRef.current = cur;

    // 出声后取消挂起的「正在合成」，避免两句连着念
    if (cur.isPlaying) announcer.cancelPending();

    // 定时到点：定时开启中 + 播放由真变假，且不是刚刚手动停止
    if (prev.timerActive && !cur.timerActive && prev.isPlaying && !cur.isPlaying) {
      if (Date.now() - manualStopAtRef.current > 5000) {
        timerArmedRef.current = false;
        notify('定时时间到，已停止朗读', 'success', { say: false, duration: 6000 });
        announcer.announce('timerStop', {}, { priority: 'high' });
      }
    }
  }, [playback.isPlaying, playback.timerActive, notify]);

  // 「正在合成」：合成卡顿超过 1.5 秒才播报，且 20 秒内不重复
  useEffect(() => {
    const busy = !!playback.buffering || !!playback.preparing;
    if (busy && !synthTimerRef.current) {
      synthTimerRef.current = setTimeout(() => {
        synthTimerRef.current = null;
        announcer.announce('synthesizing', {}, { minInterval: 20000 });
      }, 1500);
    } else if (!busy && synthTimerRef.current) {
      clearTimeout(synthTimerRef.current);
      synthTimerRef.current = null;
    }
  }, [playback.buffering, playback.preparing]);

  useEffect(
    () => () => {
      if (synthTimerRef.current) clearTimeout(synthTimerRef.current);
    },
    []
  );

  // 网络断开：语音引擎由「确认可用」变为不可用时明确告知（不静默降级）。
  // 注意：只在 true→false 跳变时告警；启动瞬间首帧的占位 ready=false 不算"断网"，
  // 否则每次启动都会误报一次"连不上网络"（引擎探测尚未完成）。
  useEffect(() => {
    const ready = !voiceStatus || voiceStatus.engine?.ready !== false;
    if (engineReadyRef.current === true && !ready) {
      notify('连不上网络，朗读需要联网，请检查网络后重试', 'warning', { say: false, duration: 8000 });
      announcer.announce('networkOffline', {}, { priority: 'high' });
    }
    // 首次确认可用后才开始跟踪可用性跳变；启动占位的 false 不落账（避免误报）
    if (engineReadyRef.current === null) {
      if (ready) engineReadyRef.current = true;
    } else {
      engineReadyRef.current = ready;
    }
  }, [voiceStatus, notify]);

  // 热键注册失败（主进程同步下来的 hotkeyOk=false）
  useEffect(() => {
    if (hotkeyOk !== false) return;
    notify('热键注册失败，可能已被其他程序占用，请在 设置 → 热键 中更换', 'warning', {
      say: false,
      duration: 8000,
    });
    announcer.announce('hotkeyConflict', { hotkey }, { priority: 'high' });
  }, [hotkeyOk, hotkey, notify]);

  // F1 划词朗读：只朗读选中文字，不覆盖编辑器内容，也不强制显示窗口
  useEffect(() => {
    const api = bridge();
    if (!api) return undefined;
    let offSelection;
    let offClipboard;
    let offHotkeyClip;
    try {
      offSelection = api.onReadSelection?.((payload) => {
        // 反馈音由主进程各入口（热键 / 悬浮球）统一负责，此处不再重复 cue，
        // 否则同一次触发会响两声（热键路径主进程已 cue + 这里再 cue）。
        const content = payload && payload.text ? String(payload.text).trim() : '';
        if (!content) {
          notify('没有选中文字：先在任意程序里选中一段文字再按 F1（或单击桌面悬浮球）', 'warning', {
            say: false,
            duration: 6000,
          });
          announcer.announce('noSelection', {}, { priority: 'high' });
          return;
        }
        // 失败可感知：读的是选区还是旧剪贴板，必须说清楚（基线指标 H）
        if (payload.source === 'clipboard') {
          notify('没有选中文字，已朗读剪贴板内容', 'info', { say: false });
          announcer.announce('readClipboard', {}, { priority: 'high' });
        }
        readRef.current(content, { fromSelection: true });
      });
      offClipboard = api.onClipboard?.((payload) => {
        const t = payload && payload.text;
        if (!t) return;
        // 复制即读默认开（低视力场景刚需）：autoRead===true 时自动朗读，节流与长度上限见 clipboardMonitor
        if (payload.autoRead === true) readRef.current(t);
      });
      offHotkeyClip = api.onReadClipboard?.(async () => {
        announcer.cue('press');
        try {
          const c = await api.readClipboard();
          if (!c) {
            notify('剪贴板里没有文字', 'warning', { say: false });
            announcer.announce('noSelection', {}, { priority: 'high' });
            return;
          }
          readRef.current(c, { fromSelection: true });
        } catch (e) {
          notify(`读取剪贴板失败：${e?.message || e}`, 'error', { priority: 'high' });
        }
      });
    } catch (e) {
      /* 事件注册失败不阻塞界面 */
    }
    return () => {
      if (typeof offSelection === 'function') offSelection();
      if (typeof offClipboard === 'function') offClipboard();
      if (typeof offHotkeyClip === 'function') offHotkeyClip();
    };
  }, [notify]);

  // 编辑器朗读时清掉「选中文字」标记
  const handleReadEditor = useCallback(() => {
    setSelectionChars(0);
    setPlayerOpened(true); // 用户明确要读文本 → 展开播放器
    return handleRead();
  }, [handleRead]);

  const handleSelectVoice = async (id) => {
    if (!id || id === voiceId) return;
    announcer.cue('press');
    setSettings({ voiceId: id });
    try {
      const res = await bridge()?.voice?.setVoiceId?.(id);
      if (res && res.ok === false) throw new Error((res.error && res.error.message) || '主进程未接受该音色');
      const v = (voiceStatus && voiceStatus.voices ? voiceStatus.voices : []).find((x) => x.id === id);
      announcer.announce('voiceChanged', { name: v ? v.displayName || v.name : '' });
    } catch (e) {
      notify(`音色切换失败：${e?.message || e}`, 'error', { priority: 'high' });
    }
  };

  const handlePreview = async (voice) => {
    if (!voice || voice.available === false) return;
    announcer.cue('press');
    if (playback.isPlaying) playback.pause();
    stopPreview();
    setPreviewingId(voice.id);
    const res = await preview(voice.id);
    if (!res.ok) {
      setPreviewingId(null);
      notify(`试听失败：${res.error}`, 'error');
      return;
    }
    const audio = new Audio(res.audioUrl);
    previewAudioRef.current = audio;
    const cleanup = () => {
      URL.revokeObjectURL(res.audioUrl);
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewingId(null);
      }
    };
    audio.onended = cleanup;
    audio.onerror = () => {
      cleanup();
      notify('试听音频播放失败', 'error');
    };
    try {
      await audio.play();
    } catch (e) {
      cleanup();
      notify(`试听无法播放：${e?.message || e}`, 'error');
      return;
    }
    if (res.notice) notify(res.notice, 'info');
  };

  const handleRefresh = async () => {
    const api = bridge();
    if (!api?.voice?.refresh) return;
    setRefreshing(true);
    try {
      const next = await api.voice.refresh();
      if (next) useSettings.getState().setVoiceStatus(next);
      if (next && next.engine && next.engine.ready !== false) notify('语音已在线可用', 'success');
      else notify('连不上网络，请检查网络后重试', 'warning');
    } catch (e) {
      notify(`重新检测失败：${e?.message || e}`, 'error');
    } finally {
      setRefreshing(false);
    }
  };

  const handleImport = async () => {
    const api = bridge();
    if (!api?.openFileDialog) {
      notify('当前环境不支持文件导入', 'error');
      return;
    }
    try {
      const paths = await api.openFileDialog();
      if (!paths || !paths.length) return;

      const texts = [];
      let chapterPayload = null;
      let title = '';
      for (const p of paths) {
        const r = await api.readFile(p);
        if (!r || r.ok === false) {
          notify(`读取失败：${(r && r.error) || p}`, 'error');
          continue;
        }
        if (Array.isArray(r.chapters) && r.chapters.length) {
          chapterPayload = r.chapters;
          title = r.title || p.split(/[\\/]/).pop();
          texts.push(r.content || '');
        } else if (typeof r.content === 'string') {
          texts.push(r.content);
        }
      }
      const joined = texts.filter((t) => t && t.trim()).join('\n\n');
      if (!joined.trim()) {
        notify('没有读取到可朗读的文本，请确认文件不是空文件或二进制文件', 'warning');
        return;
      }
      setText(joined);
      setChapters(chapterPayload || []);
      setBookTitle(chapterPayload ? title : '');
      setActiveChapter(-1);
      setSelectionChars(0);
      playback.reset();
      notify(
        chapterPayload
          ? `已导入《${title}》，共 ${chapterPayload.length} 章`
          : `已导入 ${paths.length} 个文件`,
        'success'
      );
      // 导入成功即展开文本区：让用户「看见」文本已就位（低视力用户不常打字，导入是主入口）
      setEditorOpen(true);
    } catch (e) {
      notify(`导入失败：${e?.message || e}`, 'error');
    }
  };

  const handleSelectChapter = (index) => {
    const ch = chapters[index];
    if (!ch) return;
    setActiveChapter(index);
    setText(`${ch.title ? `${ch.title}\n\n` : ''}${ch.text || ''}`);
    setSelectionChars(0);
    playback.reset();
  };

  const handleSelectAllChapters = () => {
    if (!chapters.length) return;
    setActiveChapter(-1);
    setText(chapters.map((c) => `${c.title}\n${c.text}`).join('\n\n'));
    setSelectionChars(0);
    playback.reset();
  };

  const handleClear = () => {
    setText('');
    setChapters([]);
    setBookTitle('');
    setActiveChapter(-1);
    setSelectionChars(0);
    playback.reset();
    setEditorOpen(false); // 清空后收起文本区，减少视觉噪音
  };

  const handleExport = async () => {
    announcer.cue('press');
    const content = textRef.current;
    if (!content || !content.trim()) {
      notify('没有可导出的文本', 'warning');
      return;
    }
    const api = bridge();
    if (!api?.saveDialog) {
      notify('当前环境不支持导出', 'error');
      return;
    }
    try {
      let outPath = await api.saveDialog('朗读女.mp3');
      if (!outPath) return;
      // 不再无脑补 .mp3：本地 SAPI 实际产出 wav，exporter 会按真实格式把 .mp3 纠正成 .wav，
      // 这里再补一次就会叠出 .mp3.wav 双扩展名。仅在完全没有音频扩展名时补占位后缀。
      if (!/\.(mp3|wav)$/i.test(outPath)) outPath = `${outPath}.mp3`;
      const s = useSettings.getState();
      notify('导出中，长文需要一点时间', 'info');
      const res = await exportAudio({
        text: content,
        opts: { voiceId: s.voiceId, rate: s.rate, pitch: s.pitch, volume: s.volume },
        outPath,
      });
      // 路径不适合念出来：语音只说结论
      if (res.ok) notify(`已导出：${res.path}`, 'success', { say: '导出完成' });
      else notify(`导出失败：${res.error || '未知错误'}`, 'error', { say: '导出失败，请重试', priority: 'high' });
    } catch (e) {
      notify(`导出失败：${e?.message || e}`, 'error', { say: '导出失败，请重试', priority: 'high' });
    }
  };

  const handleStartTimer = (minutes) => {
    const m = Number(minutes);
    if (!m || m <= 0) {
      notify('请输入有效的定时分钟数', 'warning');
      return;
    }
    timerArmedRef.current = true;
    playback.startTimer(m);
    notify(`已设置 ${m} 分钟后自动停止`, 'success', { say: false });
    announcer.announce('timerSet', { minutes: m });
  };

  const handleClearTimer = () => {
    timerArmedRef.current = false;
    playback.clearTimer();
    notify('已取消定时关闭', 'info', { say: false });
    announcer.say('timerCleared', '已取消定时关闭');
  };

  // 语调 / 音量（次级参数）：视觉之外补一条节流语音反馈，不只做视觉变化
  const handleTuningChange = useCallback(
    (patch) => {
      if (!patch || typeof patch !== 'object') return;
      setSettings(patch);
      if (Object.prototype.hasOwnProperty.call(patch, 'pitch')) {
        const v = Number(patch.pitch) || 0;
        announcer.say('pitchChanged', v === 0 ? '语调已恢复正常' : v > 0 ? '语调已调高' : '语调已调低', {
          minInterval: 900,
        });
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'volume')) {
        const v = Number(patch.volume) || 0;
        announcer.say('volumeChanged', v === 0 ? '音量已恢复正常' : v > 0 ? '音量已调大' : '音量已调小', {
          minInterval: 900,
        });
      }
    },
    [setSettings]
  );

  // 文本区展开 / 收起：布局级状态变化，语音同步告知
  const toggleEditor = useCallback(() => {
    setEditorOpen((v) => {
      const next = !v;
      announcer.cue('press');
      announcer.say('editorToggle', next ? '朗读文本已展开' : '朗读文本已收起');
      return next;
    });
  }, []);

  // ---- v2.4.0 IA：首屏派生状态 ----
  // 首屏只显示「主用法 + 当前音色」，播放器要有真实内容/动作时才占主位。
  const voiceList = (voiceStatus && voiceStatus.voices) || [];
  const activeVoice =
    voiceList.find((x) => x.id === voiceId) || voiceList.find((x) => x.isDefault) || voiceList[0] || null;
  const heroVoiceName = activeVoice ? activeVoice.name || '' : '';
  const hasEditorText = !!text.trim();
  const playerActive = playerOpened || !!playback.hasAudio || !!playback.isPlaying;

  const voices = voiceStatus && Array.isArray(voiceStatus.voices) ? voiceStatus.voices : [];
  const currentVoice = voices.find((v) => v.id === voiceId);
  const voiceLabel = currentVoice ? currentVoice.displayName || currentVoice.name || '晓晓' : '晓晓';

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <TopBar
        status={voiceStatus}
        themeMode={themeMode}
        refreshing={refreshing}
        onToggleTheme={(next) => setSettings({ themeMode: next })}
        onRefresh={handleRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {zoomState && zoomState.active === true && (
        <Alert
          severity="info"
          variant="filled"
          icon={false}
          sx={{
            borderRadius: 0,
            py: 0.25,
            px: 2,
            justifyContent: 'center',
            '& .MuiAlert-message': { fontSize: fs(13), fontWeight: 600, overflow: 'visible' },
          }}
        >
          {`屏幕缩放 ${Number(zoomState.zoom).toFixed(1)}x · Ctrl+Alt+0 退出${zoomState.paused ? ' · 已暂停' : ''}`}
        </Alert>
      )}

      {/* 朗读即状态页：单列信息层级——① 状态+控制 ② 次级操作 ③ 文本（收起） */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          px: { xs: 1.5, md: 3 },
          py: { xs: 1.5, md: 2.5 },
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        <Box
          sx={{
            maxWidth: 880,
            mx: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: { xs: 1.5, md: 2 },
          }}
        >
          {/* ⓪ v2.4.0 离线语音引导：本地引擎是延迟根治项，未安装时在顶部提示一键部署 */}
          <VoiceDeployGate />

          {/* ① v2.4.0 首屏状态卡：主用法「选中→F1」必须在第一眼位置 */}
          <HeroStatus hotkey={hotkey || 'F1'} hotkeyOk={hotkeyOk} voiceName={heroVoiceName} />

          {/* ② 播放器：只有真的在朗读 / 点过朗读时才占主位；否则给一行轻量入口 */}
          {playerActive ? (
            <Controls
              isPlaying={playback.isPlaying}
              buffering={playback.buffering}
              hasAudio={playback.hasAudio}
              loading={playback.preparing}
              currentMs={playback.currentMs}
              totalMs={playback.totalMs}
              sentences={playback.sentences}
              currentSentence={playback.currentSentence}
              hasText={!!textRef.current.trim()}
              onRead={handleReadEditor}
              onPlay={handlePlay}
              onPause={handlePause}
              onStop={handleStop}
              onSeek={playback.seekMs}
              onJump={handleJump}
              onPrev={handlePrev}
              onNext={handleNext}
              onRateChange={(v) => setSettings({ rate: v })}
              rate={rate}
              selectionChars={selectionChars}
              timerActive={playback.timerActive}
            />
          ) : (
            <Box
              sx={{
                px: { xs: 1.5, md: 1.75 },
                py: { xs: 1.25, md: 1.5 },
                borderRadius: 3,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 1.25,
                flexShrink: 0,
              }}
            >
              <Button
                variant="outlined"
                startIcon={<PlayArrowIcon sx={{ fontSize: fs(22) }} />}
                onClick={handleReadEditor}
                disabled={!hasEditorText}
                sx={{ height: su(44), fontSize: fs(15), fontWeight: 700 }}
              >
                {hasEditorText ? '朗读下方文本' : '先导入或粘贴文本'}
              </Button>
              <Typography sx={{ fontSize: fs(14), color: 'text.secondary' }}>
                {hasEditorText
                  ? '也可以直接在任意程序里选中文字，按热键朗读'
                  : '主要用法：在任意程序里选中文字，按热键直接朗读'}
              </Typography>
            </Box>
          )}

          {/* ② 次级操作条：音色 / 导出 / 定时 / 参数——默认收起为一行，按需展开 */}
          <Box
            sx={{
              px: { xs: 1.25, md: 1.5 },
              py: { xs: 1, md: 1.25 },
              borderRadius: 3,
              bgcolor: 'background.paper',
              border: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
              flexShrink: 0,
            }}
          >
            <Button
              variant="outlined"
              startIcon={<RecordVoiceOverIcon />}
              onClick={(e) => setVoiceAnchor(e.currentTarget)}
              sx={{ height: su(44) }}
            >
              音色 · {voiceLabel}
            </Button>
            <Button
              variant="outlined"
              startIcon={exporting ? <CircularProgress size={14} /> : <FileDownloadIcon />}
              disabled={exporting}
              onClick={handleExport}
              sx={{ height: su(44) }}
            >
              {exporting ? '导出中…' : '导出 MP3'}
            </Button>
            <Tooltip title="定时关闭">
              <span>
                <IconButton
                  onClick={(e) => setTimerAnchor(e.currentTarget)}
                  aria-label="定时关闭"
                  sx={{ width: su(44), height: su(44) }}
                >
                  <Badge variant="dot" color="success" invisible={!playback.timerActive} overlap="circular">
                    <TimerIcon sx={{ fontSize: fs(20) }} />
                  </Badge>
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="更多朗读参数（语调 / 音量）">
              <span>
                <IconButton
                  onClick={(e) => setTuneAnchor(e.currentTarget)}
                  aria-label="更多朗读参数"
                  sx={{ width: su(44), height: su(44) }}
                >
                  <TuneIcon sx={{ fontSize: fs(20) }} />
                </IconButton>
              </span>
            </Tooltip>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
              在任意程序选中文字后按 F1，随时朗读
            </Typography>
          </Box>

          {/* ③ 朗读文本：默认收起一行，导入为主入口 */}
          <Editor
            value={text}
            onChange={setText}
            onImport={handleImport}
            onClear={handleClear}
            chapters={chapters}
            bookTitle={bookTitle}
            activeChapter={activeChapter}
            onSelectChapter={handleSelectChapter}
            onSelectAll={handleSelectAllChapters}
            rate={rate}
            open={editorOpen}
            onToggle={toggleEditor}
          />
        </Box>
      </Box>

      {/* 次级弹层：音色 / 定时 / 参数 */}
      <Popover
        open={!!voiceAnchor}
        anchorEl={voiceAnchor}
        onClose={() => setVoiceAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      >
        <VoicePicker
          status={voiceStatus}
          value={voiceId}
          onChange={(id) => {
            handleSelectVoice(id);
            setVoiceAnchor(null);
          }}
          onPreview={handlePreview}
          previewingId={previewingId}
        />
      </Popover>

      <Popover
        open={!!timerAnchor}
        anchorEl={timerAnchor}
        onClose={() => setTimerAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <TimerPanel
          active={playback.timerActive}
          onStart={(m) => {
            handleStartTimer(m);
            setTimerAnchor(null);
          }}
          onClear={() => {
            handleClearTimer();
            setTimerAnchor(null);
          }}
        />
      </Popover>

      <Popover
        open={!!tuneAnchor}
        anchorEl={tuneAnchor}
        onClose={() => setTuneAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Box sx={{ p: 1 }}>
          <TuningPanel rate={rate} pitch={pitch} volume={volume} onChange={handleTuningChange} />
        </Box>
      </Popover>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        status={voiceStatus}
        notify={notify}
      />

      <Snackbar
        key={snack ? snack.key : 'empty'}
        open={!!snack}
        autoHideDuration={(snack && snack.duration) || 4200}
        onClose={() => setSnack(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={(snack && snack.severity) || 'info'}
          variant="filled"
          onClose={() => setSnack(null)}
          sx={{ maxWidth: 560, alignItems: 'center' }}
        >
          {snack ? snack.message : ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
