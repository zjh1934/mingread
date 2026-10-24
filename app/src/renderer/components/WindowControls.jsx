// W-WIN1：无边框窗口的三个控制键（最小化 / 最大化-还原 / 关闭）。
//
// 为什么自绘：Windows 原生标题栏的三个键尺寸由系统 DPI 决定，Electron 没有 API 能放大它们
// （用户明确要求"放大一些"）。frame:false 之后必须自绘，且并入 TopBar 右端——全窗口只有
// 一条顶栏，这才是「与 UI 融为一体」。
//
// 无障碍：
//   · 每个键 44×44（WCAG 2.5.5 / 项目目标尺寸基线），随字号档位用 su(44) 一起放大；
//   · Tab 可聚焦、:focus-visible 走全局 3px 焦点环（index.css/theme 的 *:focus-visible）；
//   · aria-label 随最大化状态切换（最大化 / 还原），读屏能念对当前动作；
//   · 关闭键 hover 用 error.main 底 + 白图标（Windows 惯例，位置稳定不跳）。
//
// 状态同步：最大化不能只认点击时的本地状态——用户可能用 Win+↑、双击拖拽区或 Aero Snap。
// 因此挂载时问一次 isWindowMaximized()，之后只认主进程 maximize/unmaximize 推送。
import React, { useCallback, useEffect, useState } from 'react';
import { Box, ButtonBase } from '@mui/material';
import { Remove, CropSquare, FilterNone, Close } from '@mui/icons-material';
import { fs, su } from '../theme';

const bridge = () => {
  try {
    return typeof window !== 'undefined' ? window.langdu : null;
  } catch (e) {
    return null;
  }
};

function ControlButton({ label, onClick, danger, children }) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label={label}
      title={label}
      // 拖拽区里的一切可交互元素必须 no-drag，否则点击会被窗口拖动吞掉
      sx={{
        WebkitAppRegion: 'no-drag',
        // 用户诉求是「控制键放大一些」。两个维度一起放大才有量感：
        //   ① 高度撑满顶栏（64px），而不是 44px 浮在中间——点击热区从 1936px² 涨到 2944px²；
        //   ② 图标 20 → 24px（fs 保证随字号档位继续放大）。
        // maxWidth 挡住 2.0x 档的过度膨胀：su(46)×2=92px 会让三个键吃掉 276px 顶栏，
        // 把「本地语音」徽标挤走；72px 已足够大，且不影响 44px 无障碍目标尺寸。
        width: su(46),
        maxWidth: 72,
        height: '100%',
        minWidth: su(44),
        borderRadius: 0,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        color: 'text.secondary',
        transition: 'background-color 120ms ease, color 120ms ease',
        '&:hover': danger
          ? { bgcolor: 'error.main', color: '#ffffff' }
          : { bgcolor: 'action.hover', color: 'text.primary' },
        '&:active': { opacity: 0.85 },
      }}
    >
      {children}
    </ButtonBase>
  );
}

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const api = bridge();
    if (!api) return undefined;
    let alive = true;
    if (typeof api.isWindowMaximized === 'function') {
      api
        .isWindowMaximized()
        .then((v) => {
          if (alive) setMaximized(!!v);
        })
        .catch(() => {});
    }
    const unsubscribe =
      typeof api.onWindowMaximizedChanged === 'function'
        ? api.onWindowMaximizedChanged((v) => {
            if (alive) setMaximized(!!v);
          })
        : null;
    return () => {
      alive = false;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const minimize = useCallback(() => {
    const api = bridge();
    if (api && typeof api.minimizeWindow === 'function') api.minimizeWindow();
  }, []);

  const toggleMaximize = useCallback(() => {
    const api = bridge();
    if (api && typeof api.toggleMaximizeWindow === 'function') api.toggleMaximizeWindow();
  }, []);

  const close = useCallback(() => {
    const api = bridge();
    if (api && typeof api.closeWindow === 'function') api.closeWindow();
  }, []);

  return (
    <Box
      sx={{
        WebkitAppRegion: 'no-drag',
        display: 'flex',
        alignItems: 'center',
        alignSelf: 'stretch',
        flexShrink: 0,
      }}
    >
      <ControlButton label="最小化" onClick={minimize}>
        <Remove sx={{ fontSize: fs(24) }} />
      </ControlButton>
      <ControlButton label={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
        {maximized ? <FilterNone sx={{ fontSize: fs(19) }} /> : <CropSquare sx={{ fontSize: fs(21) }} />}
      </ControlButton>
      <ControlButton label="关闭" onClick={close} danger>
        <Close sx={{ fontSize: fs(24) }} />
      </ControlButton>
    </Box>
  );
}
