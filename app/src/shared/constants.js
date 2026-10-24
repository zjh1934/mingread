// 共享常量（主进程 CJS / 渲染进程经 Vite 以 default 导入均可使用）
'use strict';

module.exports = {
  APP_NAME: '朗读女 Neo',
  APP_NAME_EN: 'LangduNv Neo',
  APP_VERSION: '2.4.0',
  APP_ID: 'com.langdunv.neo',
  REPO_URL: 'https://github.com/zjh1934/langdu-nv',

  // v2.4.0：三级引擎链——本地 NVSA(SAPI) 优先 → espeak（仅沙箱/CI 验证，产品路径不启用）→ Edge 在线兜底。
  // 运行时唯一 npm 依赖仍为 node-edge-tts；sapi/espeak 后端均不引入新依赖。
  ENGINE: { EDGE: 'edge', SAPI: 'sapi', ESPEAK: 'espeak' },
  ENGINE_LABEL: { edge: '微软 Edge 在线语音', sapi: '本地离线语音（NVSA）', espeak: 'espeak-ng（验证专用）' },
  ENGINE_ORDER: ['sapi', 'espeak', 'edge'],

  // 只保留两个音色
  EDGE_VOICES: [
    {
      key: 'xiaoxiao',
      id: 'edge:xiaoxiao',
      name: '晓晓',
      shortName: 'XiaoxiaoNeural',
      gender: 'female',
      desc: '微软在线神经语音 · 女声',
    },
    {
      key: 'yunxi',
      id: 'edge:yunxi',
      name: '云希',
      shortName: 'YunxiNeural',
      gender: 'male',
      desc: '微软在线神经语音 · 男声',
    },
  ],

  DEFAULT_VOICE_ID: 'edge:xiaoxiao',
  SECONDARY_VOICE_ID: 'edge:yunxi',

  // 语速 / 语调 / 音量范围（UI 与引擎共用）
  RATE_MIN: -50,
  RATE_MAX: 100,
  RATE_DEFAULT: 0, // %
  PITCH_MIN: -50,
  PITCH_MAX: 50,
  PITCH_DEFAULT: 0, // Hz
  VOLUME_MIN: -50,
  VOLUME_MAX: 50,
  VOLUME_DEFAULT: 0, // %

  // 支持的文件格式
  SUPPORTED_FILE_EXT: ['.txt', '.md', '.epub'],

  // 默认全局热键（v2.4.0 起，用户明确要求）：选中任意处文字后按 F1 直接朗读（Ctrl+Alt+R 为备选预设）
  DEFAULT_HOTKEY: 'F1',

  ERR: {
    TTS_SYNTH_FAIL: 'TTS_SYNTH_FAIL',
    TTS_NO_VOICE: 'TTS_NO_VOICE',
    EDGE_NETWORK: 'EDGE_NETWORK',
    NO_SELECTION: 'NO_SELECTION',
    IO_WRITE_FAIL: 'IO_WRITE_FAIL',
    IPC_UNKNOWN: 'IPC_UNKNOWN',
  },

  // v2.3 无障碍反馈（γ 负责 main 侧实现；β 在 renderer 侧调用）
  IPC_A11Y_ANNOUNCE: 'a11y:announce',
  IPC_A11Y_CUE: 'a11y:cue',
  A11Y_CUE_TYPES: ['press', 'success', 'error'],
  /** 同文本去重窗口：high 允许更频繁，normal 更保守 */
  A11Y_ANNOUNCE_DEDUPE_MS: { high: 800, normal: 3000 },
  /** 单次播报最大字符数（超长文本没有意义，还会拖长延迟） */
  A11Y_ANNOUNCE_MAX_CHARS: 200,
  /** 提示音上限（基线指标 E：热键→反馈音 ≤200ms，音本身要短促） */
  A11Y_CUE_MAX_MS: 100,
};
