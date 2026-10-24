import React from 'react';
import { AppBar, Toolbar, Typography, Stack, Box, ButtonBase, IconButton, Tooltip, Divider, CircularProgress } from '@mui/material';
import { GraphicEq, Settings as SettingsIcon, DarkMode, LightMode, Contrast } from '@mui/icons-material';
// α-视觉增强：px → rem，字号随档位缩放（禁止再写死 fontSize: 13 这类数字）
import { fs, su } from '../theme';
import announcer from '../services/announcer';

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

  return (
    <AppBar
      position="static"
      elevation={0}
      color="transparent"
      sx={{ bgcolor: 'background.paper', borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}
    >
      <Toolbar sx={{ gap: 1.5, minHeight: { xs: 56, md: 64 }, px: { xs: 1.5, md: 2.5 } }}>
        <Box
          sx={{
            // 同上：2.0x 档 height 会被 index.css 的 !important 规则抹掉，用 aspect-ratio 保正方形
            width: su(38),
            aspectRatio: '1',
            borderRadius: '12px',
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            flexShrink: 0,
            background: (t) =>
              `linear-gradient(135deg, ${t.palette.primary.main}, ${t.palette.secondary.main})`,
            boxShadow: '0 6px 16px rgba(107,91,255,0.28)',
          }}
        >
          <GraphicEq sx={{ fontSize: fs(18) }} />
        </Box>

        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" noWrap component="h1">
            朗读女 Neo
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: { xs: 'none', sm: 'block' } }}
          >
            {/* v2.4.0：副标题不再重复「按 F1 即读」与音色（首屏状态卡已讲清楚），
                这里只留产品定位，避免同一信息在首屏出现三次 */}
            低视力无障碍朗读工具
          </Typography>
        </Box>

        <Box sx={{ flex: 1 }} />

        <StatusDot status={status} refreshing={refreshing} onRefresh={onRefresh} />
        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />

        <Tooltip title={`${THEME_NEXT_LABEL[themeMode] || '切换主题'}（当前：${THEME_LABEL[themeMode] || themeMode}）`}>
          <IconButton onClick={toggleTheme} aria-label={`切换主题，当前${THEME_LABEL[themeMode] || themeMode}`}>
            <ThemeToggleIcon mode={themeMode} />
          </IconButton>
        </Tooltip>
        <Tooltip title="设置">
          <IconButton onClick={onOpenSettings} aria-label="设置">
            <SettingsIcon sx={{ fontSize: fs(20) }} />
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
