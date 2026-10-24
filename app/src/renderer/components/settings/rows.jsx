// 设置面板通用原语：分区卡片 / 开关行 / 选项组样式。
// 无障碍红线（低视力基线）：
//   · 开关不只靠颜色表意 —— 右侧固定显示「已开启 / 已关闭」文字（位置 + 文案冗余编码）
//   · 开关与可见标题通过 aria-labelledby 关联，状态与说明走 aria-describedby（读屏可念）
//   · 所有目标尺寸用 su()（随字号档位缩放，≥44px@1.0x），字号一律 fs()
import React from 'react';
import { Box, FormHelperText, Stack, Switch, Typography } from '@mui/material';
import { fs, su } from '../../theme';

/** ToggleButtonGroup 换行后的样式修补：分组自带的首尾拼边会错位，这里统一成独立圆角块 */
export const optionGroupSx = {
  flexWrap: 'wrap',
  gap: 0.75,
  '& .MuiToggleButtonGroup-grouped': {
    border: '1px solid',
    borderColor: 'divider',
    borderRadius: '10px !important',
    marginLeft: '0 !important',
    minHeight: su(44),
  },
  // 选中态用实心主色 + 反白文字：低视力下「浅灰底」几乎看不出选了哪个（2.0x 实测踩到）
  '& .MuiToggleButton-root.Mui-selected': {
    bgcolor: 'primary.main',
    color: 'primary.contrastText',
    borderColor: 'primary.main',
    '&:hover': { bgcolor: 'primary.main' },
  },
};

/** 分区内的一个设置组卡片：标题 + 说明 + 一组控件（action 放在标题右侧，如「恢复默认」） */
export function SettingGroup({ title, desc, action, children, sx }) {
  return (
    <Box
      component="section"
      sx={{
        p: { xs: 1.5, sm: 2 },
        borderRadius: 3,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        ...sx,
      }}
    >
      {title || action ? (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
          {title ? (
            <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }}>
              {title}
            </Typography>
          ) : (
            <Box sx={{ flex: 1 }} />
          )}
          {action || null}
        </Stack>
      ) : null}
      {desc ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {desc}
        </Typography>
      ) : null}
      <Stack spacing={1.75} sx={{ mt: title || desc ? 1.5 : 0 }}>
        {children}
      </Stack>
    </Box>
  );
}

/**
 * 开关行：左侧标题 + 状态文字 + 说明，右侧 Switch。
 * 状态文字既给低视力用户看，也通过 aria-describedby 让读屏念出来。
 */
export function SwitchRow({ id, label, desc, checked, onChange, disabled }) {
  const labelId = `${id}-label`;
  const stateId = `${id}-state`;
  const descId = desc ? `${id}-desc` : undefined;
  const describedBy = [stateId, descId].filter(Boolean).join(' ');

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.25}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography id={labelId} variant="body1" sx={{ fontWeight: 600 }}>
              {label}
            </Typography>
            <Box
              component="span"
              id={stateId}
              sx={{
                px: 1,
                py: 0.125,
                borderRadius: 1,
                border: '1px solid',
                borderColor: checked ? 'primary.main' : 'divider',
                color: checked ? 'primary.main' : 'text.secondary',
                fontSize: fs(12.5),
                fontWeight: 700,
                lineHeight: 1.6,
                whiteSpace: 'nowrap',
              }}
            >
              {checked ? '已开启' : '已关闭'}
            </Box>
          </Stack>
          {desc ? (
            <Typography id={descId} variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              {desc}
            </Typography>
          ) : null}
        </Box>
        <Switch
          checked={!!checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          // 主题里 Switch 是 62×42：上下各补 12px 内边距 → 可点区域 62×48（低视力目标 ≥44），
          // 左右内边距不动，滑块与轨道的位置保持原样
          sx={{ height: su(48), '& .MuiSwitch-switchBase': { paddingTop: su(12), paddingBottom: su(12) } }}
          inputProps={{ 'aria-labelledby': labelId, 'aria-describedby': describedBy }}
        />
      </Stack>
    </Box>
  );
}

/** 说明文字：低视力场景不用 tooltip 装关键信息 */
export function HelpText({ children, id }) {
  return (
    <FormHelperText id={id} sx={{ mx: 0, mt: 0, fontSize: fs(13), lineHeight: 1.7 }}>
      {children}
    </FormHelperText>
  );
}
