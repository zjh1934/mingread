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
  const subtitle = subtitleOf(voice);

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        pl: 1.25,
        pr: 1,
        py: 0.75,
        minHeight: su(64),
        borderRadius: 2,
        border: '1px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'action.selected' : 'transparent',
        opacity: disabled ? 0.6 : 1,
        transition: 'background-color .15s, border-color .15s',
      }}
    >
      {/* 选择区：整块可点（≥44px 高），且不与「试听」按钮嵌套，避免两个可交互元素互相吞事件 */}
      <Box
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-pressed={selected}
        aria-disabled={disabled || undefined}
        aria-label={`选择音色 ${voice.displayName}，${subtitle}${disabled ? '，需要联网' : ''}${
          selected ? '，当前已选中' : ''
        }`}
        data-selected={selected ? 'true' : 'false'}
        onClick={() => !disabled && onChange(voice.id)}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onChange(voice.id);
          }
        }}
        sx={{
          flex: 1,
          minWidth: 0,
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          minHeight: su(44),
          py: 0.5,
          cursor: disabled ? 'not-allowed' : 'pointer',
          borderRadius: 1.5,
          '&:focus-visible': { outline: 'var(--ldn-focus-width) solid var(--ldn-focus-color)', outlineOffset: 2 },
        }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.25 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {voice.displayName}
          </Typography>
          {selected && (
            <>
              <CheckCircle sx={{ fontSize: fs(18), color: 'primary.main' }} />
              <Box
                component="span"
                sx={{
                  px: 0.75,
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'primary.main',
                  color: 'primary.main',
                  fontSize: fs(12.5),
                  fontWeight: 700,
                  lineHeight: 1.6,
                }}
              >
                已选
              </Box>
            </>
          )}
        </Stack>
        {/* 低视力「看不全」：音色描述允许换行，禁止省略号截断 */}
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-word' }}>
          {subtitle}
          {disabled ? ' · 需要联网' : ''}
        </Typography>
      </Box>

      <Tooltip title={disabled ? '需要网络连接' : `试听 ${voice.displayName}（不会改变当前选择）`}>
        <span>
          <Button
            size="small"
            color={selected ? 'primary' : 'inherit'}
            variant={selected ? 'outlined' : 'text'}
            disabled={disabled || previewing}
            onClick={(e) => {
              e.stopPropagation();
              onPreview(voice);
            }}
            aria-label={`试听音色 ${voice.displayName}`}
            sx={{ minWidth: su(64), minHeight: su(44), fontSize: fs(14), flexShrink: 0 }}
            startIcon={previewing ? <CircularProgress size={su(14)} /> : null}
          >
            试听
          </Button>
        </span>
      </Tooltip>
    </Box>
  );
}

/**
 * 音色选择（次级）：既是主界面气泡内容，也内嵌在设置的「常用」分区。
 * 「配一次就不再动」的选择不该占据顶层位置；当前音色由触发按钮展示。
 * @param {boolean} inline 内嵌模式：去掉固定宽度与标题（外层已经有分区标题）
 */
export default function VoicePicker({ status, value, onChange, onPreview, previewingId, inline }) {
  // 审查发现（G-02）：这里原来硬编码 .slice(0, 2)，只显示前两个音色。
  // 后果是「音色源」功能白做——用户自己从源里装的发音人根本选不到。
  // 现在改成全部列出，列表限高可滚（音色多了不能把气泡撑爆）。
  const voices = status.voices && status.voices.length ? status.voices : FALLBACK_VOICES;

  return (
    <Box
      sx={{
        width: inline ? '100%' : su(320),
        maxWidth: '100%',
        p: inline ? 0 : 1.5,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {!inline && (
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1.25 }}>
          <RecordVoiceOver sx={{ fontSize: fs(20), color: 'primary.main' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            音色
          </Typography>
        </Stack>
      )}

      <Stack
        spacing={1}
        role="group"
        aria-label="音色选择"
        data-scroll="1"
        sx={{ maxHeight: su(280), overflowY: 'auto', pr: 0.25 }}
      >
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

      <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mt: 1.25 }}>
        {voices.length > 2 ? `共 ${voices.length} 个音色，列表可滚动。` : ''}
        点击选用，试听不改变当前选择
      </Typography>
    </Box>
  );
}
