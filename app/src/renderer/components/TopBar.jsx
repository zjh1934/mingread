import React, { useCallback } from 'react';
import { AppBar, Toolbar, Typography, Stack, Box, ButtonBase, IconButton, Tooltip, Divider, CircularProgress } from '@mui/material';
import { Settings as SettingsIcon, DarkMode, LightMode, Contrast } from '@mui/icons-material';
// α-视觉增强：px → rem，字号随档位缩放（禁止再写死 fontSize: 13 这类数字）
import { fs, su } from '../theme';
import announcer from '../services/announcer';
import WindowControls from './WindowControls';
import BrandMark from './BrandMark';

// W-WIN1：窗口是无边框的（frame:false），整条 TopBar 就是标题栏。
// 所以根容器是拖拽区（drag），里面每个可交互元素必须 no-drag，否则点击会被拖动吞掉。
const NO_DRAG = { WebkitAppRegion: 'no-drag' };

// 状态灯：实心圆点=可用，空心圆环=不可用（形状冗余，色弱可辨）；点击重试
// v2.4.0：本地引擎就绪时不能再叫「在线」——那时根本没有联网。按 engine.online 区分：
//   本地（sapi）→「本地语音」；在线（edge）→「在线」；未就绪 →「声音不可用」。
function StatusDot({ status, refreshing, onRefresh }) {
  const engine = (status && status.engine) || {};
  const ready = engine.ready !== false;
  const isLocal = ready && engine.online === false;
  const label = !ready ? '声音不可用' : isLocal ? '本地语音' : '在线';
  const tip = !ready
    ? '当前没有可用语音，点击重新检测'
    : isLocal
      ? '本地语音已就绪（不联网、延迟最低），点击重新检测'
      : '在线语音可用，点击重新检测';

  return (
    <Tooltip title={tip}>
      <ButtonBase
        onClick={onRefresh}
        disabled={refreshing}
        sx={{
          px: 1.25,
          py: 0.6,
          borderRadius: 99,
          gap: 0.75,
          border: '1px solid',
          borderColor: 'divider',
          ...NO_DRAG,
          '&:hover': { borderColor: ready ? 'success.main' : 'error.main' },
        }}
      >
        {refreshing ? (
          <CircularProgress size={10} />
        ) : (
          <Box
            sx={{
              // 注意：index.css 在 1.5x/2.0x 档对 .MuiBox-root 强制 height:auto!important，
              // 空 div 的高度会塌缩成 0（状态灯变细线）。用 aspect-ratio 从宽度派生高度绕过。
              width: su(12),
              aspectRatio: '1',
              borderRadius: '50%',
              flexShrink: 0,
              // 形状冗余编码（色弱/灰度可辨）：可用=实心圆点，不可用=空心圆环
              ...(ready
                ? { bgcolor: 'success.main', boxShadow: '0 0 0 3px rgba(74,222,128,0.16)' }
                : {
                    bgcolor: 'transparent',
                    border: `${su(2.5)} solid`,
                    borderColor: 'error.main',
                  }),
            }}
          />
        )}
        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: fs(13), whiteSpace: 'nowrap' }}>
          {label}
        </Typography>
      </ButtonBase>
    </Tooltip>
  );
}

// 主题循环：浅色 → 深色 → 高对比度（低视力刚需，一键可达）
const THEME_CYCLE = ['light', 'dark', 'hc'];
const THEME_LABEL = { light: '浅色', dark: '深色', hc: '高对比度' };
const THEME_NEXT_LABEL = { light: '切换深色主题', dark: '切换高对比度主题', hc: '切换浅色主题' };

function ThemeToggleIcon({ mode }) {
  if (mode === 'dark') return <LightMode sx={{ fontSize: fs(20) }} />;
  if (mode === 'hc') return <Contrast sx={{ fontSize: fs(20) }} />;
  return <DarkMode sx={{ fontSize: fs(20) }} />;
}

export default function TopBar({ status, themeMode, refreshing, onToggleTheme, onRefresh, onOpenSettings }) {
  const nextMode = THEME_CYCLE[(THEME_CYCLE.indexOf(themeMode) + 1) % THEME_CYCLE.length];

  const toggleTheme = () => {
    onToggleTheme(nextMode);
    announcer.cue('press');
    // announcer 预置文案只区分深/浅，高对比度用自定义短句（β 的 API，不改其文件）
    if (nextMode === 'hc') announcer.say('themeChangedHc', '已切换到高对比度主题');
    else announcer.announce('themeChanged', { themeMode: nextMode });
  };

  // 双击拖拽区最大化/还原：frame:false 的窗口不会自动处理双击标题栏，必须自己接。
  // 点在按钮/状态灯上不触发（那些位置有明确动作，双击不该顺带改窗口状态）。
  const handleBarDoubleClick = useCallback((e) => {
    const t = e && e.target;
    if (t && typeof t.closest === 'function' && t.closest('button,a,input,[role="button"]')) return;
    try {
      const api = window.langdu;
      if (api && typeof api.toggleMaximizeWindow === 'function') api.toggleMaximizeWindow();
    } catch (err) {
      /* 无桥（纯浏览器调试）时忽略 */
    }
  }, []);

  return (
    <AppBar
      position="static"
      elevation={0}
      color="transparent"
      onDoubleClick={handleBarDoubleClick}
      sx={{
        // 整条顶栏 = 标题栏。用户诉求「最上面一层颜色要和 UI 融为一体」：
        // 底色从 background.paper（比内容区亮一档）改为 background.default，**与内容区完全同色**，
        // 并去掉 1px borderBottom —— 顶栏不再是「另一层」，而是页面的一部分（Win11 同色标题栏的做法）。
        // 三个控制键靠自身的 hover 底色和左侧 divider 区分，不需要整条栏的色差来框定。
        bgcolor: 'background.default',
        flexShrink: 0,
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      <Toolbar
        disableGutters
        sx={{
          gap: 1.5,
          minHeight: { xs: 56, md: 64 },
          pl: { xs: 1.5, md: 2.5 },
          pr: 0, // 控制键贴到窗口右边缘（Windows 惯例），顶栏本身留白由左内边距承担
        }}
      >
        {/* 品牌标记：与应用图标同一套图形（原先是渐变方块 + GraphicEq，用户评价「像鲁大师」） */}
        <BrandMark size={38} />

        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" noWrap component="h1">
            明读
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: { xs: 'none', sm: 'block' } }}
          >
            {/* v2.4.0：副标题不再重复「按 F1 即读」与音色（首屏状态卡已讲清楚），
                这里只留产品定位，避免同一信息在首屏出现三次 */}
            无障碍朗读工具
          </Typography>
        </Box>

        <Box sx={{ flex: 1 }} />

        <StatusDot status={status} refreshing={refreshing} onRefresh={onRefresh} />
        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />

        <Tooltip title={`${THEME_NEXT_LABEL[themeMode] || '切换主题'}（当前：${THEME_LABEL[themeMode] || themeMode}）`}>
          <IconButton
            onClick={toggleTheme}
            aria-label={`切换主题，当前${THEME_LABEL[themeMode] || themeMode}`}
            sx={NO_DRAG}
          >
            <ThemeToggleIcon mode={themeMode} />
          </IconButton>
        </Tooltip>
        <Tooltip title="设置">
          <IconButton onClick={onOpenSettings} aria-label="设置" sx={NO_DRAG}>
            <SettingsIcon sx={{ fontSize: fs(20) }} />
          </IconButton>
        </Tooltip>

        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
        <WindowControls />
      </Toolbar>
    </AppBar>
  );
}
