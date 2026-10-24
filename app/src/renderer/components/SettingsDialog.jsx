import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Box,
  IconButton,
} from '@mui/material';
import { Close, Bolt, MenuBook, ZoomIn, AccessibilityNew, Info, ContentPaste } from '@mui/icons-material';
import { useSettings } from '../store/settingsStore';
import ZoomSettings from './ZoomSettings';
import announcer from '../services/announcer';
import statusHistory from '../services/statusHistory';
import { fs, su, THEME_MODE_LABELS } from '../theme'; // α：px → rem/calc，随字号档位缩放
import SectionTabs from './settings/SectionTabs';
import HotkeySettings from './settings/HotkeySettings';
import VoiceSettings from './settings/VoiceSettings';
import ReadingSettings from './settings/ReadingSettings';
import A11ySettings from './settings/A11ySettings';
import AboutSection from './settings/AboutSection';
import { SettingGroup, SwitchRow, HelpText } from './settings/rows';
import { hydrateAnnouncePref } from './settings/announcePref';

// 启动即补水「语音播报」开关（模块初始化时执行一次，不依赖对话框是否打开）
hydrateAnnouncePref();

/**
 * 设置面板分区（v2.4.0 W-UI1 IA 重构）。
 * 归类原则：按「多久用一次 + 出问题时先找谁」排，而不是按实现模块排。
 *   常用：改一次影响全局、且出事就没法用的（热键 / 复制即读 / 音色）
 *   朗读：日常调音（语速语调音量）+ 睡前场景（定时关闭）
 *   缩放：LensZoom 全部参数
 *   无障碍：看不清时的总开关（字号 / 对比度 / 语音提示 / 悬浮球）
 *   关于：版本、引擎摘要、排障记录
 */
const SECTIONS = [
  { key: 'common', label: '常用', icon: <Bolt sx={{ fontSize: fs(20) }} /> },
  { key: 'read', label: '朗读', icon: <MenuBook sx={{ fontSize: fs(20) }} /> },
  { key: 'zoom', label: '缩放', icon: <ZoomIn sx={{ fontSize: fs(20) }} /> },
  { key: 'a11y', label: '无障碍', icon: <AccessibilityNew sx={{ fontSize: fs(20) }} /> },
  { key: 'about', label: '关于', icon: <Info sx={{ fontSize: fs(20) }} /> },
];

const sectionLabel = (key) => (SECTIONS.find((s) => s.key === key) || SECTIONS[0]).label;

export default function SettingsDialog({ open, onClose, status, notify, playback }) {
  const themeMode = useSettings((s) => s.themeMode);
  const hotkey = useSettings((s) => s.hotkey);
  const hotkeyOk = useSettings((s) => s.hotkeyOk);
  const clipboardAuto = useSettings((s) => s.clipboardAuto);
  const hotkeyCue = useSettings((s) => s.hotkeyCue);
  const rate = useSettings((s) => s.rate);
  const pitch = useSettings((s) => s.pitch);
  const volume = useSettings((s) => s.volume);
  const set = useSettings((s) => s.set);
  const savePrefs = useSettings((s) => s.savePrefs);

  const [section, setSection] = useState('common');
  const [hotkeyDraft, setHotkeyDraft] = useState(hotkey);
  const prefTimerRef = useRef(null);
  const openedRef = useRef(false);
  const sectionRef = useRef(section);
  sectionRef.current = section;

  useEffect(() => {
    if (open) setHotkeyDraft(hotkey);
  }, [open, hotkey]);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    // 打开即播报「在哪个分区」，读屏/看不清的用户不用先扫一遍才知道身在何处
    announcer.say('settingsOpened', `设置已打开，当前是${sectionLabel(sectionRef.current)}分区`);
  }, [open]);

  useEffect(
    () => () => {
      if (prefTimerRef.current) clearTimeout(prefTimerRef.current);
    },
    []
  );

  // 系统设置统一经主进程保存；主进程保存后会广播新设置，store 自动同步
  const saveSystemSettings = async (patch) => {
    const api = typeof window !== 'undefined' ? window.langdu : null;
    if (!api?.saveSystemSettings) throw new Error('当前环境不支持保存系统设置');
    return await api.saveSystemSettings(patch);
  };

  /** 反馈统一入口：先入历史面板（可回看），再走 App 的 Snackbar + 语音播报 */
  const pushLog = useCallback(
    (message, severity = 'info', opts = {}) => {
      statusHistory.record(message, { severity, source: 'settings' });
      notify(message, severity, opts);
    },
    [notify]
  );

  /** 分区切换：视觉（选中态）+ 语音（分区名）双通道，且保持焦点在 Tab 上 */
  const handleSectionChange = useCallback((key) => {
    if (sectionRef.current === key) return;
    sectionRef.current = key;
    setSection(key);
    announcer.say('settingsSection', `设置：${sectionLabel(key)}分区`);
  }, []);

  /** 统一的即时生效模型：改了就存，存完给一次「已保存」的视觉 + 语音确认 */
  const toggleSystemFlag = async (key, value, label) => {
    const prev = useSettings.getState()[key];
    set({ [key]: value }); // 乐观更新，失败回滚
    try {
      const res = await saveSystemSettings({ [key]: value });
      if (res && res.ok === false) throw new Error(res.error || '保存失败');
      pushLog(`${label}已${value ? '开启' : '关闭'}`, 'success', { duration: 2200, say: false });
      announcer.announce('flagToggled', { label, value });
    } catch (e) {
      set({ [key]: prev });
      pushLog(`${label}设置失败：${e?.message || e}`, 'error', { priority: 'high' });
    }
  };

  const applyHotkey = useCallback(
    async (nextRaw) => {
      const next = String(nextRaw || '').trim() || 'F1';
      if (next === hotkey) return;
      setHotkeyDraft(next);
      try {
        const r = await saveSystemSettings({ hotkey: next });
        if (r && r.ok === false) throw new Error(r.error || '热键保存失败');
        const ok = r && r.hotkeyOk;
        if (ok === false) {
          pushLog(`热键 ${next} 注册失败，可能已被其他程序占用`, 'warning', { say: false, duration: 6000 });
          announcer.announce('hotkeyFailed', {}, { priority: 'high' });
        } else {
          pushLog(`热键已改为 ${next}`, 'success', { duration: 2200, say: false });
          announcer.announce('hotkeyChanged', { hotkey: next });
        }
      } catch (e) {
        setHotkeyDraft(hotkey);
        pushLog(`热键设置失败：${e?.message || e}`, 'error', { priority: 'high' });
      }
    },
    [hotkey, pushLog]
  );

  const applyTheme = (mode) => {
    if (!mode || mode === themeMode) return;
    set({ themeMode: mode });
    pushLog(`已切换到${THEME_MODE_LABELS[mode] || '新'}主题`, 'success', { duration: 2200, say: false });
    // 预置文案只认 dark/light，hc 会误报「浅色」——这里直接用准确文本播报
    announcer.say('themeChanged', `已切换到${THEME_MODE_LABELS[mode] || '新'}主题`);
  };

  /** 朗读参数：即时生效 + 防抖落盘，落盘后给一次「已保存」确认 */
  const applyTuning = (patch) => {
    set(patch);
    if (prefTimerRef.current) clearTimeout(prefTimerRef.current);
    prefTimerRef.current = setTimeout(async () => {
      prefTimerRef.current = null;
      const st = useSettings.getState();
      try {
        const res = await savePrefs({ rate: st.rate, pitch: st.pitch, volume: st.volume });
        if (res && res.ok === false) throw new Error(res.error || '偏好保存失败');
        pushLog('朗读参数已保存', 'success', { duration: 1800, say: false });
        announcer.announce('saved');
      } catch (e) {
        pushLog(`朗读参数保存失败：${e?.message || e}`, 'error', { priority: 'high' });
      }
    }, 1200);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="settings-dialog-title"
      PaperProps={{ sx: { maxHeight: '92vh' } }}
    >
      <DialogTitle id="settings-dialog-title" sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="h5" component="div">
              设置
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              按分区查找 · 改动即时生效
            </Typography>
          </Box>
          <IconButton onClick={onClose} aria-label="关闭设置">
            <Close sx={{ fontSize: fs(22) }} />
          </IconButton>
        </Stack>
      </DialogTitle>

      <SectionTabs sections={SECTIONS} value={section} onChange={handleSectionChange} />

      <DialogContent
        dividers
        sx={{ minHeight: su(320), overflowX: 'hidden' }}
        id={`settings-panel-${section}`}
        role="tabpanel"
        aria-labelledby={`settings-tab-${section}`}
        tabIndex={0}
      >
        <Stack spacing={1.75} sx={{ pt: 0.5 }}>
          {section === 'common' && (
            <>
              <HotkeySettings
                hotkey={hotkey}
                hotkeyOk={hotkeyOk}
                hotkeyDraft={hotkeyDraft}
                setHotkeyDraft={setHotkeyDraft}
                onApply={applyHotkey}
                hotkeyCue={hotkeyCue}
                onToggleCue={(next) => toggleSystemFlag('hotkeyCue', next, '热键提示音')}
              />

              <SettingGroup title="快速朗读" desc="不选中文字也能读：复制或按热键读剪贴板">
                <SwitchRow
                  id="clipboard-auto"
                  label="复制文本后自动朗读"
                  desc="开启后：在任何程序复制文字会自动朗读；默认开启，适合经常要读屏幕文字的场景"
                  checked={clipboardAuto}
                  onChange={(e) => toggleSystemFlag('clipboardAuto', e, '复制即读')}
                />
                <HelpText>
                  关掉后仍可从托盘菜单「朗读剪贴板」主动朗读剪贴板内容，不会误读你随手复制的东西。
                </HelpText>
              </SettingGroup>

              <VoiceSettings notify={pushLog} />
            </>
          )}

          {section === 'read' && (
            <ReadingSettings
              rate={rate}
              pitch={pitch}
              volume={volume}
              onTuningChange={applyTuning}
              playback={playback}
            />
          )}

          {section === 'zoom' && (
            <SettingGroup
              title="屏幕缩放（复刻 macOS 缩放）"
              desc="滚轮或热键放大屏幕局部；放大后按 Ctrl+Alt+方向键可平移画面"
            >
              <ZoomSettings notify={pushLog} />
            </SettingGroup>
          )}

          {section === 'a11y' && (
            <A11ySettings notify={pushLog} onThemeChange={applyTheme} onToggleFlag={toggleSystemFlag} />
          )}

          {section === 'about' && <AboutSection status={status} />}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: { xs: 2, sm: 3 }, py: 1.5, justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: su(180) }}>
          改动即时生效并自动保存 · 按 Esc 关闭
        </Typography>
        <Button variant="contained" onClick={onClose} sx={{ minHeight: su(44) }}>
          完成
        </Button>
      </DialogActions>
    </Dialog>
  );
}
