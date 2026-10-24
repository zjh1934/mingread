import { useCallback, useState } from 'react';

/** base64 音频 → blob URL（播放器与试听共用；仅用于音频，不能当文本渲染） */
export function b64ToBlobUrl(b64, type = 'audio/mpeg') {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

function api() {
  return typeof window !== 'undefined' ? window.langdu : null;
}

// 渲染进程侧音频出口：试听与导出
export function useTts() {
  const [exporting, setExporting] = useState(false);

  const preview = useCallback(async (voiceId, text) => {
    const voice = api()?.voice;
    if (!voice?.preview) return { ok: false, error: '当前环境不支持试听' };
    try {
      const res = await voice.preview({ voiceId, text: text || '你好，这是音色试听。' });
      if (!res || !res.ok) {
        return { ok: false, error: (res && (res.message || res.error)) || '试听失败' };
      }
      return {
        ok: true,
        audioUrl: b64ToBlobUrl(res.audioData, res.format === 'mp3' ? 'audio/mpeg' : 'audio/wav'),
        durationMs: res.durationMs,
        notice: res.notice,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }, []);

  const exportAudio = useCallback(async (payload) => {
    const bridge = api();
    if (!bridge?.exportAudio) return { ok: false, error: '当前环境不支持导出' };
    setExporting(true);
    try {
      const res = await bridge.exportAudio(payload);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || '导出失败' };
      return res;
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    } finally {
      setExporting(false);
    }
  }, []);

  return { exporting, preview, exportAudio };
}
