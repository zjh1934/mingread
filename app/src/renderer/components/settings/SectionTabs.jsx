// 设置面板分区导航（顶部横向 Tab，窄屏 / 2.0x 档位自动换行）。
// 用 role="tablist" + role="tab" 的显式语义，而不是 MUI Tabs：
//   · MUI Tabs 只能横向滚动，2.0x 下会被截断成「看不全」（低视力红线）
//   · 这里用 flexWrap 换行，每个分区按钮 minHeight su(48)、可整块点中
//   · 方向键 ← → ↑ ↓ 循环移动、Home / End 跳首尾（roving tabindex，只有一个 Tab 停留点）
import React, { useRef } from 'react';
import { Box, ButtonBase } from '@mui/material';
import { fs, su } from '../../theme';

export default function SectionTabs({ sections, value, onChange }) {
  const refs = useRef([]);
  const index = Math.max(
    0,
    sections.findIndex((s) => s.key === value)
  );

  const goto = (next) => {
    const n = sections.length;
    const i = ((next % n) + n) % n;
    onChange(sections[i].key, { keyboard: true });
    const el = refs.current[i];
    if (el && typeof el.focus === 'function') el.focus();
  };

  return (
    <Box
      role="tablist"
      aria-label="设置分区"
      aria-orientation="horizontal"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 0.5,
        px: 1.25,
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        // 关键：对话框是 flex 列布局，默认 flex-shrink:1 会把「换行后的第二排」压掉，
        // 让分区按钮叠到内容上（2.0x 实测踩到）。这里禁止收缩，换行多少排就占多少高度。
        flexShrink: 0,
      }}
    >
      {sections.map((s, i) => {
        const selected = s.key === value;
        return (
          <ButtonBase
            key={s.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`settings-tab-${s.key}`}
            aria-selected={selected}
            aria-controls={`settings-panel-${s.key}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(s.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                goto(i + 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                goto(i - 1);
              } else if (e.key === 'Home') {
                e.preventDefault();
                goto(0);
              } else if (e.key === 'End') {
                e.preventDefault();
                goto(sections.length - 1);
              }
            }}
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 0.75,
              minHeight: su(44),
              minWidth: su(44),
              px: 1.25,
              py: 0.5,
              borderRadius: 2.5,
              border: '1px solid',
              borderColor: selected ? 'primary.main' : 'divider',
              bgcolor: selected ? 'primary.main' : 'transparent',
              color: selected ? 'primary.contrastText' : 'text.primary',
              fontSize: fs(15),
              fontWeight: 700,
              flexShrink: 0,
              transition: 'background-color .15s, color .15s, border-color .15s',
              '&:hover': { bgcolor: selected ? 'primary.main' : 'action.hover' },
              '&.Mui-focusVisible': {
                outline: 'var(--ldn-focus-width) solid var(--ldn-focus-color)',
                outlineOffset: 2,
              },
            }}
          >
            {s.icon}
            <span>{s.label}</span>
          </ButtonBase>
        );
      })}
    </Box>
  );
}
