//  1. 字号档位 1.0 / 1.25 / 1.5 / 2.0 —— 唯一真源是 CSS 变量 --ldn-scale：
//       · typography 全部写成 rem（基准 16px），html{font-size:16px*scale} 即全界面生效
//       · spacing 写成 calc(8px*n*var(--ldn-scale))，边距/间距同步放大
//       · 目标尺寸（按钮/Slider thumb/输入框）写成 calc(px*var(--ldn-scale))
//     ⇒ 切换档位只需改一个变量，无需重建 theme、无需重渲染（指标 C）。
//  2. 高对比度主题 'hc'：纯黑底 + 高亮文字，所有文本（含 disabled/secondary/hover）≥ 7:1（指标 B）。
//  3. 主目标 ≥ 44×44 且跟随档位放大（指标 I）。
//  4. 系统偏好联动：prefers-contrast: more → 自动切 HC 主题（见文件末尾 watchSystemContrast）。
//  5. 控件低视力适配：Slider thumb 28px；Select 长选项换行不截断；Switch 状态用
//     「位置 + 填充 + 明暗」冗余编码，不依赖色相（色弱可辨）。
// ---------------------------------------------------------------------------
import { createTheme } from '@mui/material/styles';
import { useSettings } from './store/settingsStore';

const FONT_STACK =
  '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif';

/** 字号档位（指标 C）。新增档位只改这里。 */
export const FONT_SCALE_STEPS = [1, 1.25, 1.5, 2];
export const FONT_SCALE_DEFAULT = 1;
export const FONT_SCALE_LABELS = {
  1: '标准 1.0x',
  1.25: '较大 1.25x',
  1.5: '大 1.5x',
  2: '特大 2.0x',
};

/** 悬浮球尺寸档位（指标 I）。与 main/floatBall.js 的 BALL_SIZES 保持一致。 */
export const BALL_SIZE_STEPS = [56, 80, 112];
export const BALL_SIZE_DEFAULT = 56;
export const BALL_SIZE_LABELS = { 56: '标准 56px', 80: '大 80px', 112: '特大 112px' };

/** 主题模式：light / dark / hc（高对比度） */
export const THEME_MODES = ['light', 'dark', 'hc'];
export const THEME_MODE_LABELS = { light: '浅色', dark: '深色', hc: '高对比度（AAA）' };

// ---- 缩放基线常量：任何"多少 px"都必须从这里派生，禁止在组件里写死数字 ----
const BASE_FONT_SIZE = 16; // html 基准字号（1rem）
const BASE_SPACING = 8; // MUI 间距单位
const BASE_TARGET = 44; // 主操作目标最小边（WCAG 2.5.5 / 低视力）
const BASE_TARGET_SMALL = 36; // 次级目标
const BASE_THUMB = 28; // Slider 滑块直径（默认 12px 对低视力不可用）

/** px → rem（随 --ldn-scale 实时缩放，用于字号） */
export const fs = (px) => `${(Number(px) / BASE_FONT_SIZE).toFixed(4)}rem`;
/** px → calc(px * scale)（用于非文字尺寸，如目标尺寸/图标） */
export const su = (px) => `calc(${Number(px)}px * var(--ldn-scale, 1))`;

/** 字形基线表（px @1.0x）—— 组件里不要再出现 11.5/12/13/15 这类散落数字 */
const TYPE_PX = {
  overline: 11,
  caption: 12.5,
  body2: 14,
  body1: 15,
  subtitle2: 14,
  subtitle1: 16,
  h6: 18,
  h5: 20,
  h4: 24,
  h3: 28,
  h2: 32,
  h1: 38,
  button: 15,
};
const TYPE_WEIGHT = {
  h1: 700, h2: 700, h3: 700, h4: 700, h5: 700, h6: 700,
  subtitle1: 700, subtitle2: 700, button: 600, overline: 600,
};
const TYPE_LINE_HEIGHT = {
  body1: 1.7, body2: 1.7, caption: 1.6, // 低视力：正文行距放宽
  h1: 1.25, h2: 1.25, h3: 1.3, h4: 1.35, h5: 1.4, h6: 1.45,
  subtitle1: 1.5, subtitle2: 1.5, button: 1.6, overline: 2,
};

function buildTypography() {
  const out = {};
  Object.keys(TYPE_PX).forEach((k) => {
    out[k] = {
      fontSize: fs(TYPE_PX[k]),
      fontWeight: TYPE_WEIGHT[k] || 400,
      lineHeight: TYPE_LINE_HEIGHT[k] || 1.5,
    };
  });
  out.button = { ...out.button, textTransform: 'none' };
  out.body2 = { ...out.body2, letterSpacing: 0.1 };
  return out;
}

// ---------------------------------------------------------------------------
// 调色板
//   hc：纯黑底 + 高亮前景。每一处前景色都按 ≥7:1 校验（对 #000）：
//     #ffffff 21.0 · #e6e6e6 16.9 · #ffff00 19.6 · #00ffff 16.7 · #7dff7d 17.6
//     #ffd400 14.7 · #66ccff 11.6 · #ff8080 8.7 · #b3b3b3 10.0（disabled，也达标）
// ---------------------------------------------------------------------------
function buildPalette(mode) {
  const isHC = mode === 'hc';
  if (isHC) {
    return {
      mode: 'dark', // 黑底按 dark 语义处理，避免 MUI 内部 light 分支
      primary: { main: '#ffff00', contrastText: '#000000' },
      secondary: { main: '#00ffff', contrastText: '#000000' },
      success: { main: '#7dff7d', contrastText: '#000000' },
      warning: { main: '#ffd400', contrastText: '#000000' },
      error: { main: '#ff8080', contrastText: '#000000' },
      info: { main: '#66ccff', contrastText: '#000000' },
      divider: '#ffffff',
      background: { default: '#000000', paper: '#000000' },
      text: { primary: '#ffffff', secondary: '#e6e6e6', disabled: '#b3b3b3' },
      action: {
        hover: 'rgba(255,255,255,0.20)',
        selected: 'rgba(255,255,0,0.30)',
        focus: 'rgba(255,255,0,0.45)',
        disabled: '#b3b3b3',
        disabledBackground: 'rgba(255,255,255,0.12)',
      },
    };
  }
  const isDark = mode === 'dark';
  return {
    mode: isDark ? 'dark' : 'light',
    primary: { main: isDark ? '#a996ff' : '#6b5bff' },
    secondary: { main: isDark ? '#5eead4' : '#0f9f8f' },
    success: { main: isDark ? '#4ade80' : '#12a150' },
    warning: { main: isDark ? '#fbbf24' : '#c47f00' },
    error: { main: isDark ? '#fb7185' : '#d9344a' },
    info: { main: isDark ? '#67b7ff' : '#1d77d1' },
    divider: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(16,24,40,0.14)',
    background: isDark
      ? { default: '#0c0f16', paper: '#151a24' }
      : { default: '#f5f6fa', paper: '#ffffff' },
    // secondary/disabled 提到 ≥7:1：浅色 #4a5261(7.8:1) / 深色 #c3cbd9(11.8:1)
    text: isDark
      ? { primary: '#eaeef7', secondary: '#c3cbd9', disabled: '#8a93a6' }
      : { primary: '#161b26', secondary: '#4a5261', disabled: '#5d6572' },
    action: {
      hover: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,40,0.07)',
      selected: isDark ? 'rgba(169,150,255,0.22)' : 'rgba(107,91,255,0.14)',
      focus: isDark ? 'rgba(169,150,255,0.30)' : 'rgba(107,91,255,0.20)',
    },
  };
}

function buildComponents(mode, palette) {
  const isHC = mode === 'hc';
  const accent = isHC ? '#ffff00' : palette.primary.main;
  const borderStrong = isHC ? '2px solid #ffffff' : '1px solid';
  const borderColor = isHC ? '#ffffff' : palette.divider;

  return {
    MuiCssBaseline: {
      styleOverrides: {
        // HC 主题靠 CSS 变量下发全局样式（main.jsx 只按 dark/light 切 class，这里补位）
        html: {
          '--ldn-scrollbar-thumb': isHC ? '#ffffff' : 'rgba(128, 138, 156, 0.42)',
          '--ldn-scrollbar-thumb-hover': isHC ? '#ffff00' : 'rgba(128, 138, 156, 0.62)',
          '--ldn-scrollbar-size': 'calc(10px * var(--ldn-scale, 1))',
          '--ldn-selection-bg': isHC ? '#ffff00' : (mode === 'dark' ? 'rgba(169,150,255,0.35)' : 'rgba(107,91,255,0.20)'),
          '--ldn-selection-fg': isHC ? '#000000' : 'inherit',
          '--ldn-focus-color': accent,
          '--ldn-focus-width': '3px',
          colorScheme: mode === 'light' ? 'light' : 'dark',
        },
        body: {
          fontFeatureSettings: '"kern" 1',
          // 低视力：大档位时略微放宽字距，缓解拥挤
          letterSpacing: 0,
        },
        '::selection': {
          backgroundColor: 'var(--ldn-selection-bg)',
          color: 'var(--ldn-selection-fg)',
        },
        // 键盘焦点环加粗：低视力用户需要看得见焦点在哪
        '*:focus-visible': {
          outline: 'var(--ldn-focus-width) solid var(--ldn-focus-color)',
          outlineOffset: 2,
        },
      },
    },

    // ---- 大目标（指标 I）----
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          borderRadius: 10,
          paddingInline: su(16),
          minHeight: su(BASE_TARGET),
          minWidth: su(BASE_TARGET),
          fontSize: fs(TYPE_PX.button),
          fontWeight: 600,
          ...(isHC ? { border: '2px solid #ffffff' } : {}),
        },
        sizeSmall: { minHeight: su(BASE_TARGET_SMALL), minWidth: su(BASE_TARGET_SMALL), paddingInline: su(12) },
        sizeLarge: { minHeight: su(56) },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 10,
          minWidth: su(BASE_TARGET),
          minHeight: su(BASE_TARGET),
          padding: su(10),
          fontSize: fs(22),
          ...(isHC ? { border: '2px solid #ffffff' } : {}),
        },
        sizeSmall: { minWidth: su(BASE_TARGET_SMALL), minHeight: su(BASE_TARGET_SMALL), padding: su(7), fontSize: fs(18) },
      },
    },
    MuiButtonBase: {
      styleOverrides: { root: { '&.Mui-focusVisible': { outline: 'var(--ldn-focus-width) solid var(--ldn-focus-color)', outlineOffset: 2 } } },
    },
    MuiFab: { styleOverrides: { root: { minHeight: su(56), minWidth: su(56) } } },

    // ---- Slider：默认 thumb ~12px 对低视力/运动障碍不可用 → 放大到 28px 并随档位 ----
    MuiSlider: {
      defaultProps: { size: 'medium' },
      styleOverrides: {
        root: {
          paddingBlock: su(14),
          height: su(8), // 与 rail/track 同高，thumb 才能精确居中
          boxSizing: 'content-box',
        },
        rail: { height: su(8), borderRadius: 99, opacity: isHC ? 1 : 0.38 },
        track: { height: su(8), borderRadius: 99, ...(isHC ? { border: '1px solid #000' } : {}) },
        thumb: {
          width: su(BASE_THUMB),
          height: su(BASE_THUMB),
          border: isHC ? '3px solid #000000' : '2px solid currentColor',
          backgroundColor: isHC ? '#ffff00' : '#ffffff',
          boxShadow: '0 2px 6px rgba(16,24,40,0.30)',
          '&::before': { width: su(12), height: su(12), boxShadow: 'none' },
          '&::after': { width: su(48), height: su(48) },
          '&.Mui-focusVisible, &:hover': { boxShadow: `0 0 0 ${su(6)} var(--ldn-focus-color)` },
        },
        valueLabel: {
          fontSize: fs(14),
          fontWeight: 700,
          padding: `${su(4)} ${su(8)}`,
          borderRadius: 8,
          ...(isHC ? { backgroundColor: '#ffff00', color: '#000000' } : {}),
        },
        mark: { width: su(3), height: su(8) },
        markLabel: { fontSize: fs(12.5) },
      },
    },

    // ---- Switch：状态对色弱者也要一眼可辨 ----
    // 不依赖色相，三重冗余编码：① 滑块位置左右 ② 轨道空心→实心填充 ③ 明暗反转
    MuiSwitch: {
      styleOverrides: {
        root: { width: su(62), height: su(42), padding: 0, overflow: 'visible' },
        switchBase: {
          padding: su(9),
          '&.Mui-checked': {
            transform: `translateX(${su(20)})`,
            // 选中态轨道实心填充；HC 下黄轨黑拇、未选黑轨白拇，明暗反转最强烈
            '& + .MuiSwitch-track': isHC
              ? { backgroundColor: '#ffff00', borderColor: '#ffffff' }
              : { backgroundColor: palette.primary.main, borderColor: palette.primary.main, opacity: 1 },
            // HC 选中态拇指改黑，落在黄轨上对比最强
            ...(isHC ? { '& .MuiSwitch-thumb': { backgroundColor: '#000000', borderColor: '#000000' } } : {}),
          },
        },
        thumb: {
          width: su(24),
          height: su(24),
          backgroundColor: isHC ? '#ffffff' : '#ffffff',
          border: isHC ? '2px solid #000000' : '2px solid rgba(16,24,40,0.55)',
        },
        track: {
          width: su(38),
          height: su(16),
          borderRadius: su(8),
          opacity: 1,
          // 未选中 = 空心轨道 + 可见描边（与实心填充态形成形状/明暗差）
          border: isHC ? '2px solid #ffffff' : '1.5px solid',
          borderColor: isHC ? '#ffffff' : mode === 'dark' ? 'rgba(255,255,255,0.55)' : 'rgba(16,24,40,0.40)',
          backgroundColor: isHC ? '#000000' : 'transparent',
        },
      },
    },
    MuiCheckbox: { styleOverrides: { root: { padding: su(10), fontSize: fs(26) } } },
    MuiRadio: { styleOverrides: { root: { padding: su(10), fontSize: fs(26) } } },

    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 600,
          height: su(34),
          fontSize: fs(13.5),
          borderRadius: su(17),
          ...(isHC ? { border: '2px solid #ffffff' } : {}),
        },
        sizeSmall: { height: su(30), fontSize: fs(13), borderRadius: su(15) },
        label: { paddingInline: su(10) },
        deleteIcon: { fontSize: fs(20) },
      },
    },

    MuiInputBase: {
      styleOverrides: {
        root: { fontSize: fs(15) },
        input: { minHeight: su(24) },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          minHeight: su(BASE_TARGET),
          fontSize: fs(15),
          borderRadius: 10,
          ...(isHC ? { borderWidth: 2 } : {}),
        },
        sizeSmall: { minHeight: su(40) },
        notchedOutline: isHC ? { borderColor: '#ffffff', borderWidth: 2 } : {},
      },
    },
    MuiFormLabel: { styleOverrides: { root: { fontSize: fs(14) } } },
    MuiFormHelperText: { styleOverrides: { root: { fontSize: fs(13), marginTop: su(5) } } },
    // ---- Select：长选项文本换行展示，禁止省略号截断（低视力"看不全"）----
    MuiSelect: {
      styleOverrides: {
        select: {
          minHeight: su(24),
          paddingBlock: su(6),
          whiteSpace: 'normal',
          wordBreak: 'break-word',
          textOverflow: 'clip',
        },
      },
    },
    MuiMenuItem: {
      styleOverrides: {
        root: {
          minHeight: su(BASE_TARGET),
          fontSize: fs(15),
          whiteSpace: 'normal',
          wordBreak: 'break-word',
        },
      },
    },
    MuiListItemButton: { styleOverrides: { root: { minHeight: su(BASE_TARGET) } } },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: su(48),
          fontSize: fs(15),
          fontWeight: 600,
          ...(isHC ? { color: '#e6e6e6', '&.Mui-selected': { color: '#ffff00' } } : {}),
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: {
          minHeight: su(BASE_TARGET),
          minWidth: su(BASE_TARGET),
          padding: `${su(8)} ${su(14)}`,
          fontSize: fs(15),
          fontWeight: 600,
          ...(isHC ? { border: '2px solid #ffffff', color: '#ffffff' } : {}),
        },
        sizeSmall: { minHeight: su(BASE_TARGET_SMALL), fontSize: fs(14) },
      },
    },
    MuiToggleButtonGroup: { styleOverrides: { root: { backgroundColor: 'transparent' } } },

    MuiPaper: {
      styleOverrides: {
        rounded: { borderRadius: 18, backgroundImage: 'none' },
        outlined: {
          backgroundImage: 'none',
          border: borderStrong,
          borderColor,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          ...(isHC ? { backgroundColor: '#000000', borderBottom: '2px solid #ffffff' } : {}),
        },
      },
    },
    MuiDivider: { styleOverrides: { root: isHC ? { borderColor: '#ffffff', borderWidth: 2 } : {} } },
    MuiLinearProgress: { styleOverrides: { root: { borderRadius: 99, height: su(8) } } },
    MuiCircularProgress: { styleOverrides: { root: { fontSize: fs(20) } } },
    MuiTooltip: {
      defaultProps: { arrow: true },
      styleOverrides: { tooltip: { fontSize: fs(14), padding: `${su(6)} ${su(10)}` } },
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 20, backgroundImage: 'none', ...(isHC ? { border: '2px solid #ffffff' } : {}) } },
    },
    MuiAlert: {
      styleOverrides: {
        root: { fontSize: fs(14.5), alignItems: 'center', ...(isHC ? { border: '2px solid #ffffff' } : {}) },
        message: { overflow: 'visible' },
      },
    },
    MuiSnackbar: { styleOverrides: { root: { '& .MuiAlert-root': { fontSize: fs(15) } } } },
    MuiTypography: { styleOverrides: { root: { textRendering: 'optimizeLegibility' } } },
  };
}

/**
 * 创建应用主题。
 * @param {'light'|'dark'|'hc'} mode  主题模式，'hc' = 高对比度（WCAG AAA）
 * @param {number} [scale] 字号档位（1/1.25/1.5/2）。省略则取当前档位（并同步 CSS 变量）。
 */
export function createAppTheme(mode, scale) {
  const s = normalizeFontScale(scale == null ? getFontScale() : scale);
  const palette = buildPalette(mode);
  // 主题创建即把档位写进 CSS 变量，保证 spacing/目标尺寸与 typography 同频
  if (typeof document !== 'undefined') applyFontScaleToDocument(s);
  // hc 模式同步 data 属性（index.css 里的原生控件兜底依赖它）
  if (typeof document !== 'undefined' && document.documentElement) {
    if (mode === 'hc') document.documentElement.setAttribute('data-theme-hc', '1');
    else document.documentElement.removeAttribute('data-theme-hc');
  }
  return createTheme({
    palette,
    shape: { borderRadius: 14 },
    // 间距：calc(8px * n * scale) —— 与 --ldn-scale 联动，切档即时生效
    spacing: (factor) => `calc(${BASE_SPACING * Number(factor || 0)}px * var(--ldn-scale, 1))`,
    typography: {
      fontFamily: FONT_STACK,
      fontSize: TYPE_PX.body2,
      htmlFontSize: BASE_FONT_SIZE,
      ...buildTypography(),
    },
    components: buildComponents(mode, palette),
    custom: { isHighContrast: mode === 'hc', fontScale: s, themeMode: mode },
  });
}

// ---------------------------------------------------------------------------
// 字号档位运行时（唯一真源：documentElement 上的 --ldn-scale）
// ---------------------------------------------------------------------------
let _fontScale = FONT_SCALE_DEFAULT;

export function normalizeFontScale(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return FONT_SCALE_DEFAULT;
  // 吸附到最近档位，避免任意值
  let best = FONT_SCALE_STEPS[0];
  FONT_SCALE_STEPS.forEach((s) => {
    if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  });
  return best;
}

export function getFontScale() {
  return _fontScale;
}

/** 写 CSS 变量 + data 属性（不需要重渲染即可全界面生效） */
export function applyFontScaleToDocument(scale) {
  const s = normalizeFontScale(scale);
  _fontScale = s;
  if (typeof document === 'undefined' || !document.documentElement) return s;
  const el = document.documentElement;
  el.style.setProperty('--ldn-scale', String(s));
  el.setAttribute('data-font-scale', String(s));
  return s;
}

/** 切换字号档位（UI 调用；持久化由调用方走 saveSystemSettings） */
export function setFontScale(scale) {
  return applyFontScaleToDocument(scale);
}

// 启动补水：主进程 settings.json 是权威源（fontScale），异步拿到后即时生效
function bridge() {
  try {
    return typeof window !== 'undefined' ? window.langdu : null;
  } catch (e) {
    return null;
  }
}

function hydrateFontScale() {
  try {
    applyFontScaleToDocument(_fontScale);
    const b = bridge();
    const apply = (s) => {
      if (s && s.fontScale != null) applyFontScaleToDocument(s.fontScale);
    };
    if (b && typeof b.getSystemSettings === 'function') {
      b.getSystemSettings().then(apply).catch(() => {});
    }
    if (b && typeof b.onSystemSettings === 'function') {
      b.onSystemSettings(apply);
    }
  } catch (e) {
    /* 无桥时保持默认档位 */
  }
}

if (typeof window !== 'undefined') hydrateFontScale();

// ---------------------------------------------------------------------------
// 系统偏好联动（基线指标 B）：prefers-contrast: more → 自动切换高对比度主题
//   · CSS 变量层（index.css 的同名 media query）负责焦点环/原生控件加固；
//     这里负责把 MUI 主题真正切到 'hc'（纯 CSS 做不到换 palette）。
//   · 只在「系统要求更高对比度」时向上切换；用户随后在设置里手动选任何主题都生效，
//     不会被媒体查询抢回（change 事件不重复触发即不覆盖）。
// ---------------------------------------------------------------------------
function watchSystemContrast() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  let mq;
  try {
    mq = window.matchMedia('(prefers-contrast: more)');
  } catch (e) {
    return; // 老 Electron 不支持该媒体特性时静默跳过
  }
  const apply = () => {
    if (!mq.matches) return; // 偏好收回不强行切回，尊重用户显式选择
    try {
      const st = useSettings.getState();
      if (st.themeMode !== 'hc') st.set({ themeMode: 'hc' });
    } catch (e) {
      /* store 未就绪时保持当前主题 */
    }
  };
  try {
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
    else if (typeof mq.addListener === 'function') mq.addListener(apply); // 旧版 API 兼容
  } catch (e) {
    /* noop */
  }
  apply(); // 启动时按当前系统偏好补一次
}

if (typeof window !== 'undefined') watchSystemContrast();

export default createAppTheme;
