// 朗读方式切换（热键 / 悬停，二选一）+ 悬停模式的详细度
//
// 位置：紧跟首屏状态卡。用户要在首页一眼看到并能切，而不是钻进设置里翻。
//
// 对齐 macOS：
//   · 主选项是「热键 / 悬停」二选一 —— macOS 用的是修饰键 + 可调延迟，我们把它做成显式的两选一；
//   · 详细度 Low/Medium/High 是 macOS Hover Text 原样有的设置（少/中/多）；
//     悬停选中时才显示，避免热键模式下出现无关选项。
//
// 设计取舍：
//   · 用「分段按钮」而不是 Switch：两个选项对等，Switch 会暗示"开/关"某个功能，
//     而这里没有"关掉朗读"这个状态；
//   · 选中态用**实心主色 + 反白**，不用浅灰底——低视力用户看不出哪一项被选中（设置面板踩过这个坑）；
//   · role=radiogroup + aria-checked，切换后主动播报，纯语音用户也知道自己刚选了什么；
//   · 每个按钮 ≥44px，2.0x 档位用 flexWrap 换行不破版。
import React, { useCallback, useState } from 'react';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import MouseIcon from '@mui/icons-material/Mouse';
import announcer from '../services/announcer';
import { fs, su } from '../theme';
import { useSettings } from '../store/settingsStore';

const MODES = [
  { value: 'hotkey', label: '选中后按热键', hint: '先选中再按', Icon: KeyboardIcon },
  { value: 'hover', label: '鼠标停住就读', hint: '不用选中', Icon: MouseIcon },
];

const DETAILS = [
  { value: 'low', label: '少', hint: '一句' },
  { value: 'medium', label: '中', hint: '一段' },
  { value: 'high', label: '多', hint: '本段+下文' },
];

function bridge() {
  return window.mingread || window.langdu || {};
}

/** 通用分段按钮：选中态实心主色反白 */
function SegButton({ selected, onClick, disabled, label, hint, Icon, compact }) {
  return (
    <ButtonBase
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      disabled={disabled}
      sx={{
        minHeight: su(44),
        minWidth: compact ? su(56) : 0,
        px: compact ? su(12) : su(14),
        py: su(6),
        borderRadius: 2.5,
        border: '2px solid',
        borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? 'primary.main' : 'transparent',
        color: selected ? 'primary.contrastText' : 'text.primary',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        columnGap: su(8),
        transition: 'background-color .12s, border-color .12s',
        '&:hover': { borderColor: 'primary.main' },
        '&.Mui-focusVisible': { outline: '3px solid', outlineColor: 'primary.dark' },
      }}
    >
      {Icon && <Icon aria-hidden sx={{ fontSize: fs(20), flexShrink: 0 }} />}
      <Box sx={{ textAlign: compact ? 'center' : 'left', minWidth: 0 }}>
        <Typography sx={{ fontSize: fs(compact ? 14 : 14.5), fontWeight: 700, lineHeight: 1.3 }}>
          {label}
        </Typography>
        {hint && (
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
        )}
      </Box>
    </ButtonBase>
  );
}

export default function ReadModeSwitch() {
  const readMode = useSettings((s) => s.readMode) || 'hotkey';
  const hoverDetail = useSettings((s) => s.hoverDetail) || 'medium';
  const [saving, setSaving] = useState('');

  const save = useCallback(
    async (patch, sayKey, sayText, rollback) => {
      announcer.cue('press');
      setSaving(Object.keys(patch).join(','));
      // 先本地生效：切换要立刻看到，不能等 IPC 往返
      useSettings.setState(patch);
      try {
        const r = await bridge().saveSystemSettings?.(patch);
        if (r && r.ok === false) {
          useSettings.setState(rollback);
          announcer.say('readModeFail', (r && r.error) || '设置失败');
        } else if (sayText) {
          announcer.say(sayKey, sayText);
        }
      } catch (e) {
        useSettings.setState(rollback);
        announcer.say('readModeFail', '设置失败');
      } finally {
        setSaving('');
      }
    },
    []
  );

  const chooseMode = useCallback(
    (value) => {
      if (value === readMode || saving) return;
      save(
        { readMode: value },
        value === 'hover' ? 'readModeHover' : 'readModeHotkey',
        value === 'hover'
          ? '已切换到鼠标悬停朗读：把指针停在文字上就会读，不用选中。'
          : '已切换到热键朗读：选中文字后按热键。',
        { readMode }
      );
    },
    [readMode, saving, save]
  );

  const chooseDetail = useCallback(
    (value) => {
      if (value === hoverDetail || saving) return;
      const label = (DETAILS.find((d) => d.value === value) || {}).hint || '';
      save({ hoverDetail: value }, 'hoverDetail', `每次读${label}。`, { hoverDetail });
    },
    [hoverDetail, saving, save]
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
        flexDirection: 'column',
        rowGap: 1,
        flexShrink: 0,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1.5, rowGap: 1, flexWrap: 'wrap' }}>
        <Typography sx={{ fontSize: fs(14), fontWeight: 700, color: 'text.secondary', flexShrink: 0 }}>
          怎么读
        </Typography>
        <Stack role="radiogroup" aria-label="朗读方式，二选一" direction="row" sx={{ columnGap: su(8), rowGap: su(8), flexWrap: 'wrap', minWidth: 0 }}>
          {MODES.map(({ value, label, hint, Icon }) => (
            <SegButton
              key={value}
              selected={readMode === value}
              onClick={() => chooseMode(value)}
              disabled={!!saving}
              label={label}
              hint={hint}
              Icon={Icon}
            />
          ))}
        </Stack>
        {readMode === 'hotkey' && (
          <Typography sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.5, minWidth: 0 }}>
            选中文字后按热键。
          </Typography>
        )}
      </Box>

      {readMode === 'hover' && (
        <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 1.5, rowGap: 1, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: fs(14), fontWeight: 700, color: 'text.secondary', flexShrink: 0 }}>
            读多少
          </Typography>
          <Stack role="radiogroup" aria-label="每次朗读多少" direction="row" sx={{ columnGap: su(6), rowGap: su(6), flexWrap: 'wrap' }}>
            {DETAILS.map((d) => (
              <SegButton
                key={d.value}
                selected={hoverDetail === d.value}
                onClick={() => chooseDetail(d.value)}
                disabled={!!saving}
                label={d.label}
                hint={d.hint}
                compact
              />
            ))}
          </Stack>
          <Typography sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.5, minWidth: 0 }}>
            指针停住约 0.6 秒触发，读到的位置会框出来。
          </Typography>
        </Box>
      )}
    </Box>
  );
}
