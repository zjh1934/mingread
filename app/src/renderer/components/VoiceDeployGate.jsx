import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Stack, Typography, Button, LinearProgress, Alert, Chip } from '@mui/material';
import { CloudOff, Download, Replay, VolumeUp } from '@mui/icons-material';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放

// 首启引导：本地离线语音（NVSA + 晓晓 / 云希）没装好时，给一个「一键安装」入口。
//
// ⚠️ 本组件只负责「呈现 + 触发」，不自己跑安装流程：
//   · 状态由主进程 voiceDeploy.js 的状态机提供（props.snapshot 或 IPC 订阅）；
//   · 点按钮 → props.onInstall（编排者接线），未接线时退回 window.langdu.voiceDeploy.install()；
//   · 任何失败都只是「离线语音没装成」，在线语音照常可用 —— 文案必须说清楚，别吓用户。
//
// 无障碍（低视力基线）：
//   · 所有尺寸走 su()/fs()，跟字号档位一起放大；按钮 ≥ 44px；
//   · 进度用 determinate 进度条 + aria-valuetext（百分比之外还给「正在做什么」）；
//   · 状态文本 aria-live="polite"，失败 aria-live="assertive"（role="alert"）；
//   · 不用颜色单独表意：失败同时有图标 + 文字 + 下一步说明。

const FAILED_STATES = [
  'FAILED_DOWNLOAD',
  'FAILED_NETFX3',
  'FAILED_ELEVATION',
  'FAILED_REGISTER',
  'FAILED_EXTRACT',
  'FAILED_VERIFY',
];

const BUSY_STATES = [
  'DETECTING',
  'INSTALLING_NETFX3',
  'DOWNLOADING',
  'EXTRACTING',
  'REGISTERING',
  'WRITING_CONFIG',
  'VERIFYING',
];

const EMPTY_VIEW = { state: 'IDLE', pct: 0, label: '', error: null, ready: false };

/** 未来的 IPC 契约（见回执「契约申请」）：window.langdu.voiceDeploy.{getState,install,onStateChanged} */
function bridgeApi() {
  if (typeof window === 'undefined') return null;
  const lg = window.langdu || {};
  const api = lg.voiceDeploy;
  if (!api) return null;
  return typeof api.getState === 'function' ? api : null;
}

function errorText(error) {
  if (!error) return '';
  const msg = String(error.message || '').trim();
  const next = String(error.nextStep || '').trim();
  return next ? `${msg}。${next}` : msg;
}

export default function VoiceDeployGate({
  snapshot,
  onInstall,
  onRetry,
  onDismiss,
  autoFocus = false,
  compact = false,
}) {
  const [live, setLive] = useState(null);
  const primaryRef = useRef(null);

  // 没有外部 snapshot 时，尝试自己订阅主进程状态（编排者接了 IPC 就能零 props 使用）
  useEffect(() => {
    if (snapshot) return undefined;
    const api = bridgeApi();
    if (!api) return undefined;
    let alive = true;
    api
      .getState()
      .then((s) => {
        if (alive && s) setLive(s);
      })
      .catch(() => {});
    const off = typeof api.onStateChanged === 'function' ? api.onStateChanged((s) => alive && s && setLive(s)) : null;
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, [snapshot]);

  const view = snapshot || live || EMPTY_VIEW;
  const state = String(view.state || 'IDLE');
  const busy = BUSY_STATES.indexOf(state) >= 0 || !!view.busy;
  const failed = FAILED_STATES.indexOf(state) >= 0 || !!view.error;
  const ready = state === 'READY' || !!view.ready;
  const pct = Math.max(0, Math.min(100, Math.round(Number(view.pct) || 0)));

  useEffect(() => {
    if (!autoFocus || ready) return;
    const t = setTimeout(() => {
      if (primaryRef.current) primaryRef.current.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [autoFocus, ready]);

  const trigger = useCallback(() => {
    const fn = failed ? onRetry || onInstall : onInstall;
    if (typeof fn === 'function') {
      fn();
      return;
    }
    const api = bridgeApi();
    if (api && typeof api.install === 'function') api.install();
  }, [failed, onRetry, onInstall]);

  // 已就绪：这个引导整体消失（不占首屏、不干扰朗读）
  if (ready) return null;

  const label = String(view.label || '').trim() || (failed ? '离线语音没有装好' : '还没安装离线语音');
  const errText = errorText(view.error);

  return (
    <Box
      component="section"
      aria-labelledby="voice-deploy-title"
      sx={{
        p: compact ? 1.5 : 2,
        border: '1px solid',
        borderColor: failed ? 'error.main' : 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        maxWidth: su(560),
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        {failed ? <CloudOff sx={{ fontSize: fs(20), color: 'error.main' }} /> : <VolumeUp sx={{ fontSize: fs(20), color: 'primary.main' }} />}
        <Typography id="voice-deploy-title" variant="subtitle1" sx={{ fontWeight: 600 }}>
          离线语音
        </Typography>
        <Chip
          size="small"
          label={failed ? '未完成' : busy ? '安装中' : '未安装'}
          color={failed ? 'error' : busy ? 'primary' : 'default'}
          variant={failed || busy ? 'filled' : 'outlined'}
        />
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5, wordBreak: 'break-word' }}>
        装一次「晓晓 / 云希」离线语音后，断网也能朗读，热键出字更快。安装约 138 MB，
        中途只会向你要一次管理员授权。现在不装也能用，只是需要联网。
      </Typography>

      {busy && (
        <Box sx={{ mb: 1.5 }}>
          <LinearProgress
            variant="determinate"
            value={pct}
            aria-label="离线语音安装进度"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${pct}%，${label}`}
            sx={{ height: su(10), borderRadius: 1 }}
          />
          <Typography variant="body2" sx={{ mt: 0.75 }} aria-live="polite">
            {label}（{pct}%）
          </Typography>
        </Box>
      )}

      {!busy && (
        <Typography variant="body2" sx={{ mb: 1.5 }} aria-live="polite">
          {label}
        </Typography>
      )}

      {failed && errText && (
        <Alert
          severity="error"
          role="alert"
          sx={{ mb: 1.5, '& .MuiAlert-message': { wordBreak: 'break-word' } }}
        >
          {errText}
        </Alert>
      )}

      {!busy && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button
            ref={primaryRef}
            variant="contained"
            onClick={trigger}
            startIcon={
              failed ? <Replay sx={{ fontSize: fs(18) }} /> : <Download sx={{ fontSize: fs(18) }} />
            }
            sx={{ minHeight: su(44), fontSize: fs(15), px: 2 }}
          >
            {failed ? '重试安装离线语音' : '一键安装离线语音'}
          </Button>
          {typeof onDismiss === 'function' && (
            <Button
              variant="text"
              color="inherit"
              onClick={onDismiss}
              sx={{ minHeight: su(44), fontSize: fs(14) }}
            >
              暂不安装，先用在线语音
            </Button>
          )}
        </Stack>
      )}
    </Box>
  );
}
