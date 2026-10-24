import React from 'react';
import { Box, Typography, Slider, Stack, IconButton, Tooltip } from '@mui/material';
import { Tune, RestartAlt } from '@mui/icons-material';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放
// 与 shared/constants 保持一致的取值范围（渲染层不直接引用 CJS 常量文件）
const RATE_RANGE = [-50, 100];
const PITCH_RANGE = [-50, 50];
const VOLUME_RANGE = [-50, 50];

/** 单个参数行：标题 + 当前值（右对齐等宽数字）+ 滑块 */
function Row({ id, label, value, min, max, unit, onChange, wrapHint }) {
  const shown = `${value > 0 ? '+' : ''}${value}${unit}`;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" spacing={1}>
        <Typography variant="body2" component="p" id={`${id}-label`} sx={{ fontWeight: 600 }}>
          {label}
          {wrapHint ? (
            <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.75 }}>
              {wrapHint}
            </Typography>
          ) : null}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
          {shown}
        </Typography>
      </Stack>
      <Slider
        min={min}
        max={max}
        value={value}
        onChange={(_, v) => onChange(v)}
        valueLabelDisplay="auto"
        valueLabelFormat={(v) => `${v > 0 ? '+' : ''}${v}${unit}`}
        getAriaValueText={() => shown}
        aria-labelledby={`${id}-label`}
        sx={{ py: 0.75 }}
      />
    </Box>
  );
}

/**
 * 朗读参数（语速 / 语调 / 音量）。
 * @param {boolean} fullWidth 设置面板内使用：撑满卡片宽度（主界面气泡里保持固定宽度，避免被 Slider 固有宽度挤窄）
 * @param {boolean} flat      嵌入已有卡片时去掉自带描边与内边距
 * @param {boolean} hideTitle 外层已有「朗读参数」标题时不再重复渲染标题（只保留恢复默认按钮）
 */
export default function TuningPanel({ rate, pitch, volume, onChange, fullWidth, flat, hideTitle }) {
  const dirty = rate !== 0 || pitch !== 0 || volume !== 0;

  return (
    <Box
      sx={{
        p: flat ? 0 : 1.75,
        width: fullWidth ? '100%' : su(320),
        maxWidth: '100%',
        borderRadius: flat ? 0 : 3,
        bgcolor: flat ? 'transparent' : 'background.paper',
        border: flat ? 'none' : '1px solid',
        borderColor: 'divider',
      }}
    >
      {hideTitle ? null : (
        <Stack direction="row" alignItems="center" spacing={0.75} sx={{ mb: 1 }}>
          <Tune sx={{ fontSize: fs(20), color: 'primary.main' }} />
          <Typography variant="subtitle1" component="h4" sx={{ fontWeight: 700 }}>
            朗读参数
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="恢复默认（语速、语调、音量都归零）">
            <span>
              <IconButton
                disabled={!dirty}
                onClick={() => onChange({ rate: 0, pitch: 0, volume: 0 })}
                aria-label="恢复默认朗读参数"
              >
                <RestartAlt sx={{ fontSize: fs(20) }} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      )}
      <Stack spacing={1}>
        <Row
          id="tune-rate"
          label="语速"
          wrapHint="-50 最慢 / +100 最快"
          value={rate}
          min={RATE_RANGE[0]}
          max={RATE_RANGE[1]}
          unit="%"
          onChange={(v) => onChange({ rate: v })}
        />
        <Row
          id="tune-pitch"
          label="语调"
          value={pitch}
          min={PITCH_RANGE[0]}
          max={PITCH_RANGE[1]}
          unit="Hz"
          onChange={(v) => onChange({ pitch: v })}
        />
        <Row
          id="tune-volume"
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
