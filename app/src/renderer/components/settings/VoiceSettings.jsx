// 「常用 → 音色」：把原本只在主界面气泡里的音色选择，纳入设置面板。
// 数据通道与 App.handleSelectVoice 一致（store + window.langdu.voice.setVoiceId），
// 因此不新增对外 props、也不需要 App 感知设置面板内部结构。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { useSettings } from '../../store/settingsStore';
import { useTts } from '../../hooks/useTts';
import announcer from '../../services/announcer';
import { SettingGroup, HelpText } from './rows';
import VoicePicker from '../VoicePicker';
import VoiceSourceSettings from './VoiceSourceSettings';

function bridge() {
  return typeof window !== 'undefined' ? window.langdu : null;
}

export default function VoiceSettings({ notify }) {
  const voiceStatus = useSettings((s) => s.voiceStatus);
  const voiceId = useSettings((s) => s.voiceId);
  const setStore = useSettings((s) => s.set);
  const { preview } = useTts();

  const [previewingId, setPreviewingId] = useState(null);
  const audioRef = useRef(null);

  const stopPreview = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        a.pause();
      } catch (e) {
        /* 忽略 */
      }
      if (a.src && a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
      audioRef.current = null;
    }
    setPreviewingId(null);
  }, []);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const handleSelect = async (id) => {
    if (!id || id === voiceId) return;
    announcer.cue('press');
    setStore({ voiceId: id });
    try {
      const res = await bridge()?.voice?.setVoiceId?.(id);
      if (res && res.ok === false) throw new Error((res.error && res.error.message) || '主进程未接受该音色');
      const v = (voiceStatus && voiceStatus.voices ? voiceStatus.voices : []).find((x) => x.id === id);
      notify(`已切换到音色「${v ? v.displayName || v.name : id}」`, 'success', { duration: 2200, say: false });
      announcer.announce('voiceChanged', { name: v ? v.displayName || v.name : '' });
    } catch (e) {
      notify(`音色切换失败：${e?.message || e}`, 'error', { priority: 'high' });
    }
  };

  const handlePreview = async (voice) => {
    if (!voice || voice.available === false) return;
    announcer.cue('press');
    stopPreview();
    setPreviewingId(voice.id);
    const res = await preview(voice.id);
    if (!res.ok) {
      setPreviewingId(null);
      notify(`试听失败：${res.error}`, 'error');
      return;
    }
    const audio = new Audio(res.audioUrl);
    audioRef.current = audio;
    const cleanup = () => {
      URL.revokeObjectURL(res.audioUrl);
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPreviewingId(null);
      }
    };
    audio.onended = cleanup;
    audio.onerror = () => {
      cleanup();
      notify('试听音频播放失败', 'error');
    };
    try {
      await audio.play();
    } catch (e) {
      cleanup();
      notify(`试听无法播放：${e?.message || e}`, 'error');
      return;
    }
    if (res.notice) notify(res.notice, 'info', { say: false });
  };

  return (
    <>
      <SettingGroup title="音色" desc="配一次就不再改；试听不改变当前选择">
        <Box>
          <VoicePicker
            status={voiceStatus}
            value={voiceId}
            onChange={handleSelect}
            onPreview={handlePreview}
            previewingId={previewingId}
            inline
          />
        </Box>
        <HelpText>音色只影响朗读使用的声线，语速 / 语调 / 音量在「朗读」分区调整。</HelpText>
      </SettingGroup>

      {/* W-VOICESRC：发音人来源（内置源 + 用户自建仓库），与「一键安装离线语音」共用部署状态机 */}
      <VoiceSourceSettings notify={notify} />
    </>
  );
}
