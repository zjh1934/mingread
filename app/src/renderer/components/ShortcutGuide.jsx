// 快捷键速查卡（首屏第 5 块，紧跟在「朗读文本」之后）。
//
// 背景：低视力用户记不住热键是真实痛点——但热键又不能全塞进首屏，
// 否则回到「首屏全是说明、没有主操作」的老问题。折中：
//   · 默认只占一行（标题 + 条数 + 箭头），不抢 HeroStatus 的注意力；
//   · 需要时展开成一张表，一次看全「哪个键干什么」。
//
// 无障碍要点（低视力 + 读屏）：
//   · 展开/收起是标准 disclosure：整行是按钮，aria-expanded + aria-controls；
//   · 展开、收起都 announcer.say 播报条数，纯语音用户也知道刚打开了什么；
//   · 用语义化 table + th[scope=row]：读屏按「热键 → 作用」成对念，不会串行；
//   · 热键值从 store 读（主进程是权威源），用户改过热键后这里立刻跟着变，不写死 F1；
//   · 所有字号 fs()、尺寸 su()，2.0x 档位下靠 flexWrap / wordBreak 换行不破版。
//
// 为什么 F1 这一行不做成按钮：主进程的「朗读选中文字」靠给**前台窗口**发 Ctrl+C 抓选区
// （见 src/main/selectionReader.js）。在本窗口里点按钮会把前台切成本窗口，Ctrl+C 抓不到
// 别的程序里的选区，按钮必然失败——那比不给按钮更糟。所以这里只做「提醒 + 明确说明
// 热键是全局的、不用切回本窗口」，让用户自己按。
import React, { useCallback, useState } from 'react';
import { Box, Stack, Typography, ButtonBase, Chip } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useSettings } from '../store/settingsStore';
import announcer from '../services/announcer';
import { fs, su } from '../theme';

const PANEL_ID = 'shortcut-guide-panel';

// 屏幕缩放热键在主进程 zoomController.js（ZOOM_HOTKEYS）里是写死常量，
// settings.json / store 里没有对应字段、设置界面也不可改 —— 因此这里用同一份默认值，
// 并如实标注「固定」，不假装它们可配置。
const ZOOM_KEYS = [
  { keys: ['Ctrl', 'Alt', '='], label: '放大一档', note: '屏幕缩放没开时会自动打开' },
  { keys: ['Ctrl', 'Alt', '-'], label: '缩小一档' },
  { keys: ['Ctrl', 'Alt', '0'], label: '退出放大', note: '回到 1 倍' },
  { keys: ['Ctrl', 'Alt', 'Q'], label: '倍率快速循环', note: '2 → 4 → 8 → 16 → 32 依次跳' },
];

/** "Ctrl+Alt+R" → ['Ctrl','Alt','R']；空值回落到默认 F1 */
function splitKeys(accel) {
  const raw = String(accel || '').trim() || 'F1';
  return raw
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** 一枚按键（kbd）。用 inherit 字体，跟主界面字号档位一起缩放 */
function Key({ children }) {
  return (
    <Box
      component="kbd"
      sx={{
        display: 'inline-block',
        fontFamily: 'inherit',
        fontSize: fs(14),
        fontWeight: 700,
        lineHeight: 1.4,
        minWidth: su(24),
        textAlign: 'center',
        px: su(7),
        py: su(3),
        borderRadius: su(8),
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'action.hover',
        color: 'text.primary',
      }}
    >
      {children}
    </Box>
  );
}

function KeyCombo({ keys }) {
  return (
    <Stack
      direction="row"
      sx={{ flexWrap: 'nowrap', alignItems: 'center', columnGap: su(4) }}
    >
      {keys.map((k, i) => (
        <React.Fragment key={`${k}-${i}`}>
          {i > 0 && (
            <Typography component="span" sx={{ fontSize: fs(13), color: 'text.secondary' }}>
              +
            </Typography>
          )}
          <Key>{k}</Key>
        </React.Fragment>
      ))}
    </Stack>
  );
}

export default function ShortcutGuide() {
  const hotkey = useSettings((s) => s.hotkey);
  const clipboardAuto = useSettings((s) => s.clipboardAuto);
  const [open, setOpen] = useState(false);

  // 主用法永远排第一：这是用户最需要记住的一条，其余按「缩放 → 复制」排序
  const rows = [
    {
      id: 'read-selection',
      keys: splitKeys(hotkey),
      label: '朗读选中文字',
      note: '在任意程序里选中文字后按，不用切回本窗口。',
      strong: true,
    },
    ...ZOOM_KEYS.map((r) => ({ id: `zoom-${r.keys.join('')}`, ...r })),
    {
      id: 'clipboard-auto',
      keys: ['Ctrl', 'C'],
      label: '复制即读',
      note: clipboardAuto
        ? '已开启：复制文字后自动朗读。可在 设置 → 系统 里关闭。'
        : '已关闭：可在 设置 → 系统 里打开。',
    },
  ];

  const toggle = useCallback(() => {
    const next = !open;
    setOpen(next);
    announcer.cue('press');
    announcer.say(
      next ? 'shortcutGuideOpen' : 'shortcutGuideClose',
      next ? `快捷键速查已展开，共 ${rows.length} 条` : '快捷键速查已收起'
    );
  }, [open, rows.length]);

  return (
    <Box
      component="section"
      aria-label="快捷键速查"
      sx={{
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        flexShrink: 0,
      }}
    >
      {/* 收起态就是这一行；整行可点，命中区域 ≥44px */}
      <ButtonBase
        onClick={toggle}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        aria-label={open ? '收起快捷键速查' : `展开快捷键速查，共 ${rows.length} 条`}
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          textAlign: 'left',
          gap: 1,
          px: { xs: 1.25, md: 1.5 },
          py: { xs: 1, md: 1.25 },
          borderRadius: 3,
        }}
      >
        <KeyboardIcon aria-hidden sx={{ fontSize: fs(20), color: 'text.secondary', flexShrink: 0 }} />
        <Typography sx={{ fontSize: fs(15), fontWeight: 700 }}>快捷键速查</Typography>
        <Chip
          size="small"
          variant="outlined"
          label={`${rows.length} 条`}
          sx={{ height: su(24), fontWeight: 600, flexShrink: 0 }}
        />
        <Box sx={{ flex: 1 }} />
        {open ? (
          <ExpandLessIcon aria-hidden sx={{ fontSize: fs(22), color: 'text.secondary' }} />
        ) : (
          <ExpandMoreIcon aria-hidden sx={{ fontSize: fs(22), color: 'text.secondary' }} />
        )}
      </ButtonBase>

      {open && (
        <Box
          id={PANEL_ID}
          sx={{
            px: { xs: 1.25, md: 1.5 },
            pb: { xs: 1.25, md: 1.5 },
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Box
            component="table"
            sx={{
              width: '100%',
              borderCollapse: 'collapse',
              '& th, & td': {
                textAlign: 'left',
                verticalAlign: 'top',
                py: su(9),
                px: su(6),
                borderTop: '1px solid',
                borderTopColor: 'divider',
                wordBreak: 'break-word',
              },
              '& thead th': {
                fontSize: fs(12.5),
                fontWeight: 600,
                color: 'text.secondary',
                borderTop: 'none',
                pt: su(10),
                pb: su(4),
              },
              '& tbody tr:first-of-type th, & tbody tr:first-of-type td': { borderTop: 'none' },
              // 热键列按内容定宽并强制单行：一列 3~4 枚 kbd 竖着排会读串行，
              // 也不符合「一眼看到组合键」的目标。2.0x 下最长组合键仍 < 450px，不会挤出表格。
              '& th[scope="row"]': { width: '1%', whiteSpace: 'nowrap', pr: su(10) },
            }}
          >
            <Box component="thead">
              <Box component="tr">
                <Box component="th" scope="col" sx={{ width: '1%' }}>
                  热键
                </Box>
                <Box component="th" scope="col">
                  作用
                </Box>
              </Box>
            </Box>
            <Box component="tbody">
              {rows.map((r) => (
                <Box component="tr" key={r.id}>
                  <Box component="th" scope="row">
                    <KeyCombo keys={r.keys} />
                  </Box>
                  <Box component="td">
                    <Typography
                      component="div"
                      sx={{ fontSize: fs(14), fontWeight: r.strong ? 700 : 600, lineHeight: 1.6 }}
                    >
                      {r.label}
                    </Typography>
                    {r.note && (
                      <Typography
                        component="div"
                        sx={{ fontSize: fs(13), color: 'text.secondary', lineHeight: 1.6, mt: 0.25 }}
                      >
                        {r.note}
                      </Typography>
                    )}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}
