// 「已开始朗读 / 继续朗读」延迟确认闸门（纯函数层，不依赖 React）。
//
// 问题：这两句是**结果性**播报，但以前是「发起即播」。Edge 在线链路要 ~2 秒才出声，
// 播报念完正文才开始，听感上没冲突；换成本地 NVSA（~150ms 出声）后，播报和正文
// 同一刻抢喇叭，用户听到的是「已开始朗读」和正文叠在一起。
//
// 处理：发起朗读后先只给 cue('press')（毫秒级的「指令收到了」），
// 再把结果性播报挂起 START_CONFIRM_DELAY_MS：
//   - 窗口内真的出声（isSounding() 为真）→ 丢弃播报，正文本身就是最好的确认；
//   - 到点仍没声音（合成慢 / 在线链路慢）→ 才播报，让用户知道指令没丢。
// 暂停 / 停止 / 失败不在本闸门里，它们不会和正文抢声音，保持立即播报。

export const START_CONFIRM_DELAY_MS = 700;

/**
 * 到点后到底要不要补播。拆成纯函数，便于单测与探针直接验证判定逻辑。
 * @param {object} p
 * @param {boolean} p.isSounding 此刻是否已经在出声
 * @param {number} p.elapsedMs   从 arm 到现在的毫秒数
 * @param {number} [p.delayMs]
 * @returns {boolean} true = 需要播报
 */
export function shouldConfirmStart({ isSounding, elapsedMs, delayMs = START_CONFIRM_DELAY_MS }) {
  if (isSounding) return false; // 正文已经在响，再念一句就是重叠
  return elapsedMs >= delayMs;
}

/**
 * 建一个可复用的闸门。
 * @param {object} deps
 * @param {(name:string, params?:object, opts?:object) => any} deps.announce 真正的播报出口
 * @param {() => boolean} deps.isSounding 读取**当前**是否出声（必须是实时读，不能是闭包快照）
 * @param {number} [deps.delayMs]
 * @param {(fn:Function, ms:number) => any} [deps.schedule] 注入定时器（测试用）
 * @param {(h:any) => void} [deps.cancelSchedule]
 * @param {() => number} [deps.clock]
 */
export function createStartAnnounceGate({
  announce,
  isSounding,
  delayMs = START_CONFIRM_DELAY_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancelSchedule = (h) => clearTimeout(h),
  clock = () => Date.now(),
}) {
  let handle = null;
  let armedAt = 0;
  let token = 0; // 代际：每次 cancel / 重新 arm 都 +1，让旧回调作废

  function cancel() {
    token += 1;
    if (handle != null) {
      cancelSchedule(handle);
      handle = null;
    }
  }

  /**
   * 挂起一条结果性播报。重复调用会先清掉上一条，避免「上一次的延迟播报
   * 在下次朗读时突然冒出来」。
   * @param {string} name announcer 的预置键，如 'start' / 'resume'
   */
  function arm(name, params, opts) {
    cancel();
    const my = token;
    armedAt = clock();
    handle = schedule(() => {
      handle = null;
      if (my !== token) return; // 已被新一轮 / 取消作废
      const elapsedMs = clock() - armedAt;
      if (!shouldConfirmStart({ isSounding: !!isSounding(), elapsedMs, delayMs })) return;
      announce(name, params, opts);
    }, delayMs);
    return my;
  }

  return {
    arm,
    cancel,
    get armed() {
      return handle != null;
    },
  };
}
