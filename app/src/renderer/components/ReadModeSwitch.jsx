// 朗读方式切换（热键 / 悬停，二选一）
//
// 位置：紧跟首屏状态卡。用户要在首页一眼看到并能切，而不是钻进设置里翻。
//
// 设计取舍：
//   · 用「分段按钮」而不是 Switch：两个选项是对等选择，Switch 会暗示"开/关"某个功能，
//     而这里没有"关掉朗读"这个状态；
//   · 选中态用**实心主色 + 反白**，不用浅灰底——之前设置面板踩过这个坑，
//     低视力用户看不出哪一项被选中；
//   · role=radiogroup + aria-checked：读屏会念「单选按钮，已选中」，
//     切换后主动播报新方式，纯语音用户也知道自己刚选了什么；
//   · 每个按钮 ≥44px，2.0x 档位用 flexWrap 换行不破版。
import React, { useCallback, useState } from 'react';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import MouseIcon from '@mui/icons-material/Mouse';
import announcer from '../services/announcer';
import { fs, su } from '../theme';
import { useSettings } from '../store/settingsStore';

const OPTIONS = [
  { value: 'hotkey', label: '选中后按热键', hint: '先选中再按', Icon: KeyboardIcon },
  { value: 'hover', label: '鼠标停住就读', hint: '不用选中', Icon: MouseIcon },
];

function bridge() {
  return window.mingread || window.langdu || {};
}

export default function ReadModeSwitch() {
  const readMode = useSettings((s) => s.readMode) || 'hotkey';
  const [saving, setSaving] = useState('');

  const choose = useCallback(
    async (value) => {
      if (value === readMode || saving) return;
      announcer.cue('press');
      setSaving(value);
      // 先本地生效：切换要立刻看到，不能等 IPC 往返
      useSettings.setState({ readMode: value });
      try {
        const r = await bridge().saveSystemSettings?.({ readMode: value });
        if (r && r.ok === false) {
          useSettings.setState({ readMode });
          announcer.say('readModeFail', (r && r.error) || '切换朗读方式失败');
        } else {
          announcer.say(
            value === 'hover' ? 'readModeHover' : 'readModeHotkey',
            value === 'hover'
              ? '已切换到鼠标悬停朗读：把指针停在文字上就会读，不用选中。'
              : '已切换到热键朗读：选中文字后按热键。'
          );
        }
      } catch (e) {
        useSettings.setState({ readMode });
        announcer.say('readModeFail', '切换朗读方式失败');
      } finally {
        setSaving('');
      }
    },
    [readMode, saving]
  );

  return (
    <Box
      component="section"
      aria-label="朗读方式"
      sx={{
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        px: { xs: 1.25, md: 1.5 },
        py: { xs: 1, md: 1.25 },
        display: 'flex',
        alignItems: 'center',
        columnGap: 1.5,
        rowGap: 1,
        flexWrap: 'wrap',
        flexShrink: 0,
      }}
    >
      <Typography sx={{ fontSize: fs(14), fontWeight: 700, color: 'text.secondary', flexShrink: 0 }}>
        怎么读
      </Typography>

      <Stack
        role="radiogroup"
        aria-label="朗读方式，二选一"
        direction="row"
        sx={{ columnGap: su(8), rowGap: su(8), flexWrap: 'wrap', minWidth: 0 }}
      >
        {OPTIONS.map(({ value, label, hint, Icon }) => {
          const selected = readMode === value;
          return (
            <ButtonBase
              key={value}
              role="radio"
              aria-checked={selected}
              onClick={() => choose(value)}
              disabled={!!saving}
              sx={{
                minHeight: su(44),
                px: su(14),
                py: su(6),
                borderRadius: 2.5,
                border: '2px solid',
                borderColor: selected ? 'primary.main' : 'divider',
                bgcolor: selected ? 'primary.main' : 'transparent',
                color: selected ? 'primary.contrastText' : 'text.primary',
                display: 'flex',
                alignItems: 'center',
                columnGap: su(8),
                justifyContent: 'flex-start',
                transition: 'background-color .12s, border-color .12s',
                '&:hover': { borderColor: 'primary.main' },
                '&.Mui-focusVisible': { outline: `3px solid`, outlineColor: 'primary.dark' },
              }}
            >
              <Icon aria-hidden sx={{ fontSize: fs(20), flexShrink: 0 }} />
              <Box sx={{ textAlign: 'left', minWidth: 0 }}>
                <Typography sx={{ fontSize: fs(14.5), fontWeight: 700, lineHeight: 1.3 }}>
                  {label}
                </Typography>
                <Typography
                  sx={{
                    fontSize: fs(12),
                    lineHeight: 1.3,
                    opacity: selected ? 0.86 : 0.7,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {hint}
                </Typography>
              </Box>
            </ButtonBase>
          );
        })}
      </Stack>

      {readMode === 'hover' && (
        <Typography sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.5, minWidth: 0 }}>
          指针停住约 0.7 秒触发；热键在这模式下不朗读。
        </Typography>
      )}
    </Box>
  );
}
