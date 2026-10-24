import React from 'react';
import { Box, Typography, Slider, Stack, IconButton, Tooltip } from '@mui/material';
import { Tune, RestartAlt } from '@mui/icons-material';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放
// 与 shared/constants 保持一致的取值范围（渲染层不直接引用 CJS 常量文件）
const RATE_RANGE = [-50, 100];
const PITCH_RANGE = [-50, 50];
const VOLUME_RANGE = [-50, 50];

function Row({ label, value, min, max, unit, onChange }) {
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="caption" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {value > 0 ? '+' : ''}
          {value}
          {unit}
        </Typography>
      </Stack>
      <Slider
        min={min}
        max={max}
        value={value}
        onChange={(_, v) => onChange(v)}
        size="small"
        valueLabelDisplay="auto"
        sx={{ py: 0.75 }}
      />
    </Box>
  );
}

export default function TuningPanel({ rate, pitch, volume, onChange }) {
  const dirty = rate !== 0 || pitch !== 0 || volume !== 0;

  return (
    // 显式宽度：与 VoicePicker 一致（su(320)）。原无宽度时 Popover 按 Slider
    // 固有宽度收缩到 ~172px@1x，2.0x 档下滑杆与数值标签挤压难用
    <Box sx={{ p: 1.75, width: su(320), borderRadius: 3, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1 }}>
        <Tune sx={{ fontSize: fs(17), color: 'primary.main' }} />
        <Typography variant="subtitle2">朗读参数</Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="恢复默认">
          <span>
            <IconButton
              size="small"
              disabled={!dirty}
              onClick={() => onChange({ rate: 0, pitch: 0, volume: 0 })}
              aria-label="恢复默认参数"
            >
              <RestartAlt sx={{ fontSize: fs(16) }} />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Stack spacing={0.5}>
        <Row
          label="语速"
          value={rate}
          min={RATE_RANGE[0]}
          max={RATE_RANGE[1]}
          unit="%"
          onChange={(v) => onChange({ rate: v })}
        />
        <Row
          label="语调"
          value={pitch}
          min={PITCH_RANGE[0]}
          max={PITCH_RANGE[1]}
          unit="Hz"
          onChange={(v) => onChange({ pitch: v })}
        />
        <Row
          label="音量"
          value={volume}
          min={VOLUME_RANGE[0]}
          max={VOLUME_RANGE[1]}
          unit="%"
          onChange={(v) => onChange({ volume: v })}
        />
      </Stack>
    </Box>
  );
}
