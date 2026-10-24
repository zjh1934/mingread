import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  Stack,
  IconButton,
  Slider,
  Typography,
  Button,
  ButtonBase,
  Tooltip,
  Chip,
  CircularProgress,
  Collapse,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import ReplayIcon from '@mui/icons-material/Replay';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RemoveIcon from '@mui/icons-material/Remove';
import AddIcon from '@mui/icons-material/Add';
import announcer from '../services/announcer';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放

const RATE_RANGE = [-50, 100];
const RATE_STEP = 10;
// 主操作目标尺寸：低视力用户点击精度差，播放/暂停 ≥72、其余主操作 ≥56（基线 P0 I 项）
// 基线写死数字，实际取值一律经 su() 乘 --ldn-scale，2.0x 档主按钮才会真的变大
const BTN = 56;
const BTN_MAIN = 72;
const BTN_RATE = 44; // 语速是一级入口，加减按钮也要 ≥44

function fmt(ms) {
  if (!ms || ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function speakTime(ms) {
  const total = Math.floor((Number(ms) || 0) / 1000);
  if (total <= 0) return '开头';
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

/**
 * 朗读即状态页（主界面第一 card）：
 *  - 顶部大字当前句 + 状态行：打开软件第一眼看到「现在读到哪了」
 *  - 超大播放控制：怎么停，一眼可见、一下点中
 *  - 语速保持一级入口（β 的成果，不回退）
 *  - 句列表 / 导出 / 定时 / 参数降为次级：句列表默认收起，按需展开
 */
export default function Controls({
  isPlaying,
  buffering,
  hasAudio,
  loading,
  currentMs,
  totalMs,
  sentences,
  currentSentence,
  hasText,
  onRead,
  onPlay,
  onPause,
  onStop,
  onSeek,
  onJump,
  onPrev,
  onNext,
  onRateChange,
  rate,
  selectionChars,
  timerActive,
}) {
  const [dragMs, setDragMs] = useState(null);
  const [listOpen, setListOpen] = useState(false); // 句列表默认收起（信息降噪）
  const currentRef = useRef(null);
  // 只有用户主动跳转（上一句/下一句/点句）后才播报句号，避免朗读过程中每句都念
  const navRef = useRef(false);

  useEffect(() => {
    if (currentRef.current && typeof currentRef.current.scrollIntoView === 'function') {
      currentRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentSentence]);

  useEffect(() => {
    if (!navRef.current) return;
    navRef.current = false;
    const total = Array.isArray(sentences) ? sentences.length : 0;
    if (currentSentence >= 0 && total > 0) {
      announcer.announce('sentence', { index: currentSentence, total }, { minInterval: 700 });
    }
  }, [currentSentence, sentences]);

  const value = dragMs != null ? dragMs : Math.min(currentMs, totalMs || currentMs || 0);
  const list = Array.isArray(sentences) ? sentences : [];
  const current = currentSentence >= 0 ? list[currentSentence] : null;

  const statusText = loading
    ? '准备中…'
    : buffering
      ? '正在合成当前句…'
      : isPlaying
        ? '播放中'
        : hasAudio
          ? '已暂停'
          : '待开始';

  const goPrev = () => {
    navRef.current = true;
    onPrev();
  };
  const goNext = () => {
    navRef.current = true;
    onNext();
  };
  const jumpTo = (i) => {
    navRef.current = true;
    onJump(i);
  };

  const setRate = (v) => {
    const next = Math.max(RATE_RANGE[0], Math.min(RATE_RANGE[1], Math.round(Number(v) || 0)));
    onRateChange(next);
    // 语速是低视力用户最高频的调节，改完立刻念出来（节流后只念最后一次）
    announcer.announce('rateChanged', { rate: next }, { minInterval: 900 });
  };

  return (
    <Box
      sx={{
        p: { xs: 1.75, md: 2.25 },
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '2px solid',
        borderColor: 'primary.main',
        flexShrink: 0,
      }}
    >
      {/* 状态行：视觉 + aria-live 双通道，语音播报由 App / announcer 负责 */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mb: 1, flexWrap: 'wrap', rowGap: 0.5 }}
        role="status"
        aria-live="polite"
      >
        <Typography variant="subtitle2" sx={{ color: 'primary.main', fontWeight: 700 }}>
          {statusText}
        </Typography>
        {list.length > 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            第 {Math.max(currentSentence + 1, 1)} / {list.length} 句
          </Typography>
        )}
        {timerActive && (
          <Chip size="small" color="success" variant="outlined" label="定时关闭已开启" sx={{ height: su(22) }} />
        )}
        {selectionChars > 0 && (
          <Chip
            size="small"
            color="secondary"
            variant="outlined"
            label={`正在朗读选中文字 · ${selectionChars} 字`}
            sx={{ height: su(22) }}
          />
        )}
      </Stack>

      {/* 大字当前句：主界面的视觉锚点 */}
      <Box
        aria-label={current ? `当前第 ${currentSentence + 1} 句：${current.text}` : '当前句'}
        data-scroll="1"
        sx={{
          minHeight: su(108),
          maxHeight: su(216),
          overflowY: 'auto',
          px: 1.5,
          py: 1.25,
          mb: 1.5,
          borderRadius: 2,
          bgcolor: 'background.default',
          border: '1px solid',
          borderColor: current ? 'primary.main' : 'divider',
          borderLeft: current ? '4px solid' : '1px solid',
          borderLeftColor: current ? 'primary.main' : 'divider',
        }}
      >
        {current ? (
          <Typography sx={{ fontSize: fs(24), fontWeight: 600, lineHeight: 1.6 }}>
            {current.text}
          </Typography>
        ) : (
          <Typography sx={{ fontSize: fs(17), color: 'text.secondary', lineHeight: 1.7 }}>
            {hasText
              ? '点击「开始朗读」，当前句会显示在这里。'
              : '先导入 txt / md / epub 或粘贴文本，再点「开始朗读」。'}
          </Typography>
        )}
      </Box>

      {/* 进度条 */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums', minWidth: su(44) }}>
          {fmt(value)}
        </Typography>
        <Slider
          min={0}
          max={totalMs || 1}
          value={Math.min(value, totalMs || 1)}
          onChange={(_, v) => setDragMs(v)}
          onChangeCommitted={(_, v) => {
            setDragMs(null);
            onSeek(v);
            announcer.announce('seek', { time: speakTime(v) }, { minInterval: 700 });
          }}
          size="small"
          disabled={!hasAudio}
          aria-label="播放进度"
          sx={{ flex: 1 }}
        />
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums', minWidth: su(44), textAlign: 'right' }}
        >
          {fmt(totalMs)}
        </Typography>
      </Stack>

      {/* 主操作区：播放/暂停/停止/上下句，目标放大到 56 / 72 */}
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Tooltip title="上一句">
          <span>
            <IconButton
              onClick={goPrev}
              disabled={!hasAudio}
              aria-label="上一句"
              sx={{ width: su(BTN), height: su(BTN), border: '1px solid', borderColor: 'divider' }}
            >
              <SkipPreviousIcon sx={{ fontSize: fs(26) }} />
            </IconButton>
          </span>
        </Tooltip>

        {!hasAudio ? (
          <Button
            variant="contained"
            startIcon={loading ? <CircularProgress size={20} color="inherit" /> : <PlayArrowIcon sx={{ fontSize: fs(28) }} />}
            onClick={onRead}
            disabled={loading}
            sx={{ minWidth: su(200), height: su(BTN_MAIN), fontSize: fs(19) }}
          >
            {loading ? '合成中…' : '开始朗读'}
          </Button>
        ) : (
          <IconButton
            onClick={isPlaying ? onPause : onPlay}
            aria-label={isPlaying ? '暂停' : '播放'}
            disabled={buffering && !isPlaying}
            sx={{
              width: su(BTN_MAIN),
              height: su(BTN_MAIN),
              color: 'primary.contrastText',
              bgcolor: 'primary.main',
              '&:hover': { bgcolor: 'primary.dark' },
              '&.Mui-disabled': { color: 'primary.contrastText', bgcolor: 'primary.main', opacity: 0.7 },
            }}
          >
            {buffering && !isPlaying ? (
              <CircularProgress size={24} color="inherit" />
            ) : isPlaying ? (
              <PauseIcon sx={{ fontSize: fs(38) }} />
            ) : (
              <PlayArrowIcon sx={{ fontSize: fs(38) }} />
            )}
          </IconButton>
        )}

        <Tooltip title="停止">
          <span>
            <IconButton
              onClick={onStop}
              disabled={!hasAudio}
              aria-label="停止"
              sx={{ width: su(BTN), height: su(BTN), border: '1px solid', borderColor: 'divider' }}
            >
              <StopIcon sx={{ fontSize: fs(26) }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="下一句">
          <span>
            <IconButton
              onClick={goNext}
              disabled={!hasAudio}
              aria-label="下一句"
              sx={{ width: su(BTN), height: su(BTN), border: '1px solid', borderColor: 'divider' }}
            >
              <SkipNextIcon sx={{ fontSize: fs(26) }} />
            </IconButton>
          </span>
        </Tooltip>

        {hasAudio && (
          <Button
            size="small"
            color="inherit"
            startIcon={<ReplayIcon sx={{ fontSize: fs(18) }} />}
            onClick={onRead}
            disabled={loading}
            sx={{ height: su(44) }}
          >
            {loading ? '合成中…' : '重新朗读'}
          </Button>
        )}
      </Stack>

      {/* 语速：低视力 / 阅读障碍用户最高频的调节，保持一级界面（不再藏在图标浮层里） */}
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ mt: 1.25, pt: 1.25, borderTop: '1px solid', borderColor: 'divider', flexWrap: 'wrap', rowGap: 0.75 }}
      >
        <Typography variant="subtitle2" sx={{ minWidth: su(40) }}>
          语速
        </Typography>
        <Tooltip title="放慢">
          <span>
            <IconButton
              onClick={() => setRate(rate - RATE_STEP)}
              aria-label="语速放慢"
              sx={{ width: su(BTN_RATE), height: su(BTN_RATE), border: '1px solid', borderColor: 'divider' }}
            >
              <RemoveIcon sx={{ fontSize: fs(20) }} />
            </IconButton>
          </span>
        </Tooltip>
        <Slider
          min={RATE_RANGE[0]}
          max={RATE_RANGE[1]}
          step={RATE_STEP}
          value={Math.max(RATE_RANGE[0], Math.min(RATE_RANGE[1], Number(rate) || 0))}
          onChange={(_, v) => setRate(v)}
          aria-label="语速"
          valueLabelDisplay="auto"
          sx={{ flex: 1, minWidth: su(120), mx: 0.5 }}
        />
        <Tooltip title="加快">
          <span>
            <IconButton
              onClick={() => setRate(rate + RATE_STEP)}
              aria-label="语速加快"
              sx={{ width: su(BTN_RATE), height: su(BTN_RATE), border: '1px solid', borderColor: 'divider' }}
            >
              <AddIcon sx={{ fontSize: fs(20) }} />
            </IconButton>
          </span>
        </Tooltip>
        <Typography
          variant="subtitle2"
          sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: su(48), textAlign: 'right' }}
        >
          {rate > 0 ? '+' : ''}
          {Number(rate) || 0}
        </Typography>
        <Button
          size="small"
          variant={rate === 0 ? 'text' : 'outlined'}
          onClick={() => setRate(0)}
          disabled={rate === 0}
          sx={{ height: su(44) }}
        >
          正常
        </Button>
      </Stack>

      {/* 句列表：次级信息，默认收起，按需展开（ButtonBase 化沿用 β 的实现） */}
      <Box sx={{ mt: 1.25, pt: 1, borderTop: '1px solid', borderColor: 'divider' }}>
        <ButtonBase
          onClick={() => setListOpen((v) => !v)}
          aria-expanded={listOpen}
          disabled={list.length === 0}
          sx={{
            borderRadius: 1,
            px: 1,
            // 无障碍红线：可点目标 ≥44px。原来只有 py:0.5（约 32px 高），
            // 低视力用户手指/视线都难以稳定命中。
            minHeight: su(44),
            py: 0.5,
            color: 'text.secondary',
            '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
            '&.Mui-disabled': { color: 'text.disabled' },
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {list.length > 0 ? `句列表 · 共 ${list.length} 句` : '句列表'}
          </Typography>
          <ExpandMoreIcon
            sx={{
              fontSize: fs(20),
              ml: 0.5,
              transform: listOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform .15s',
            }}
          />
        </ButtonBase>

        <Collapse in={listOpen} unmountOnExit>
          <Box
            data-scroll="1"
            sx={{
              mt: 0.75,
              maxHeight: su(200),
              overflowY: 'auto',
              px: 0.5,
              py: 0.5,
              borderRadius: 2,
              bgcolor: 'background.default',
              border: '1px solid',
              borderColor: 'divider',
              lineHeight: 1.8,
            }}
          >
            {list.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ display: 'block', pt: 1 }}>
                {hasAudio ? '本段没有句级标记，可用进度条拖动定位。' : '开始朗读后，可在这里按句跳转。'}
              </Typography>
            ) : (
              list.map((s, i) => {
                const active = i === currentSentence;
                return (
                  <ButtonBase
                    key={s.index != null ? s.index : i}
                    ref={active ? currentRef : null}
                    onClick={() => jumpTo(i)}
                    aria-current={active ? 'true' : undefined}
                    aria-label={`第 ${i + 1} 句，共 ${list.length} 句`}
                    focusRipple
                    sx={{
                      display: 'inline-block',
                      cursor: 'pointer',
                      px: 0.5,
                      py: 0.25,
                      mr: 0.25,
                      borderRadius: 1,
                      fontSize: fs(14),
                      textAlign: 'left',
                      verticalAlign: 'baseline',
                      transition: 'background-color .15s, color .15s',
                      bgcolor: active ? 'primary.main' : 'transparent',
                      color: active ? 'primary.contrastText' : 'text.secondary',
                      opacity: !active && s.ready === false ? 0.55 : 1,
                      fontWeight: active ? 600 : 400,
                      '&:hover': { color: active ? 'primary.contrastText' : 'text.primary' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 1 },
                    }}
                  >
                    {s.text}
                  </ButtonBase>
                );
              })
            )}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}
