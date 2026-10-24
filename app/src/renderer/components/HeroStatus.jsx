// 首屏状态卡：这个窗口的第一职责是「让用户知道选中文字按热键就能读」，而不是当播放器。
//
// 背景（用户 2026-10-24 反馈「没有主次、没考虑操作习惯」）：
// 原首屏最大的一块是「当前句」空占位，而用户的主用法（选中文字按 F1）只在底部一行小字里提过。
// 所以这里把主用法放到首屏最显眼的位置：超大字号 + 高对比边框 + 状态徽标。
//
// 无障碍要点：
// · 字号随字号档位缩放（fs），低视力用户放大到 2.0x 时不破版（flexWrap + minWidth:0）
// · 图标 aria-hidden，语义由文字承担；整块 role="status" 便于读屏播报状态变化
// · 不承载任何操作（只显示状态），避免与播放控件的焦点顺序打架
import React from 'react';
import { Box, Stack, Typography, Chip } from '@mui/material';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { fs, su } from '../theme';

/**
 * @param {{hotkey?:string, hotkeyOk?:boolean, voiceName?:string, engineLabel?:string}} props
 */
export default function HeroStatus({ hotkey = 'F1', hotkeyOk = true, voiceName = '', engineLabel = '' }) {
  const ok = hotkeyOk !== false;
  const accent = ok ? 'primary.main' : 'error.main';

  return (
    <Box
      component="section"
      role="status"
      aria-live="polite"
      aria-label="朗读状态"
      sx={{
        p: { xs: 1.75, md: 2.25 },
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '2px solid',
        borderColor: accent,
        flexShrink: 0,
      }}
    >
      <Stack direction="row" spacing={{ xs: 1.5, md: 2 }} alignItems="center">
        <GraphicEqIcon aria-hidden sx={{ fontSize: fs(44), color: accent, flexShrink: 0 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: fs(26),
              fontWeight: 800,
              lineHeight: 1.25,
              wordBreak: 'break-word',
            }}
          >
            {ok ? `选中文字，按 ${hotkey} 就朗读` : `${hotkey} 被其他程序占用`}
          </Typography>

          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ mt: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}
          >
            <Chip
              size="small"
              label={ok ? '热键就绪' : '热键不可用'}
              color={ok ? 'success' : 'error'}
              variant="outlined"
              sx={{ height: su(24), fontWeight: 700 }}
            />
            {voiceName && (
              <Typography sx={{ fontSize: fs(14), color: 'text.secondary', fontWeight: 600 }}>
                {engineLabel ? `${engineLabel} · ${voiceName}` : voiceName}
              </Typography>
            )}
            {ok && (
              <Typography sx={{ fontSize: fs(14), color: 'text.secondary' }}>
                · 不用切回这个窗口
              </Typography>
            )}
          </Stack>

          {!ok && (
            <Typography sx={{ fontSize: fs(14), color: 'error.main', mt: 0.75, fontWeight: 600 }}>
              去设置里换一个热键，或退出占用它的程序（退出后会自动接管）。
            </Typography>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
