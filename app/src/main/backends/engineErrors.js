// 引擎级错误码与降级原因（独立文件：避免与 backends/index.js 形成循环依赖）
'use strict';

/** 引擎级错误码（shared/constants 为共享契约不可改，故本地定义） */
const ENGINE_ERR = {
  LOCAL_UNAVAILABLE: 'LOCAL_UNAVAILABLE', // 本地引擎不可用（未注册 / 非 Windows / 通道起不来）
  LOCAL_SYNTH_FAIL: 'LOCAL_SYNTH_FAIL', // 本地引擎可用但本次合成失败
  ALL_UNAVAILABLE: 'ALL_UNAVAILABLE', // 本地与在线都不可用
};

/** 本地引擎不可用原因（供上层播报 / 引导） */
const LOCAL_REASON = {
  NOT_WINDOWS: 'NOT_WINDOWS',
  NO_POWERSHELL: 'NO_POWERSHELL',
  HOST_START_FAILED: 'HOST_START_FAILED',
  VOICE_NOT_REGISTERED: 'VOICE_NOT_REGISTERED', // NVSA 未注册 / 语音包未装
};

/** 各原因对应的用户可读提示（用于状态播报，不静默失败） */
const LOCAL_REASON_TEXT = {
  NOT_WINDOWS: '本地语音仅支持 Windows',
  NO_POWERSHELL: '未找到 PowerShell，无法调用本地语音',
  HOST_START_FAILED: '本地语音通道启动失败',
  VOICE_NOT_REGISTERED: '未检测到本地语音（晓晓/云希），需运行离线语音注册',
};

module.exports = { ENGINE_ERR, LOCAL_REASON, LOCAL_REASON_TEXT };
