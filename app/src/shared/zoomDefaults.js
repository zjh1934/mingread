// 屏幕缩放的默认值（单一来源）。
//
// 为什么单独一个文件：这些默认值同时被 zoomController（使用方）和 settingsStore（合并默认值）需要。
// 原先 ZOOM_DEFAULTS 定义在 zoomController 里，于是 settingsStore 为了拿一个常量对象，
// 不得不 require 整个 1100 行的缩放控制器 —— 而 zoomController 又链式依赖
// a11yFeedback → ttsBridge → … → settingsStore，形成**真循环依赖**：
// 一旦 require 顺序变化，某一方会拿到未执行完的空 exports，表现为莫名其妙的 undefined。
//
// 抽成独立的小模块（零依赖）后，这条链断开：常量往下沉，控制器和数据层都依赖它。
'use strict';

const ZOOM_DEFAULTS = {
  zoomEnabled: true,        // 总开关
  // v2.4.0：渲染后端。auto = 优先系统 Magnification API，不可用才回退覆盖层；
  // overlay = 强制旧方案（QA 与老机器排查用）；mag = 强制新方案（不可用则不放大）
  zoomBackend: 'auto',
  zoomModifier: 'alt',      // alt | ctrl | win | middle
  zoomFollowMode: 'fixed',  // fixed | centered | push
  zoomMin: 1,               // 回到该值即退出放大
  zoomMax: 24,              // α：倍率上限加大（原 16，最高可到 32）
  zoomInteger: true,        // 整数倍步进（2x/3x/4x…）
  zoomSmoothing: 0.65,      // 0~0.95，倍率过渡平滑度
  zoomSwallowScroll: true,  // 吞掉被消费的滚轮（仅 koffi 钩子模式有效）
  zoomClickThrough: true,   // 放大时鼠标穿透（点击仍能打到下层 UI）
  zoomShowHud: false,       // 左上角调试信息
  zoomFrameLimit: 60,
  // ---- α-视觉增强（低视力）：放大画质与定位辅助 ----
  zoomEdgeEnhance: 0.30,    // 0~1 锐化强度（feConvolveMatrix），0=关闭
  zoomOutline: 0,           // 0~1 边缘描边强度（图形轮廓加描边），0=关闭
  zoomOutlineColor: '#ffff00', // 描边颜色（默认高对比黄）
  zoomContrast: 0.15,       // 0~1 额外对比度提升（0=原始）
  zoomColorMode: 'normal',  // normal | invert | hicontrast（反色 / 高对比灰度）
  zoomCrosshair: 'off',     // off | cross | full 十字线辅助定位
  zoomFocusRing: true,      // 光标处焦点高亮框（放大后最容易"找不到指针"）
  zoomFollowSmoothing: 0,   // 0~0.95 平移跟随平滑度（0=与指针严格同步，fixed 模式推荐 0）
  zoomHudFont: 18,          // HUD 字号（px）——调试信息也要看得清
  zoomAnnounce: true,       // α2：倍率变化语音播报（overlay 走 speechSynthesis；低视力用户可能看不清 HUD）
  // 注意：zoomTrigger（'auto'|'hotkey'，F1 新增）不放在这里，由 settingsStore 单独加默认值
};

module.exports = { ZOOM_DEFAULTS };
