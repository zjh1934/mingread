// 首屏第 6 块：辅助入口（系统鼠标指针大小）+ 联系作者（微信二维码）
//
// 为什么这两件事放在一起：
//   · 都是「主流程之外、但低视力用户真会遇到」的事——找不到鼠标指针、想反馈问题；
//   · 都不该抢 HeroStatus 的注意力，所以统一收在页面最下方一张卡片里。
//
// 指针部分的设计取舍（重要）：
//   程序**不直接改**系统指针大小，而是打开系统那个能实时预览的调节页。
//   理由：低视力用户真正的困难是「找不到设置在哪」，不是「改不了值」；
//   把用户送到系统 UI，他能自己看到预览、自己微调，也不会疑惑「谁改了我的设置」。
//
// 无障碍：
//   · 二维码是图形，不跟字号缩放（固定 112px）——它要被手机扫，不是被读；
//   · 按钮 ≥44px，状态变化 announcer 播报，图片有准确 alt；
//   · 两栏用 flexWrap，2.0x 档位自动堆叠，不产生横向滚动。
import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import MouseIcon from '@mui/icons-material/Mouse';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import announcer from '../services/announcer';
import { fs, su } from '../theme';
import qrImg from '../assets/wechat-qr.png';

/** 桥接名兼容：新代码用 window.mingread，老 preload 只有 window.langdu */
function bridge() {
  return window.mingread || window.langdu || {};
}

export default function SupportCard() {
  const [cursor, setCursor] = useState(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let alive = true;
    const api = bridge();
    if (!api.cursorSize || typeof api.cursorSize.get !== 'function') return undefined;
    api.cursorSize
      .get()
      .then((st) => {
        if (alive) setCursor(st);
      })
      .catch(() => {
        /* 读不到就不显示当前档位，按钮仍可用 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const openCursorSettings = useCallback(async () => {
    announcer.cue('press');
    const api = bridge();
    if (!api.cursorSize || typeof api.cursorSize.openSettings !== 'function') {
      announcer.say('cursorSettingsFail', '这个版本还不支持一键打开指针设置');
      return;
    }
    setOpening(true);
    try {
      const r = await api.cursorSize.openSettings();
      if (r && r.ok) {
        announcer.say('cursorSettingsOpen', r.message || '已打开系统设置');
      } else {
        announcer.say('cursorSettingsFail', (r && r.message) || '没能打开系统设置');
      }
    } catch (e) {
      announcer.say('cursorSettingsFail', '没能打开系统设置');
    } finally {
      setOpening(false);
    }
  }, []);

  const cursorLine = cursor
    ? cursor.supported
      ? `当前指针大小：${cursor.label}。${cursor.hint}`
      : `当前系统读不到指针大小。${cursor.hint}`
    : '打开系统设置，把指针调大，所有程序都会跟着变大。';

  return (
    <Box
      component="section"
      aria-label="辅助与联系"
      sx={{
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        px: { xs: 1.5, md: 2 },
        py: { xs: 1.5, md: 1.75 },
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'flex-start',
        columnGap: { xs: 0, md: 3 },
        rowGap: 2,
        flexShrink: 0,
      }}
    >
      {/* ---- 左：鼠标指针设置入口 ---- */}
      <Box sx={{ flex: `1 1 ${su(300)}`, minWidth: 0 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <MouseIcon aria-hidden sx={{ fontSize: fs(20), color: 'primary.main', flexShrink: 0 }} />
          <Typography sx={{ fontSize: fs(15), fontWeight: 700 }}>找不到鼠标指针？</Typography>
        </Stack>
        <Typography
          sx={{
            fontSize: fs(13.5),
            color: 'text.secondary',
            lineHeight: 1.7,
            mt: 0.75,
            wordBreak: 'break-word',
          }}
        >
          {cursorLine}
        </Typography>
        <Button
          variant="outlined"
          onClick={openCursorSettings}
          disabled={opening}
          startIcon={<OpenInNewIcon sx={{ fontSize: fs(18) }} />}
          aria-label="打开系统设置里的鼠标指针大小页面"
          sx={{ mt: 1.25, minHeight: su(44), fontSize: fs(14), fontWeight: 600 }}
        >
          {opening ? '正在打开…' : '打开指针大小设置'}
        </Button>
      </Box>

      {/* ---- 右：微信二维码 ---- */}
      <Box
        sx={{
          // basis 用 su() 跟随字号档位：1.0x 时两栏并排；
          // 2.0x 时两栏各 600px、总宽超容器 → flexWrap 自动换行，各自占满一行。
          // 若写死 300px，2.0x 下右栏会被左栏挤压成一条竖线（实测踩过）。
          flex: `1 1 ${su(300)}`,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          columnGap: 1.5,
          // 与左栏在视觉上分隔：窄屏时用上边框，宽屏时不加（靠列间距）
          borderTop: { xs: '1px solid', md: 'none' },
          borderColor: 'divider',
          pt: { xs: 1.75, md: 0 },
        }}
      >
        <Box
          component="img"
          src={qrImg}
          alt="微信二维码：扫码添加「明读」作者为好友，可直接反馈问题或提需求"
          // 图形不跟字号缩放：它要被手机扫，尺寸固定更稳，也避免 2.0x 下占掉半屏
          sx={{
            // 128px：比常见的 112px 再大一点，手机对焦更省力。
            // 源图裁切时已留 6% 白边，这里不再加内边距，否则白边过厚显得脏。
            width: 128,
            flexShrink: 0,
            display: 'block',
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: '#fff',
          }}
        />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: fs(15), fontWeight: 700 }}>扫码加我微信</Typography>
          <Typography
            sx={{ fontSize: fs(13), color: 'text.secondary', lineHeight: 1.7, mt: 0.5, wordBreak: 'break-word' }}
          >
            用微信扫一扫。遇到问题、想加功能，直接跟我说。
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
