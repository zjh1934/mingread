import React, { useState } from 'react';
import { Box, Typography, Stack, Button, TextField, Chip } from '@mui/material';
import { Schedule } from '@mui/icons-material';
import { fs, su } from '../theme';

const PRESETS = [10, 20, 30, 60];
const MAX_MINUTES = 600;

// 定时关闭：主界面「定时」气泡与设置面板「朗读」分区共用同一套 UI。
// embedded=true 时铺满卡片（设置面板内），否则保持气泡的固定宽度。
export default function TimerPanel({ active, onStart, onClear, embedded }) {
  const [min, setMin] = useState(20);

  const setClamped = (raw) => {
    const n = Number(raw);
    if (!isFinite(n)) {
      setMin(1);
      return;
    }
    setMin(Math.max(1, Math.min(MAX_MINUTES, Math.round(n))));
  };

  return (
    <Box sx={{ p: embedded ? 0 : 2, width: embedded ? '100%' : su(280), maxWidth: '100%' }}>
      {!embedded && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Schedule sx={{ fontSize: fs(20), color: 'primary.main' }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            定时关闭
          </Typography>
        </Stack>
      )}

      {/* 内嵌在设置「朗读」分区时，分组说明已经写了用途，这里只在定时开启后补一句状态，避免同一句话念两遍 */}
      {!embedded || active ? (
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
          {active ? '定时已开启：到点会自动停止朗读，可随时取消。' : '到点自动暂停，适合睡前听书。'}
        </Typography>
      ) : null}

      <Stack direction="row" spacing={0.75} sx={{ mb: 1.25, flexWrap: 'wrap', gap: 0.75 }} role="group" aria-label="常用时长">
        {PRESETS.map((p) => {
          const selected = min === p;
          return (
            <Chip
              key={p}
              label={`${p} 分钟`}
              clickable
              onClick={() => setMin(p)}
              color={selected ? 'primary' : 'default'}
              variant={selected ? 'filled' : 'outlined'}
              aria-pressed={selected}
              aria-label={`定时 ${p} 分钟${selected ? '，已选择' : ''}`}
              sx={{ height: su(44), fontSize: fs(14) }}
            />
          );
        })}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <TextField
          type="number"
          size="small"
          label="分钟"
          value={min}
          onChange={(e) => setClamped(e.target.value)}
          sx={{ width: su(120), maxWidth: '100%' }}
          inputProps={{ min: 1, max: MAX_MINUTES, 'aria-label': '定时关闭的分钟数' }}
          helperText={`1 到 ${MAX_MINUTES} 分钟`}
          FormHelperTextProps={{ sx: { fontSize: fs(13), mx: 0 } }}
        />
        <Button variant="contained" onClick={() => onStart(min)} sx={{ minHeight: su(44) }}>
          {active ? '重新计时' : '开始计时'}
        </Button>
      </Stack>

      {active && (
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" sx={{ color: 'success.main', fontWeight: 700 }}>
            定时关闭已开启
          </Typography>
          <Button color="inherit" variant="outlined" onClick={onClear} sx={{ minHeight: su(44) }}>
            取消定时
          </Button>
        </Stack>
      )}
    </Box>
  );
}
