import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// 语音引擎链（本地 NVSA 优先 / Edge 在线兜底）的运行状态，渲染层只读展示
export const EMPTY_VOICE_STATUS = {
  app: { name: '朗读女 Neo', version: '' },
  engine: { id: 'edge', label: '微软 Edge 语音', online: true, ready: false, voiceCount: 0, detail: '', lastError: null },
  voices: [],
  voiceId: '',
};

function normalizeStatus(status, prev) {
  if (!status || typeof status !== 'object') return prev;
  return {
    ...prev,
    app: { ...EMPTY_VOICE_STATUS.app, ...(prev.app || {}), ...(status.app || {}) },
    engine: { ...EMPTY_VOICE_STATUS.engine, ...(prev.engine || {}), ...(status.engine || {}) },
    voices: Array.isArray(status.voices) ? status.voices : prev.voices || [],
  };
}

function api() {
  return typeof window !== 'undefined' ? window.langdu : null;
}

export const useSettings = create(
  persist(
    (set, get) => ({
      // ---- 阅读偏好（持久化）----
      themeMode: 'light', // light | dark
      voiceId: 'edge:xiaoxiao',
      rate: 0,
      pitch: 0,
      volume: 0,

      // ---- 系统设置（主进程权威，仅运行时同步，不持久化）----
      hotkey: 'F1',
      clipboardAuto: true,
      floatBallEnabled: true,
      hotkeyOk: undefined, // undefined=尚未同步；true=已注册；false=被占用

      // ---- 语音状态（不持久化）----
      voiceStatus: EMPTY_VOICE_STATUS,

      set: (patch) => set(patch),

      // 主进程广播/启动下发的系统设置合入 store
      applySystemSettings: (s) => {
        if (!s || typeof s !== 'object') return;
        const patch = {};
        if (typeof s.hotkey === 'string' && s.hotkey) patch.hotkey = s.hotkey;
        if (typeof s.clipboardAuto === 'boolean') patch.clipboardAuto = s.clipboardAuto;
        if (typeof s.floatBallEnabled === 'boolean') patch.floatBallEnabled = s.floatBallEnabled;
        if (typeof s.hotkeyOk === 'boolean') patch.hotkeyOk = s.hotkeyOk;
        if (Object.keys(patch).length) set(patch);
      },

      setVoiceStatus: (status) =>
        set((s) => ({
          voiceStatus: normalizeStatus(status, s.voiceStatus),
          // 主进程是音色选择的权威来源
          voiceId: status.voiceId || s.voiceId,
        })),

      refreshStatus: async () => {
        const voice = api()?.voice;
        if (!voice?.getStatus) return { ok: false, error: '当前环境不支持语音状态' };
        try {
          const status = await voice.getStatus();
          if (!status) return { ok: false, error: '未获取到语音状态' };
          if (status.error) return { ok: false, error: status.error.message || '读取语音状态失败' };
          get().setVoiceStatus(status);
          return { ok: true, status };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      },

      savePrefs: async (patch) => {
        const voice = api()?.voice;
        if (!voice?.savePrefs) return { ok: false, error: '当前环境不支持保存语音设置' };
        try {
          return await voice.savePrefs(patch || {});
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      },
    }),
    {
      name: 'langdu-neo-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 旧版本曾把 hotkey/clipboardAuto 写进 localStorage，迁移时剔除，避免覆盖主进程权威值
      migrate: (persisted) => {
        if (persisted && typeof persisted === 'object') {
          delete persisted.hotkey;
          delete persisted.clipboardAuto;
        }
        return persisted;
      },
      partialize: (s) => ({
        themeMode: s.themeMode,
        voiceId: s.voiceId,
        rate: s.rate,
        pitch: s.pitch,
        volume: s.volume,
      }),
    }
  )
);
