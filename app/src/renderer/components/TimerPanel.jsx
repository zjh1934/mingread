import React, { useState } from 'react';
import { Box, Typography, Stack, Button, TextField, Chip } from '@mui/material';
import { Schedule } from '@mui/icons-material';
import { fs, su } from '../theme';

const PRESETS = [10, 20, 30, 60];

// 定时关闭：作为播放区「定时」气泡的内容，控制权在 useStreamingPlayback
export default function TimerPanel({ active, onStart, onClear }) {
  const [min, setMin] = useState(20);

  return (
    <Box sx={{ p: 2, width: su(280) }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Schedule sx={{ fontSize: fs(18), color: 'primary.main' }} />
        <Typography variant="subtitle2">定时关闭</Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.25 }}>
        到点自动暂停，适合睡前听书。
      </Typography>

      <Stack direction="row" spacing={0.75} sx={{ mb: 1.25, flexWrap: 'wrap', gap: 0.75 }}>
        {PRESETS.map((p) => (
          <Chip
            key={p}
            size="small"
            label={`${p} 分钟`}
            clickable
            color={min === p ? 'primary' : 'default'}
            variant={min === p ? 'filled' : 'outlined'}
            onClick={() => setMin(p)}
          />
        ))}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center">
        <TextField
          type="number"
          size="small"
          label="分钟"
          value={min}
          onChange={(e) => setMin(Math.max(1, Math.min(600, Number(e.target.value) || 1)))}
          sx={{ width: su(104) }}
          inputProps={{ min: 1, max: 600 }}
        />
        <Button size="small" variant="contained" onClick={() => onStart(min)}>
          开始
        </Button>
      </Stack>

      {active && (
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mt: 1.25 }}>
          <Typography variant="caption" color="success.main">
            定时关闭已开启
          </Typography>
          <Button size="small" color="inherit" onClick={onClear}>
            取消定时
          </Button>
        </Stack>
      )}
    </Box>
  );
}
