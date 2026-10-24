import { useCallback, useEffect, useRef, useState } from 'react';
import { b64ToBlobUrl } from './useTts';

// ---- 流式朗读参数 ----
const PREFETCH_AHEAD = 3; // 当前句之后最多预合成 3 句
const PREFETCH_BEHIND = 1; // 当前句之前最多补 1 句（上一句秒回）
const CACHE_WINDOW = 3; // 长文本时只保留当前句前后各 3 句的音频
const BIG_TEXT = 400; // 句子数超过该阈值才启用窗口回收
const DEFAULT_MS_PER_CHAR = 240; // 未合成句的兜底每字时长（中文约 4 字/秒）
const MIN_SENT_MS = 400;
const MAX_FAIL_STREAK = 3;
const SEEK_STEP_TOLERANCE_MS = 1200; // 上一句：句内 1.2 秒内回退上一句，否则重播本句

function bridge() {
  return typeof window !== 'undefined' ? window.langdu : null;
}

/** 音频元素在元数据就绪后再 seek，避免 src 刚切换时 currentTime 赋值失效 */
function seekWhenReady(el, sec) {
  // 连续切句时只让最后一次 seek 生效
  const token = (el.__seekToken || 0) + 1;
  el.__seekToken = token;
  const doSeek = () => {
    if (el.__seekToken !== token) return;
    try {
      el.currentTime = sec;
    } catch (e) {
      /* 极端情况下元素已失效，忽略 */
    }
  };
  if (el.readyState >= 1) doSeek();
  else el.addEventListener('loadedmetadata', doSeek, { once: true });
}

/**
 * 逐句流式朗读：边合成边播放
 * - 串行合成队列（并发 1），始终预取正在播放句之后若干句
 * - 播放用单个 <audio> 元素切 src（音频已在内存 blob，切换几乎无停顿）
 * - 进度：已合成句用真实 durationMs，未合成句按「字数 × 动态每字时长」估算
 */
export function useStreamingPlayback({ onError, onFatal, onNotice } = {}) {
  const audioRef = useRef(null);
  const preloadRef = useRef(null);
  const cacheRef = useRef(new Map()); // index -> { url, durationMs }
  const sentencesRef = useRef([]);
  const marksRef = useRef([]);
  const totalMsRef = useRef(0);
  const idxRef = useRef(0); // 当前句索引
  const offsetRef = useRef(0); // 当前句内偏移（ms）
  const playingRef = useRef(false);
  const hasAudioRef = useRef(false);
  const wantRef = useRef(null); // { index, offsetMs, autoplay } 等待合成后再播
  const runRef = useRef(0); // 代际：停止 / 改参数时 +1，使在途合成结果作废
  const pumpingRef = useRef(false);
  const optsRef = useRef({});
  const failedRef = useRef(new Set()); // 本轮已失败跳过的句子
  const accRef = useRef({ ms: 0, chars: 0 }); // 已合成句的时长样本，用于估算每字时长
  const failRef = useRef({ idx: -1, streak: 0 }); // 连续失败计数
  const noticeShownRef = useRef(false);
  const endedRef = useRef(false); // 全文已播完：再次播放从头开始
  const timerRef = useRef(null);
  const handlersRef = useRef({});

  const cbRef = useRef({ onError, onFatal, onNotice });
  cbRef.current = { onError, onFatal, onNotice };

  const [isPlaying, setIsPlaying] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentMs, setCurrentMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [marks, setMarks] = useState([]);
  const [timerActive, setTimerActive] = useState(false);

  const perCharMs = useCallback(() => {
    const acc = accRef.current;
    if (acc.chars > 0) return Math.max(80, acc.ms / acc.chars);
    return DEFAULT_MS_PER_CHAR;
  }, []);

  // 重算句级时间轴：已合成句用真实时长，其余按字数估算
  const recompute = useCallback(() => {
    const texts = sentencesRef.current;
    const cache = cacheRef.current;
    const pc = perCharMs();
    let acc = 0;
    const list = texts.map((text, i) => {
      const hit = cache.get(i);
      const len = Math.max(1, text.length);
      const durationMs = hit
        ? Math.max(1, Math.round(hit.durationMs || 0))
        : Math.max(MIN_SENT_MS, Math.round(len * pc));
      const startMs = acc;
      acc += durationMs;
      return { index: i, text, startMs, endMs: acc, durationMs, ready: !!hit };
    });
    marksRef.current = list;
    totalMsRef.current = acc;
    setMarks(list);
    setTotalMs(acc);
    const cur = list[idxRef.current];
    setCurrentMs(cur ? cur.startMs + Math.min(offsetRef.current, cur.durationMs) : 0);
  }, [perCharMs]);

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = 'auto';
      a.onended = () => handlersRef.current.ended?.();
      a.ontimeupdate = () => handlersRef.current.tick?.();
      a.onerror = () => handlersRef.current.err?.();
      audioRef.current = a;
    }
    return audioRef.current;
  }, []);

  // 预热下一句：提前把 blob 挂到备用元素，切句时解码更快
  const preload = useCallback((index) => {
    const hit = cacheRef.current.get(index);
    if (!hit) return;
    if (!preloadRef.current) {
      const p = new Audio();
      p.preload = 'auto';
      p.muted = true;
      preloadRef.current = p;
    }
    const p = preloadRef.current;
    if (p.src !== hit.url) {
      try {
        p.src = hit.url;
      } catch (e) {
        /* 预热失败不影响播放 */
      }
    }
  }, []);

  const playAudio = useCallback(() => {
    const a = ensureAudio();
    if (!a.src) return;
    playingRef.current = true;
    setIsPlaying(true);
    setBuffering(false);
    setPreparing(false);
    const p = a.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (playingRef.current) setIsPlaying(true);
      }).catch(() => {
        playingRef.current = false;
        setIsPlaying(false);
        cbRef.current.onError?.('音频播放被系统拦截，请点击播放按钮重试');
      });
    }
  }, [ensureAudio]);

  const pruneCache = useCallback(() => {
    const len = sentencesRef.current.length;
    if (len <= BIG_TEXT) return;
    const cur = idxRef.current;
    const playingUrl = audioRef.current ? audioRef.current.src : '';
    cacheRef.current.forEach((hit, i) => {
      if (Math.abs(i - cur) <= CACHE_WINDOW) return;
      if (hit.url === playingUrl) return;
      try {
        URL.revokeObjectURL(hit.url);
      } catch (e) {
        /* 忽略释放失败 */
      }
      cacheRef.current.delete(i);
    });
    failedRef.current.forEach((i) => {
      if (Math.abs(i - cur) > CACHE_WINDOW) failedRef.current.delete(i);
    });
  }, []);

  const pickTask = useCallback(() => {
    const texts = sentencesRef.current;
    const cache = cacheRef.current;
    if (!texts.length) return -1;
    const want = wantRef.current;
    const start = want ? want.index : idxRef.current;
    const usable = (i) => i >= 0 && i < texts.length && !cache.has(i) && !failedRef.current.has(i);
    if (usable(start)) return start;
    for (let k = 1; k <= PREFETCH_AHEAD; k += 1) {
      if (usable(start + k)) return start + k;
    }
    for (let k = 1; k <= PREFETCH_BEHIND; k += 1) {
      if (usable(start - k)) return start - k;
    }
    return -1;
  }, []);

  const playIndex = useCallback(
    (rawIndex, offsetMs = 0, autoplay = true) => {
      const texts = sentencesRef.current;
      if (!texts.length) return;
      const i = Math.max(0, Math.min(rawIndex, texts.length - 1));
      endedRef.current = false;
      idxRef.current = i;
      setCurrentIndex(i);
      const hit = cacheRef.current.get(i);
      if (!hit) {
        // 未合成：记为待播，交给合成队列（用户显式跳转时允许重试此前失败的句子）
        failedRef.current.delete(i);
        const a = audioRef.current;
        if (a) a.pause();
        playingRef.current = false;
        setIsPlaying(false);
        setBuffering(true);
        wantRef.current = { index: i, offsetMs: Math.max(0, offsetMs), autoplay };
        offsetRef.current = 0;
        recompute();
        pumpRef.current();
        return;
      }
      wantRef.current = null;
      setBuffering(false);
      setPreparing(false);
      hasAudioRef.current = true;
      setHasAudio(true);

      const a = ensureAudio();
      const srcChanged = a.src !== hit.url;
      if (srcChanged) a.src = hit.url;
      const maxMs = Math.max(0, (hit.durationMs || 0) - 30);
      const targetMs = Math.max(0, Math.min(offsetMs, maxMs));
      if (srcChanged || targetMs > 0 || a.currentTime > 0) seekWhenReady(a, targetMs / 1000);
      offsetRef.current = targetMs;
      recompute();
      preload(i + 1);

      if (!autoplay) {
        playingRef.current = false;
        setIsPlaying(false);
        return;
      }
      playAudio();
    },
    [ensureAudio, preload, playAudio, recompute]
  );

  const pumpRef = useRef(() => {});
  const playIndexRef = useRef((...args) => playIndex(...args));
  playIndexRef.current = playIndex;

  const handleSynthError = useCallback(
    (index, res) => {
      failedRef.current.add(index);
      const f = failRef.current;
      f.streak = f.idx === index - 1 ? f.streak + 1 : 1;
      f.idx = index;
      if (f.streak === 1) {
        cbRef.current.onError?.(
          `第 ${index + 1} 句合成失败，已跳过（${(res && (res.message || res.error)) || '未知错误'}）`
        );
      }
      if (f.streak >= MAX_FAIL_STREAK) {
        cbRef.current.onFatal?.('连续多句合成失败，已停止朗读，请检查网络或更换音色');
        stopRef.current();
        return;
      }
      const want = wantRef.current;
      const texts = sentencesRef.current;
      if (want && want.index === index && index + 1 < texts.length) {
        playIndexRef.current(index + 1, 0, want.autoplay);
      } else if (want && want.index === index) {
        wantRef.current = null;
        playingRef.current = false;
        setIsPlaying(false);
        setBuffering(false);
        setPreparing(false);
      }
    },
    []
  );

  // 串行合成队列：一次只发一句，避免把 CPU 打满
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      const api = bridge();
      while (true) {
        const gen = runRef.current;
        const target = pickTask();
        if (target < 0) break;
        if (!api?.synthesizeOne) {
          cbRef.current.onFatal?.('当前环境不支持逐句合成');
          break;
        }
        const text = sentencesRef.current[target];
        let res;
        try {
          res = await api.synthesizeOne(text, optsRef.current);
        } catch (e) {
          res = { ok: false, message: e?.message || String(e) };
        }
        if (gen !== runRef.current) continue; // 已停止或改了参数：结果作废，重新挑任务
        if (!res || !res.ok) {
          handleSynthError(target, res);
          continue;
        }
        let url = '';
        try {
          if (typeof res.audioData !== 'string' || !res.audioData) throw new Error('empty');
          url = b64ToBlobUrl(res.audioData, res.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
        } catch (e) {
          handleSynthError(target, { message: '音频数据解析失败' });
          continue;
        }
        const durationMs =
          Number(res.durationMs) > 0
            ? Number(res.durationMs)
            : Math.max(MIN_SENT_MS, Math.round(text.length * perCharMs()));
        cacheRef.current.set(target, { url, durationMs });
        accRef.current.ms += durationMs;
        accRef.current.chars += Math.max(1, text.length);
        failRef.current = { idx: -1, streak: 0 };
        if ((res.fellBack || res.notice) && !noticeShownRef.current) {
          noticeShownRef.current = true;
          cbRef.current.onNotice?.(res.notice || '当前音色不可用，已切换语音');
        }
        recompute();
        pruneCache();
        const want = wantRef.current;
        if (want && want.index === target) {
          playIndexRef.current(target, want.offsetMs, want.autoplay);
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [handleSynthError, perCharMs, pickTask, pruneCache, recompute]);
  pumpRef.current = pump;

  const advance = useCallback(() => {
    // 跟随当前播放状态：暂停状态下切句只就位不自动播
    playIndexRef.current(idxRef.current + 1, 0, playingRef.current);
  }, []);

  const handleEnded = useCallback(() => {
    const texts = sentencesRef.current;
    const nextIdx = idxRef.current + 1;
    if (!texts.length) return;
    if (nextIdx >= texts.length) {
      playingRef.current = false;
      endedRef.current = true;
      setIsPlaying(false);
      setBuffering(false);
      offsetRef.current = 0;
      setCurrentMs(totalMsRef.current);
      return;
    }
    advance();
  }, [advance]);

  const handleTick = useCallback(() => {
    const a = audioRef.current;
    const m = marksRef.current[idxRef.current];
    if (!a || !m) return;
    offsetRef.current = a.currentTime * 1000;
    setCurrentMs(m.startMs + offsetRef.current);
  }, []);

  const handleErr = useCallback(() => {
    if (!playingRef.current) return;
    // 单个音频解码失败：跳过该句继续，避免卡死
    failedRef.current.add(idxRef.current);
    cbRef.current.onError?.('该句音频无法播放，已跳过');
    const texts = sentencesRef.current;
    if (idxRef.current + 1 < texts.length) advance();
    else {
      playingRef.current = false;
      setIsPlaying(false);
      setBuffering(false);
    }
  }, [advance]);

  handlersRef.current = { ended: handleEnded, tick: handleTick, err: handleErr };

  const stop = useCallback(() => {
    runRef.current += 1;
    wantRef.current = null;
    playingRef.current = false;
    hasAudioRef.current = false;
    failedRef.current.clear();
    failRef.current = { idx: -1, streak: 0 };
    noticeShownRef.current = false;
    endedRef.current = false;
    const a = audioRef.current;
    if (a) {
      a.pause();
      try {
        a.removeAttribute('src');
        a.load();
      } catch (e) {
        /* 忽略复位异常 */
      }
    }
    if (preloadRef.current) {
      try {
        preloadRef.current.removeAttribute('src');
      } catch (e) {
        /* 忽略 */
      }
    }
    cacheRef.current.forEach((hit) => {
      try {
        URL.revokeObjectURL(hit.url);
      } catch (e) {
        /* 忽略 */
      }
    });
    cacheRef.current.clear();
    sentencesRef.current = [];
    marksRef.current = [];
    totalMsRef.current = 0;
    idxRef.current = 0;
    offsetRef.current = 0;
    accRef.current = { ms: 0, chars: 0 };
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      setTimerActive(false);
    }
    setMarks([]);
    setTotalMs(0);
    setCurrentMs(0);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setBuffering(false);
    setPreparing(false);
    setHasAudio(false);
  }, []);

  const stopRef = useRef(() => {});
  stopRef.current = stop;

  const start = useCallback(
    async (text, opts) => {
      const content = String(text == null ? '' : text).trim();
      if (!content) return { ok: false, error: '没有可朗读的文本' };
      stop();
      const api = bridge();
      let list = [];
      try {
        const r = api?.splitSentences ? await api.splitSentences(content) : null;
        if (r && r.ok && Array.isArray(r.sentences)) list = r.sentences.filter((s) => s && s.trim());
      } catch (e) {
        list = [];
      }
      if (!list.length) {
        list = content
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (!list.length) return { ok: false, error: '没有可朗读的文本' };

      optsRef.current = opts || {};
      sentencesRef.current = list;
      idxRef.current = 0;
      offsetRef.current = 0;
      accRef.current = { ms: 0, chars: 0 };
      failedRef.current.clear();
      failRef.current = { idx: -1, streak: 0 };
      noticeShownRef.current = false;
      setPreparing(true);
      recompute();
      playIndexRef.current(0, 0, true);
      return { ok: true, total: list.length };
    },
    [recompute, stop]
  );

  const play = useCallback(() => {
    if (!sentencesRef.current.length) return;
    if (endedRef.current) {
      playIndexRef.current(0, 0, true);
      return;
    }
    const i = idxRef.current;
    const hit = cacheRef.current.get(i);
    if (!hit) {
      playIndexRef.current(i, offsetRef.current, true);
      return;
    }
    const a = ensureAudio();
    if (a.src !== hit.url) a.src = hit.url;
    if (wantRef.current) wantRef.current.autoplay = true;
    playAudio();
  }, [ensureAudio, playAudio]);

  const pause = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch (e) {
        /* 忽略 */
      }
      if (a.src) offsetRef.current = a.currentTime * 1000;
    }
    playingRef.current = false;
    setIsPlaying(false);
    // 正在等合成时暂停：合成完只就位不自动播
    if (wantRef.current) wantRef.current.autoplay = false;
  }, []);

  const seekToSentence = useCallback((index, offsetMs = 0, forcePlay) => {
    if (!sentencesRef.current.length) return;
    const autoplay = forcePlay == null ? playingRef.current : !!forcePlay;
    playIndexRef.current(index, offsetMs, autoplay);
  }, []);

  const seekMs = useCallback((ms) => {
    const list = marksRef.current;
    if (!list.length) return;
    const total = totalMsRef.current || 0;
    const clamped = Math.max(0, Math.min(ms, Math.max(0, total - 1)));
    let idx = list.length - 1;
    for (let i = 0; i < list.length; i += 1) {
      if (clamped < list[i].endMs) {
        idx = i;
        break;
      }
    }
    playIndexRef.current(idx, Math.max(0, clamped - list[idx].startMs), playingRef.current);
  }, []);

  const seekRatio = useCallback(
    (ratio) => {
      seekMs((Number(ratio) || 0) * totalMsRef.current);
    },
    [seekMs]
  );

  const next = useCallback(() => {
    const texts = sentencesRef.current;
    if (!texts.length) return;
    playIndexRef.current(Math.min(idxRef.current + 1, texts.length - 1), 0, true);
  }, []);

  const prev = useCallback(() => {
    const texts = sentencesRef.current;
    if (!texts.length) return;
    const a = audioRef.current;
    const atStart = !a || a.currentTime * 1000 < SEEK_STEP_TOLERANCE_MS;
    const target = atStart ? Math.max(0, idxRef.current - 1) : idxRef.current;
    playIndexRef.current(target, 0, true);
  }, []);

  // 音色 / 参数变化：丢弃未播缓存，从当前句用新参数重合成
  const updateOptions = useCallback(
    (nextOpts) => {
      const cur = optsRef.current || {};
      const patch = nextOpts || {};
      const keys = ['voiceId', 'rate', 'pitch', 'volume'];
      const changed = keys.some((k) => (cur[k] ?? null) !== (patch[k] ?? null));
      if (!changed) return;
      const merged = { ...cur, ...pick(patch, keys) };
      optsRef.current = merged;
      const texts = sentencesRef.current;
      if (!texts.length) return;

      const keep = idxRef.current;
      const a = audioRef.current;
      const wasPlaying = playingRef.current;
      playingRef.current = false;
      if (a) {
        try {
          a.pause();
        } catch (e) {
          /* 忽略 */
        }
      }
      runRef.current += 1; // 在途合成结果作废
      wantRef.current = null;
      failedRef.current.clear();
      failRef.current = { idx: -1, streak: 0 };
      accRef.current = { ms: 0, chars: 0 };
      noticeShownRef.current = false;
      cacheRef.current.forEach((hit, i) => {
        if (i < keep) return;
        try {
          URL.revokeObjectURL(hit.url);
        } catch (e) {
          /* 忽略 */
        }
        cacheRef.current.delete(i);
      });
      if (a) {
        try {
          a.removeAttribute('src');
          a.load();
        } catch (e) {
          /* 忽略 */
        }
      }
      offsetRef.current = 0;
      recompute();
      playIndexRef.current(keep, 0, wasPlaying);
    },
    [recompute]
  );

  const startTimer = useCallback(
    (minutes) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const mins = Number(minutes) || 0;
      if (mins <= 0) {
        timerRef.current = null;
        setTimerActive(false);
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setTimerActive(false);
        stopRef.current();
      }, mins * 60000);
      setTimerActive(true);
    },
    []
  );

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setTimerActive(false);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      runRef.current += 1;
      const a = audioRef.current;
      if (a) {
        try {
          a.pause();
          a.removeAttribute('src');
        } catch (e) {
          /* 忽略 */
        }
      }
      if (preloadRef.current) {
        try {
          preloadRef.current.removeAttribute('src');
        } catch (e) {
          /* 忽略 */
        }
      }
      cacheRef.current.forEach((hit) => {
        try {
          URL.revokeObjectURL(hit.url);
        } catch (e) {
          /* 忽略 */
        }
      });
      cacheRef.current.clear();
    },
    []
  );

  return {
    // 状态
    isPlaying,
    buffering,
    preparing,
    hasAudio,
    currentMs,
    totalMs,
    sentences: marks,
    currentSentence: currentIndex,
    currentIndex,
    timerActive,
    // 控制
    start,
    play,
    pause,
    stop,
    reset: stop,
    next,
    prev,
    seekMs,
    seekRatio,
    seekToSentence,
    jumpTo: seekToSentence,
    updateOptions,
    startTimer,
    clearTimer,
    isReady: (i) => cacheRef.current.has(i),
  };
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}
