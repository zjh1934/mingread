// 「朗读 → 语速 / 语调 / 音量 + 定时关闭」
// 语速语调音量复用 TuningPanel（主界面参数气泡用的是同一组件，口径一致）；
// 定时关闭统一走播放 hook 的计时器（v2.4.0 契约裁决：原设置侧 timerService 是第二套计时器，
// 两边状态不互通 —— 设置里开的定时播放区 Badge 不亮，且停止通道绕了一圈）。
import React from 'react';
import { Box, Button } from '@mui/material';
import { RestartAlt } from '@mui/icons-material';
import { SettingGroup, HelpText } from './rows';
import TuningPanel from '../TuningPanel';
import TimerPanel from '../TimerPanel';

export default function ReadingSettings({ rate, pitch, volume, onTuningChange, playback }) {
  const tuningDirty = Number(rate) !== 0 || Number(pitch) !== 0 || Number(volume) !== 0;
  // playback 缺失时退化为「不可用」，绝不偷偷回退到第二套计时器
  const timerActive = !!(playback && playback.timerActive);
  const canTimer = !!(playback && typeof playback.startTimer === 'function');

  return (
    <>
      <SettingGroup
        title="朗读参数"
        desc="拖动即生效，松手后自动保存；三项都调过的可用「恢复默认」一键还原"
        action={
          <Button
            variant="outlined"
            startIcon={<RestartAlt />}
            disabled={!tuningDirty}
            onClick={() => onTuningChange({ rate: 0, pitch: 0, volume: 0 })}
            aria-label="恢复默认朗读参数"
          >
            恢复默认
          </Button>
        }
      >
        <Box>
          <TuningPanel
            rate={rate}
            pitch={pitch}
            volume={volume}
            onChange={onTuningChange}
            flat
            fullWidth
            hideTitle
          />
        </Box>
        <HelpText>
          语速范围 -50（最慢）到 +100（最快）；语调、音量按 Hz / 百分比微调，0 为默认值。
        </HelpText>
      </SettingGroup>

      <SettingGroup title="定时关闭" desc="到点自动暂停，适合睡前听书">
        <TimerPanel
          embedded
          active={timerActive}
          onStart={(m) => {
            if (canTimer) playback.startTimer(m);
          }}
          onClear={() => {
            if (canTimer && typeof playback.clearTimer === 'function') playback.clearTimer();
          }}
        />
        <HelpText>
          {canTimer
            ? '定时开启后，即使关闭设置窗口或切到别的程序也会继续倒计时；播放区的定时按钮会同步亮起。'
            : '当前播放器未就绪，暂时无法设置定时。'}
        </HelpText>
      </SettingGroup>
    </>
  );
}
