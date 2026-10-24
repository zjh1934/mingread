import React from 'react';
import { Box, Typography, Stack, Tooltip, CircularProgress, Button } from '@mui/material';
import { CheckCircle, RecordVoiceOver } from '@mui/icons-material';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放

// 主进程未返回前先用固定两只音色占位，保证面板始终只有两行
const FALLBACK_VOICES = [
  { id: 'edge:xiaoxiao', displayName: '晓晓', gender: 'female', desc: '亲切自然', available: true },
  { id: 'edge:yunxi', displayName: '云希', gender: 'male', desc: '沉稳干净', available: true },
];

const GENDER_LABEL = { female: '女声', male: '男声' };

// desc 里常已含「女声 / 男声」，避免副标题重复
function subtitleOf(voice) {
  const gender = GENDER_LABEL[voice.gender] || '音色';
  const extra = String(voice.desc || '')
    .split('·')
    .map((s) => s.trim())
    .filter((s) => s && s !== '女声' && s !== '男声');
  return [gender, ...extra].join(' · ');
}

function VoiceRow({ voice, selected, previewing, onChange, onPreview }) {
  const disabled = voice.available === false;

  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      data-selected={selected ? 'true' : 'false'}
      onClick={() => !disabled && onChange(voice.id)}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onChange(voice.id);
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        py: 1,
        minHeight: su(64),
        borderRadius: 2,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'action.selected' : 'transparent',
        transition: 'background-color .15s, border-color .15s',
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {voice.displayName}
          </Typography>
          {selected && <CheckCircle sx={{ fontSize: fs(15), color: 'primary.main' }} />}
        </Stack>
        {/* 低视力「看不全」：音色描述允许换行，禁止省略号截断 */}
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
          {subtitleOf(voice)}
          {disabled ? ' · 需要联网' : ''}
        </Typography>
      </Box>

      <Tooltip title={disabled ? '需要网络连接' : '试听'}>
        <span>
          <Button
            size="small"
            color={selected ? 'primary' : 'inherit'}
            disabled={disabled || previewing}
            onClick={(e) => {
              e.stopPropagation();
              onPreview(voice);
            }}
            sx={{ minWidth: su(64), height: su(44), fontSize: fs(13.5) }}
            startIcon={previewing ? <CircularProgress size={12} /> : null}
          >
            试听
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}

/**
 * 音色选择（次级）：从右侧整栏降为次级入口的弹层内容。
 * 「配一次就不再动」的选择不该占据顶层位置；当前音色由触发按钮展示。
 */
export default function VoicePicker({ status, value, onChange, onPreview, previewingId }) {
  const voices = (status.voices && status.voices.length ? status.voices : FALLBACK_VOICES).slice(0, 2);

  return (
    <Box
      sx={{
        width: su(320),
        p: 1.5,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1.25 }}>
        <RecordVoiceOver sx={{ fontSize: fs(18), color: 'primary.main' }} />
        <Typography variant="subtitle2">音色</Typography>
      </Stack>

      <Stack spacing={1}>
        {voices.map((v) => (
          <VoiceRow
            key={v.id}
            voice={v}
            selected={value === v.id}
            previewing={previewingId === v.id}
            onChange={onChange}
            onPreview={onPreview}
          />
        ))}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1.25 }}>
        点击选用，试听不改变当前选择
      </Typography>
    </Box>
  );
}
