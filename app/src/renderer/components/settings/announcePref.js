// 「语音播报」开关的持久化（渲染层）。
// announcer 自己的 config 只存在内存里，重启就丢，所以开关值存 localStorage。
// 注意边界：本开关控制渲染层产生的播报（设置变更、主题切换、定时到达等）；
// 热键/悬浮球那条链路的声音由主进程 a11yFeedback 发出，需要主进程读同一个开关才完全生效
// —— 已在回执里作为契约申请提出，当前不假称「全都静音」。
import announcer from '../../services/announcer';

const KEY = 'langdu-neo-announce-enabled';

export function readAnnounceEnabled() {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? true : v === '1';
  } catch (e) {
    return true;
  }
}

export function applyAnnounceEnabled(enabled) {
  const on = !!enabled;
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch (e) {
    /* 隐私模式写不进去时只影响下次启动，不影响本次 */
  }
  announcer.configure({ enabled: on });
  return on;
}

/** 启动补水：App 一进来就 import 设置面板，模块初始化即生效 */
export function hydrateAnnouncePref() {
  try {
    announcer.configure({ enabled: readAnnounceEnabled() });
  } catch (e) {
    /* 桥未就绪时保持默认开启 */
  }
}
