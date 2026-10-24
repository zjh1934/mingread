import { useEffect, useRef } from 'react';
import announcer from '../services/announcer';
import { createStartAnnounceGate, START_CONFIRM_DELAY_MS } from './startAnnounceGate';

/**
 * 把「开始 / 继续朗读」这类结果性播报改成延迟确认（见 startAnnounceGate.js 的说明）。
 *
 * 用法：
 *   const startAnnounce = useDelayedAnnounce({ isPlaying: playback.isPlaying });
 *   startAnnounce.arm('start');   // 发起朗读后挂起，700ms 内出声就自动丢弃
 *   startAnnounce.cancel();       // 停止 / 暂停 / 新一轮触发时清掉
 *
 * @param {object} opts
 * @param {boolean} opts.isPlaying 播放器当前是否真的在出声
 * @param {number} [opts.delayMs] 确认窗口，默认 700ms
 * @returns {{arm:Function, cancel:Function, armed:boolean}} 引用稳定，可安全放进 useCallback 依赖
 */
export function useDelayedAnnounce({ isPlaying, delayMs = START_CONFIRM_DELAY_MS } = {}) {
  // 定时器回调里必须读「此刻」的播放状态，不能读 arm 时的闭包快照
  const soundingRef = useRef(!!isPlaying);
  soundingRef.current = !!isPlaying;

  const gateRef = useRef(null);
  if (!gateRef.current) {
    gateRef.current = createStartAnnounceGate({
      announce: (name, params, opts) => announcer.announce(name, params, opts),
      isSounding: () => soundingRef.current,
      delayMs,
    });
  }
  const gate = gateRef.current;

  // 真的出声了：立刻作废挂起的播报（不必等到 700ms 再判一次）
  useEffect(() => {
    if (isPlaying) gate.cancel();
  }, [isPlaying, gate]);

  // 卸载 / 热更新时清掉定时器，避免组件没了还冒出一句播报
  useEffect(() => () => gate.cancel(), [gate]);

  return gate;
}

export default useDelayedAnnounce;
