// 「无障碍」分区：字号档位 / 对比度主题 / 语音播报开关 / 桌面悬浮球。
// 这些是低视力用户的「看不清 → 看得清」总开关，v2.3 里散落在「外观」和「缩放（视觉增强）」两处，
// 现在合并成一个分区，并按「先调字号、再调对比度、最后调鼠标入口」的使用顺序排列。
import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { MyLocation } from '@mui/icons-material';
import { useSettings } from '../../store/settingsStore';
import announcer from '../../services/announcer';
import {
  BALL_SIZE_LABELS,
  BALL_SIZE_STEPS,
  FONT_SCALE_LABELS,
  FONT_SCALE_STEPS,
  THEME_MODE_LABELS,
  THEME_MODES,
  fs,
  getFontScale,
  setFontScale,
  su,
} from '../../theme';
import { SettingGroup, SwitchRow, HelpText, optionGroupSx } from './rows';
import { readAnnounceEnabled, applyAnnounceEnabled } from './announcePref';

function bridge() {
  try {
    return typeof window !== 'undefined' ? window.langdu : null;
  } catch (e) {
    return null;
  }
}

export default function A11ySettings({ notify, onThemeChange, onToggleFlag }) {
  const themeMode = useSettings((s) => s.themeMode);
  const floatBallEnabled = useSettings((s) => s.floatBallEnabled);

  const [scale, setScale] = useState(() => getFontScale());
  const [ballSize, setBallSize] = useState(56);
  const [announceOn, setAnnounceOn] = useState(() => readAnnounceEnabled());

  // 主进程 settings.json 是 fontScale / floatBallSize 的权威源
  useEffect(() => {
    let alive = true;
    let retried = false;
    const load = () => {
      const api = bridge();
      if (!api?.getSystemSettings) {
        if (!retried) {
          retried = true;
          setTimeout(() => {
            if (alive) load();
          }, 800);
        }
        return;
      }
      api
        .getSystemSettings()
        .then((s) => {
          if (!alive || !s) return;
          if (s.fontScale != null) setScale(setFontScale(s.fontScale));
          if (s.floatBallSize != null) setBallSize(Number(s.floatBallSize));
        })
        .catch(() => {
          /* 主进程未就绪时保持默认档位 */
        });
    };
    load();
    return () => {
      alive = false;
    };
  }, []);

  const saveSystem = useCallback(
    async (patch, failMsg) => {
      try {
        const r = await bridge()?.saveSystemSettings?.(patch);
        if (r && r.ok === false) throw new Error(r.error || '主进程拒绝保存');
        return true;
      } catch (e) {
        notify?.(`${failMsg}：${(e && e.message) || e}`, 'error', { priority: 'high' });
        return false;
      }
    },
    [notify]
  );

  const handleScale = async (v) => {
    if (!v || v === scale) return;
    const next = setFontScale(v); // CSS 变量即时生效，无需重建 theme
    setScale(next);
    const label = FONT_SCALE_LABELS[next] || `${next}x`;
    announcer.say('fontScaleChanged', `界面字号已切换到${label}`);
    await saveSystem({ fontScale: next }, '字号档位保存失败');
  };

  const handleBallSize = async (v) => {
    if (!v || Number(v) === ballSize) return;
    const next = Number(v);
    setBallSize(next);
    announcer.say('ballSizeChanged', `悬浮球尺寸已改为${BALL_SIZE_LABELS[next] || `${next}像素`}`);
    await saveSystem({ floatBallSize: next }, '悬浮球尺寸保存失败');
  };

  const handleResetBall = async () => {
    const ok = await saveSystem({ floatBallPos: null }, '重置悬浮球位置失败');
    if (ok) notify('悬浮球位置已重置', 'success', { duration: 2200 });
  };

  const handleAnnounce = (v) => {
    setAnnounceOn(applyAnnounceEnabled(v));
    if (v) announcer.say('announceOn', '语音提示已开启');
    // 关闭时不能再靠语音确认（已经静音了），只留视觉 + 状态文字
    notify(v ? '语音提示已开启' : '语音提示已关闭', 'success', { duration: 2200, say: false });
  };

  return (
    <>
      <SettingGroup title="字号档位" desc="全界面字号、间距、按钮与滑块一起放大，切换即时生效">
        <Box>
          <ToggleButtonGroup
            exclusive
            value={scale}
            onChange={(_e, v) => handleScale(v)}
            aria-label="界面字号档位"
            sx={optionGroupSx}
          >
            {FONT_SCALE_STEPS.map((s) => (
              <ToggleButton key={s} value={s} aria-label={`字号 ${FONT_SCALE_LABELS[s] || `${s}x`}`}>
                {FONT_SCALE_LABELS[s] || `${s}x`}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <HelpText>看不清就先调这一项：它会同时放大文字、行距和所有按钮，比单独放大某一处更好用。</HelpText>
        </Box>
      </SettingGroup>

      <SettingGroup title="对比度与主题" desc="高对比度主题下所有文字对比度 ≥ 7:1（WCAG AAA）">
        <Box>
          <ToggleButtonGroup
            exclusive
            value={THEME_MODES.indexOf(themeMode) === -1 ? 'light' : themeMode}
            onChange={(_e, v) => onThemeChange(v)}
            aria-label="界面主题与对比度"
            sx={optionGroupSx}
          >
            {THEME_MODES.map((m) => (
              <ToggleButton key={m} value={m} aria-label={`主题 ${THEME_MODE_LABELS[m] || m}`}>
                {THEME_MODE_LABELS[m] || m}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      </SettingGroup>

      <SettingGroup title="语音提示" desc="操作结果与状态变化除了显示，还会念出来">
        <SwitchRow
          id="a11y-announce"
          label="语音播报界面提示"
          desc="关闭后：设置变更、主题切换、定时到达等界面提示不再朗读（朗读正文与热键操作不受影响）"
          checked={announceOn}
          onChange={handleAnnounce}
        />
      </SettingGroup>

      <SettingGroup title="桌面悬浮球" desc="鼠标入口：单击朗读当前选中文字，可拖动位置">
        <SwitchRow
          id="a11y-ball"
          label="启用桌面悬浮球"
          desc="在屏幕边缘显示一个圆球，单击即朗读选中文字"
          checked={floatBallEnabled}
          onChange={(v) => onToggleFlag('floatBallEnabled', v, '桌面悬浮球')}
        />
        <Box>
          <Typography variant="body1" component="p" sx={{ fontWeight: 600, mb: 0.75 }}>
            悬浮球尺寸
          </Typography>
          <ToggleButtonGroup
            exclusive
            value={ballSize}
            onChange={(_e, v) => handleBallSize(v)}
            aria-label="悬浮球尺寸"
            sx={optionGroupSx}
          >
            {BALL_SIZE_STEPS.map((s) => (
              <ToggleButton key={s} value={s} aria-label={`悬浮球尺寸 ${BALL_SIZE_LABELS[s] || `${s}像素`}`}>
                {BALL_SIZE_LABELS[s] || `${s}px`}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <HelpText>球体与右键菜单文字同步放大，点击更省力。</HelpText>
        </Box>
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button
            variant="outlined"
            startIcon={<MyLocation sx={{ fontSize: fs(20) }} />}
            onClick={handleResetBall}
            sx={{ minHeight: su(44) }}
          >
            重置悬浮球位置
          </Button>
        </Stack>
      </SettingGroup>
    </>
  );
}
