// 屏幕缩放（LensZoom，复刻 macOS 缩放）设置分区。
// v2.4.0 W-UI1：原「视觉增强」（字号档位 / 对比度主题 / 悬浮球尺寸）已迁到设置的「无障碍」分区，
// 这里只留缩放本身，避免同一项设置在两处出现、改一处不生效的错觉。
// 数据契约：
//   window.langdu.zoom.get() => {zoomEnabled, zoomModifier, zoomFollowMode, zoomMin, zoomMax,
//     zoomInteger, zoomSmoothing, zoomSwallowScroll, zoomClickThrough, zoomShowHud, zoomFrameLimit,
//     zoomTrigger, zoomEdgeEnhance, zoomOutline, zoomOutlineColor, zoomContrast, zoomColorMode,
//     zoomCrosshair, zoomFocusRing, zoomFollowSmoothing, zoomHudFont, zoomAnnounce,
//     active, paused, zoom, backend, trigger, fps}
//   set(patch) / togglePause() / nudge(up) / reset() / onChanged(cb) -> {active, zoom, paused, trigger}
// 桥不存在时（主进程未就绪）整体静默降级，不白屏、不报错。
import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormHelperText,
  InputLabel,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Typography,
} from '@mui/material';

import statusHistory from '../services/statusHistory';
import { fs, su } from '../theme';

function zoomApi() {
  try {
    return (typeof window !== 'undefined' && window.langdu && window.langdu.zoom) || null;
  } catch (e) {
    return null;
  }
}

// trigger → 文案。主进程实际取值：koffi | uiohook | hotkey | none（另兼容 wheel/scroll 写法）。
function triggerLabel(cfg) {
  if (!cfg) return '未启用';
  const t = String(cfg.trigger || '').toLowerCase();
  const backend = String(cfg.backend || '').toLowerCase();
  if (cfg.zoomEnabled === false || t === 'none') return '未启用';
  if (t.indexOf('koffi') !== -1) return '滚轮触发（koffi）';
  if (t.indexOf('uiohook') !== -1) return '滚轮触发（uiohook）';
  if (t === 'hotkey') return '热键触发';
  if (t === 'wheel' || t === 'scroll' || t === 'mod+wheel' || t === 'modifier+wheel') {
    if (backend === 'koffi') return '滚轮触发（koffi）';
    if (backend === 'uiohook') return '滚轮触发（uiohook）';
    return '滚轮触发';
  }
  // trigger 缺失（旧版主进程）：有钩子后端即滚轮，否则热键兜底
  if (backend === 'koffi') return '滚轮触发（koffi）';
  if (backend === 'uiohook') return '滚轮触发（uiohook）';
  return '热键触发';
}

function fmtZoom(z) {
  const n = Number(z);
  if (!n || !isFinite(n)) return '1.0';
  return n.toFixed(1);
}

const MODIFIER_LABELS = { alt: 'Alt（推荐）', ctrl: 'Ctrl（易与页面缩放冲突）', win: 'Win（实验，松手可能弹开始菜单）' };
const FOLLOW_LABELS = {
  fixed: '指针为不动点（等同 macOS 持续跟随）',
  centered: '指针恒居中',
  push: '到边缘才推动画面',
};
const COLOR_MODE_LABELS = { normal: '标准', invert: '反色（白底黑字更省眼）', hicontrast: '高对比灰度' };
const CROSSHAIR_LABELS = { off: '关闭', cross: '十字线', full: '全屏十字线（更醒目）' };
const OUTLINE_COLOR_LABELS = { '#ffff00': '黄色', '#ffffff': '白色', '#000000': '黑色', '#00ffff': '青色' };
const HOTKEY_HINT = '热键：Ctrl+Alt+= 放大 · Ctrl+Alt+- 缩小 · Ctrl+Alt+0 退出 · Ctrl+Alt+Q 快速循环(2/4/8/16/32) · Ctrl+Alt+方向键 平移';

// Slider thumb 尺寸由 theme.js 的 MuiSlider 全局统一下发（28px × --ldn-scale），
// 这里不再重复定义，避免两处真源走歧。

// 开关行：状态除位置/填充外，再用「已开启 / 已关闭」文字冗余编码（低视力 + 色弱可辨），
// 并通过 aria-labelledby / aria-describedby 让读屏念出「控制项 + 当前状态 + 说明」。
function SwitchRow({ id, label, checked, onChange, caption }) {
  const labelId = `${id}-label`;
  const stateId = `${id}-state`;
  const captionId = caption ? `${id}-desc` : undefined;
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.25}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography id={labelId} variant="body1" sx={{ fontWeight: 600 }}>
              {label}
            </Typography>
            <Box
              component="span"
              id={stateId}
              sx={{
                px: 1,
                py: 0.125,
                borderRadius: 1,
                border: '1px solid',
                borderColor: checked ? 'primary.main' : 'divider',
                color: checked ? 'primary.main' : 'text.secondary',
                fontSize: fs(12.5),
                fontWeight: 700,
                lineHeight: 1.6,
                whiteSpace: 'nowrap',
              }}
            >
              {checked ? '已开启' : '已关闭'}
            </Box>
          </Stack>
          {caption && (
            <Typography id={captionId} variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              {caption}
            </Typography>
          )}
        </Box>
        <Switch
          checked={!!checked}
          onChange={(e) => onChange(e.target.checked)}
          // 主题里 Switch 是 62×42：上下各补 12px 内边距 → 可点区域 62×48（低视力目标 ≥44），
          // 左右内边距不动，滑块与轨道的位置保持原样
          sx={{ height: su(48), '& .MuiSwitch-switchBase': { paddingTop: su(12), paddingBottom: su(12) } }}
          inputProps={{
            'aria-labelledby': labelId,
            'aria-describedby': [stateId, captionId].filter(Boolean).join(' '),
          }}
        />
      </Stack>
    </Box>
  );
}

/** 数值 Slider：拖动中不发 IPC，松手才落盘 */
function NumSlider({ id, label, value, min, max, step, onChangeCommitted, format, caption }) {
  const [draft, setDraft] = useState(null);
  const cur = draft != null ? draft : value;
  const shown = format ? format(cur) : cur;
  const captionId = caption ? `${id}-desc` : undefined;
  return (
    <Box>
      <Typography variant="body2" component="p" id={`${id}-label`} sx={{ fontWeight: 600 }}>
        {label}：<Box component="span" sx={{ fontVariantNumeric: 'tabular-nums' }}>{shown}</Box>
      </Typography>
      <Slider
        valueLabelDisplay="auto"
        min={min}
        max={max}
        step={step}
        value={cur}
        onChange={(_e, v) => setDraft(v)}
        onChangeCommitted={(_e, v) => {
          setDraft(null);
          onChangeCommitted(v);
        }}
        aria-labelledby={`${id}-label`}
        aria-describedby={captionId}
        getAriaValueText={() => String(shown)}
      />
      {caption && (
        <Typography id={captionId} variant="body2" color="text.secondary" sx={{ display: 'block' }}>
          {caption}
        </Typography>
      )}
    </Box>
  );
}

export default function ZoomSettings({ notify }) {
  const [cfg, setCfg] = useState(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  // Slider 拖动期间用草稿值，松手才下发，避免每像素一次 IPC
  const [maxDraft, setMaxDraft] = useState(null);
  const [smoothDraft, setSmoothDraft] = useState(null);

  useEffect(() => {
    let alive = true;
    let retried = false;
    const tryLoad = async () => {
      const z = zoomApi();
      if (!z || typeof z.get !== 'function') {
        // 主进程工程师可能正在改 preload：短重试一次，仍缺失才提示
        if (!retried) {
          retried = true;
          setTimeout(() => {
            if (alive) tryLoad();
          }, 900);
          return;
        }
        if (alive) setMissing(true);
        statusHistory.record('屏幕缩放模块未就绪：主进程预加载缺少 window.langdu.zoom', {
          severity: 'warning',
          source: 'zoom',
        });
        return;
      }
      try {
        const v = await z.get();
        if (alive && v && typeof v === 'object') setCfg(v);
      } catch (e) {
        if (alive) {
          const msg = (e && e.message) || String(e);
          setLoadError(msg);
          // 读取失败也留痕：Snackbar 会消失，低视力用户可到「设置 → 记录」回看
          statusHistory.record(`读取屏幕缩放设置失败：${msg}`, { severity: 'error', source: 'zoom' });
        }
      }
    };
    tryLoad();
    // 运行时状态（激活/暂停/倍率/trigger）随事件保持最新
    let off;
    try {
      off = zoomApi()?.onChanged?.((payload) => {
        if (!alive || !payload || typeof payload !== 'object') return;
        setCfg((prev) => (prev ? { ...prev, ...payload } : prev));
      });
    } catch (e) {
      /* 订阅失败不阻塞界面 */
    }
    return () => {
      alive = false;
      if (typeof off === 'function') off();
    };
  }, []);

  const patch = useCallback(
    async (p) => {
      const z = zoomApi();
      if (!z || typeof z.set !== 'function') {
        notify?.('当前环境不支持屏幕缩放设置（主进程未就绪）', 'error');
        return;
      }
      try {
        await z.set(p || {});
        const next = await z.get();
        if (next && typeof next === 'object') setCfg(next);
      } catch (e) {
        notify?.(`屏幕缩放设置失败：${(e && e.message) || e}`, 'error');
      }
    },
    [notify]
  );

  const zoomMax = maxDraft != null ? maxDraft : cfg ? cfg.zoomMax : 24;
  const zoomSmoothing = smoothDraft != null ? smoothDraft : cfg ? cfg.zoomSmoothing : 0.65;
  const zoomTrigger = (cfg && cfg.zoomTrigger) || 'auto';

  return (
    <Box>
      {missing && (
        <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          屏幕缩放模块未就绪：主进程预加载缺少 window.langdu.zoom（主进程联调中，此处暂不可设置）
        </Typography>
      )}
      {!missing && loadError && !cfg && (
        <Typography variant="body2" color="error" sx={{ display: 'block', mb: 1 }}>
          读取屏幕缩放设置失败：{loadError}
        </Typography>
      )}
      {!missing && !cfg && !loadError && (
        <Stack direction="row" spacing={1} alignItems="center">
          <CircularProgress size={su(16)} />
          <Typography variant="body2" color="text.secondary">
            正在读取屏幕缩放设置…
          </Typography>
        </Stack>
      )}

      {cfg && (
        <>
          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <Chip size="small" variant="outlined" label={`触发：${triggerLabel(cfg)}`} sx={{ height: su(34) }} />
            <Typography variant="body2" color="text.secondary">
              {cfg.active ? `缩放中 ${fmtZoom(cfg.zoom)}x` : '未激活'}
              {cfg.paused ? ' · 已暂停' : ''}
            </Typography>
          </Stack>

          <Stack spacing={1.75} sx={{ mt: 1.5 }}>
            <SwitchRow
              id="zoom-enabled"
              label="启用屏幕缩放"
              checked={cfg.zoomEnabled}
              onChange={(v) => patch({ zoomEnabled: v })}
            />

            <FormControl size="small" fullWidth>
              <InputLabel>触发方式</InputLabel>
              <Select
                value={zoomTrigger}
                label="触发方式"
                onChange={(e) => patch({ zoomTrigger: e.target.value })}
              >
                <MenuItem value="auto">自动（优先滚轮，不可用则热键）</MenuItem>
                <MenuItem value="hotkey">仅热键</MenuItem>
              </Select>
              <FormHelperText>{HOTKEY_HINT}</FormHelperText>
            </FormControl>

            <FormControl size="small" fullWidth disabled={zoomTrigger === 'hotkey'}>
              <InputLabel>触发修饰键</InputLabel>
              <Select
                value={cfg.zoomModifier || 'alt'}
                label="触发修饰键"
                onChange={(e) => patch({ zoomModifier: e.target.value })}
              >
                {Object.keys(MODIFIER_LABELS).map((k) => (
                  <MenuItem key={k} value={k}>
                    {MODIFIER_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
              {zoomTrigger === 'hotkey' && <FormHelperText>热键模式不使用修饰键</FormHelperText>}
            </FormControl>

            <FormControl size="small" fullWidth>
              <InputLabel>跟随策略</InputLabel>
              <Select
                value={cfg.zoomFollowMode || 'fixed'}
                label="跟随策略"
                onChange={(e) => patch({ zoomFollowMode: e.target.value })}
              >
                {Object.keys(FOLLOW_LABELS).map((k) => (
                  <MenuItem key={k} value={k}>
                    {FOLLOW_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <NumSlider
              id="zoom-max"
              label="倍率上限"
              value={Math.min(Math.max(Number(zoomMax) || 2, 2), 32)}
              min={2}
              max={32}
              step={1}
              format={(v) => `${v}x`}
              onChangeCommitted={(v) => {
                setMaxDraft(null);
                patch({ zoomMax: v });
              }}
              caption="最高 32x；低视力建议 8x 起"
            />

            <NumSlider
              id="zoom-smoothing"
              label="过渡平滑度"
              value={Math.min(Math.max(Number(zoomSmoothing) || 0, 0), 0.95)}
              min={0}
              max={0.95}
              step={0.05}
              format={(v) => Number(v).toFixed(2)}
              onChangeCommitted={(v) => {
                setSmoothDraft(null);
                patch({ zoomSmoothing: v });
              }}
              caption="越大越柔和；卡顿就调小"
            />

            <NumSlider
              id="zoom-follow-smoothing"
              label="平移跟随平滑度"
              value={Math.min(Math.max(Number(cfg.zoomFollowSmoothing) || 0, 0), 0.95)}
              min={0}
              max={0.95}
              step={0.05}
              format={(v) => Number(v).toFixed(2)}
              onChangeCommitted={(v) => patch({ zoomFollowSmoothing: v })}
              caption="0 = 画面严格跟指针；调大则画面拖着走，缓解抖动"
            />

            <NumSlider
              id="zoom-edge"
              label="边缘锐化"
              value={Math.min(Math.max(Number(cfg.zoomEdgeEnhance) || 0, 0), 1)}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(Number(v) * 100)}%`}
              onChangeCommitted={(v) => patch({ zoomEdgeEnhance: v })}
              caption="放大后文字发虚时调高；卡顿时调低"
            />

            <NumSlider
              id="zoom-contrast"
              label="对比度增强"
              value={Math.min(Math.max(Number(cfg.zoomContrast) || 0, 0), 1)}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(Number(v) * 100)}%`}
              onChangeCommitted={(v) => patch({ zoomContrast: v })}
            />

            <NumSlider
              id="zoom-outline"
              label="边缘描边"
              value={Math.min(Math.max(Number(cfg.zoomOutline) || 0, 0), 1)}
              min={0}
              max={1}
              step={0.05}
              format={(v) => (Number(v) > 0 ? `${Math.round(Number(v) * 100)}%` : '关闭')}
              onChangeCommitted={(v) => patch({ zoomOutline: v })}
              caption="给图形/文字轮廓加描边；较耗性能，卡顿时关掉"
            />

            <FormControl size="small" fullWidth>
              <InputLabel>描边颜色</InputLabel>
              <Select
                value={cfg.zoomOutlineColor || '#ffff00'}
                label="描边颜色"
                onChange={(e) => patch({ zoomOutlineColor: e.target.value })}
              >
                {Object.keys(OUTLINE_COLOR_LABELS).map((k) => (
                  <MenuItem key={k} value={k}>
                    {OUTLINE_COLOR_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" fullWidth>
              <InputLabel>色彩模式</InputLabel>
              <Select
                value={cfg.zoomColorMode || 'normal'}
                label="色彩模式"
                onChange={(e) => patch({ zoomColorMode: e.target.value })}
              >
                {Object.keys(COLOR_MODE_LABELS).map((k) => (
                  <MenuItem key={k} value={k}>
                    {COLOR_MODE_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" fullWidth>
              <InputLabel>定位辅助</InputLabel>
              <Select
                value={cfg.zoomCrosshair || 'off'}
                label="定位辅助"
                onChange={(e) => patch({ zoomCrosshair: e.target.value })}
              >
                {Object.keys(CROSSHAIR_LABELS).map((k) => (
                  <MenuItem key={k} value={k}>
                    {CROSSHAIR_LABELS[k]}
                  </MenuItem>
                ))}
              </Select>
              <FormHelperText>放大后最容易找不到鼠标在哪</FormHelperText>
            </FormControl>

            <SwitchRow
              id="zoom-focus-ring"
              label="光标焦点高亮框"
              checked={cfg.zoomFocusRing !== false}
              onChange={(v) => patch({ zoomFocusRing: v })}
              caption="在光标周围画一个高对比方框"
            />
            <SwitchRow
              id="zoom-integer"
              label="整数倍步进（像素锐利，不模糊）"
              checked={cfg.zoomInteger}
              onChange={(v) => patch({ zoomInteger: v })}
            />
            <SwitchRow
              id="zoom-swallow"
              label="吞掉滚轮事件（放大时不带动页面滚动）"
              checked={cfg.zoomSwallowScroll}
              onChange={(v) => patch({ zoomSwallowScroll: v })}
            />
            <SwitchRow
              id="zoom-click-through"
              label="放大时鼠标穿透（点击仍能操作下层界面）"
              checked={cfg.zoomClickThrough}
              onChange={(v) => patch({ zoomClickThrough: v })}
            />
            <SwitchRow
              id="zoom-hud"
              label="显示调试信息 HUD（倍率 / FPS）"
              checked={cfg.zoomShowHud}
              onChange={(v) => patch({ zoomShowHud: v })}
            />
            <SwitchRow
              id="zoom-announce"
              label="倍率变化语音播报"
              checked={cfg.zoomAnnounce !== false}
              onChange={(v) => patch({ zoomAnnounce: v })}
              caption="每次倍率变化朗读「已放大到 N 倍」；看不清 HUD 的低视力用户尤其有用"
            />
          </Stack>

          <Divider sx={{ my: 1.5 }} />
          <Typography variant="body2" color="text.secondary" sx={{ display: 'block' }}>
            放大时把倍率缩回 1x 自动退出；托盘菜单与桌面悬浮球右键也可控制缩放。
            放大后按 Ctrl+Alt+方向键可平移画面（查看屏幕外内容），Ctrl+Alt+Q 在 2/4/8/16/32 倍间快速循环。
          </Typography>
        </>
      )}
    </Box>
  );
}
