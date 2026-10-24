import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Switch,
  TextField,
  Typography,
  Divider,
  ToggleButtonGroup,
  ToggleButton,
  Box,
  IconButton,
  Chip,
  Tabs,
  Tab,
} from '@mui/material';
import { LightMode, DarkMode, Contrast, Close, Keyboard, ContentPaste, TouchApp, MyLocation, DeleteSweep } from '@mui/icons-material';
import { useSettings } from '../store/settingsStore';
import TuningPanel from './TuningPanel';
import ZoomSettings from './ZoomSettings';
import announcer from '../services/announcer';
import statusHistory from '../services/statusHistory';
import { fs, su, THEME_MODES, THEME_MODE_LABELS } from '../theme'; // α：px → rem/calc，随字号档位缩放

const HOTKEY_CHIPS = ['F1', 'Ctrl+Alt+R', 'Ctrl+Alt+F1', 'Shift+F1'];
const TABS = [
  { key: 'read', label: '朗读' },
  { key: 'hotkey', label: '热键' },
  { key: 'zoom', label: '缩放' },
  { key: 'look', label: '外观' },
  { key: 'log', label: '记录' },
];

const SEVERITY_LABELS = { error: '错误', warning: '警告', success: '成功', info: '提示' };
const SEVERITY_COLORS = { error: 'error', warning: 'warning', success: 'success', info: 'info' };
const THEME_ICONS = { light: <LightMode sx={{ fontSize: fs(18), mr: 0.75 }} />, dark: <DarkMode sx={{ fontSize: fs(18), mr: 0.75 }} />, hc: <Contrast sx={{ fontSize: fs(18), mr: 0.75 }} /> };

function SectionTitle({ children }) {
  return (
    <Typography variant="subtitle2" sx={{ color: 'text.secondary', letterSpacing: 0.4, fontSize: fs(12.5) }}>
      {children}
    </Typography>
  );
}

function Row({ icon, title, desc, control }) {
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1}>
        {icon}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2">{title}</Typography>
          {desc ? (
            <Typography variant="caption" color="text.secondary">
              {desc}
            </Typography>
          ) : null}
        </Box>
        {control}
      </Stack>
    </Box>
  );
}

/** 错误/状态历史面板（基线 P2）：Snackbar 会消失，这里留痕可回看，可清空 */
function HistoryPanel() {
  const [items, setItems] = useState(() => statusHistory.getAll());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => statusHistory.subscribe(setItems), []);

  const handleClear = () => {
    statusHistory.clear();
    setConfirming(false);
  };

  return (
    <Stack spacing={1.25}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="body2" sx={{ flex: 1, fontWeight: 600 }}>
          错误与状态记录
        </Typography>
        {items.length > 0 &&
          (confirming ? (
            <Stack direction="row" spacing={0.5}>
              <Button size="small" color="error" variant="contained" onClick={handleClear}>
                确认清空
              </Button>
              <Button size="small" onClick={() => setConfirming(false)}>
                取消
              </Button>
            </Stack>
          ) : (
            <Button
              size="small"
              variant="outlined"
              startIcon={<DeleteSweep sx={{ fontSize: fs(16) }} />}
              onClick={() => setConfirming(true)}
            >
              清空记录
            </Button>
          ))}
      </Stack>
      <Typography variant="caption" color="text.secondary">
        提示条几秒后会消失，这里保留最近 {statusHistory.STATUS_HISTORY_MAX} 条记录（含全局异常与热键冲突），重启也不会丢。
      </Typography>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
          暂无记录
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ maxHeight: su(360), overflowY: 'auto', pr: 0.5 }}>
          {items.map((it) => (
            <Box
              key={it.id}
              sx={{
                p: 1.25,
                borderRadius: 2,
                border: '1px solid',
                borderColor: it.severity === 'error' ? 'error.main' : 'divider',
                bgcolor: 'background.paper',
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  size="small"
                  label={SEVERITY_LABELS[it.severity] || '提示'}
                  color={SEVERITY_COLORS[it.severity] || 'info'}
                  variant={it.severity === 'error' ? 'filled' : 'outlined'}
                  sx={{ flexShrink: 0 }}
                />
                <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {statusHistory.formatTime(it.time)}
                </Typography>
                {it.source ? (
                  <Typography variant="caption" color="text.secondary">
                    · {it.source}
                  </Typography>
                ) : null}
              </Stack>
              <Typography variant="body2" sx={{ mt: 0.5, wordBreak: 'break-word' }}>
                {it.message}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

export default function SettingsDialog({ open, onClose, status, notify }) {
  const themeMode = useSettings((s) => s.themeMode);
  const hotkey = useSettings((s) => s.hotkey);
  const hotkeyOk = useSettings((s) => s.hotkeyOk);
  const clipboardAuto = useSettings((s) => s.clipboardAuto);
  const floatBallEnabled = useSettings((s) => s.floatBallEnabled);
  const rate = useSettings((s) => s.rate);
  const pitch = useSettings((s) => s.pitch);
  const volume = useSettings((s) => s.volume);
  const set = useSettings((s) => s.set);
  const savePrefs = useSettings((s) => s.savePrefs);

  const [tab, setTab] = useState(0);
  const [hotkeyDraft, setHotkeyDraft] = useState(hotkey);
  const prefTimerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setHotkeyDraft(hotkey);
  }, [open, hotkey]);

  useEffect(
    () => () => {
      if (prefTimerRef.current) clearTimeout(prefTimerRef.current);
    },
    []
  );

  const appInfo = (status && status.app) || {};

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

  const handleResetBallPos = async () => {
    try {
      const res = await saveSystemSettings({ floatBallPos: null });
      if (res && res.ok === false) throw new Error(res.error || '重置失败');
      pushLog('悬浮球位置已重置', 'success', { duration: 2200 });
    } catch (e) {
      pushLog(`重置悬浮球位置失败：${e?.message || e}`, 'error', { priority: 'high' });
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ pb: 0 }}>
        <Stack direction="row" alignItems="center">
          <Box sx={{ flex: 1 }}>
            <Typography variant="h6" component="div">
              设置
            </Typography>
            <Typography variant="caption" color="text.secondary">
              朗读女 Neo {appInfo.version ? `v${appInfo.version}` : ''} · 改动即时生效
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="关闭">
            <Close fontSize="small" />
          </IconButton>
        </Stack>
      </DialogTitle>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="fullWidth"
        sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}
      >
        {TABS.map((t) => (
          <Tab key={t.key} label={t.label} />
        ))}
      </Tabs>

      <DialogContent dividers sx={{ minHeight: 320 }}>
        {TABS[tab].key === 'read' && (
          <Stack spacing={1.5}>
            <TuningPanel rate={rate} pitch={pitch} volume={volume} onChange={applyTuning} />
            <Divider />
            <Row
              icon={<ContentPaste sx={{ fontSize: fs(16), color: 'text.secondary' }} />}
              title="复制文本后自动朗读"
              desc="开启后：在任何程序复制文字会自动朗读；默认关闭"
              control={
                <Switch
                  checked={clipboardAuto}
                  onChange={(e) => toggleSystemFlag('clipboardAuto', e.target.checked, '复制即读')}
                />
              }
            />
          </Stack>
        )}

        {TABS[tab].key === 'hotkey' && (
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            <SectionTitle>划词朗读热键</SectionTitle>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              <TextField
                size="small"
                label="热键"
                value={hotkeyDraft}
                onChange={(e) => setHotkeyDraft(e.target.value)}
                onBlur={() => applyHotkey(hotkeyDraft)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') applyHotkey(hotkeyDraft);
                }}
                InputProps={{
                  startAdornment: <Keyboard sx={{ fontSize: fs(18), mr: 1, color: 'text.secondary' }} />,
                }}
                sx={{ width: su(220) }}
              />
              {hotkeyOk === true && (
                <Chip size="small" color="success" variant="outlined" label="✅ 已生效" />
              )}
              {hotkeyOk === false && (
                <Chip size="small" color="error" variant="outlined" label="⚠️ 注册失败（被占用）" />
              )}
            </Stack>
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }} alignItems="center">
              <Typography variant="caption" color="text.secondary">
                快捷：
              </Typography>
              {HOTKEY_CHIPS.map((k) => (
                <Chip
                  key={k}
                  size="small"
                  label={k}
                  onClick={() => applyHotkey(k)}
                  color={hotkey === k ? 'primary' : 'default'}
                  variant={hotkey === k ? 'filled' : 'outlined'}
                />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              在任意程序选中文字后按该热键即开始朗读；改动立即生效，无需保存。
            </Typography>
          </Stack>
        )}

        {TABS[tab].key === 'zoom' && <ZoomSettings notify={pushLog} />}

        {TABS[tab].key === 'look' && (
          <Stack spacing={1.75} sx={{ mt: 0.5 }}>
            <Box>
              <SectionTitle>主题</SectionTitle>
              <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
                <ToggleButtonGroup
                  exclusive
                  size="medium"
                  value={themeMode}
                  onChange={(_, v) => applyTheme(v)}
                  sx={{ flexWrap: 'wrap' }}
                >
                  {THEME_MODES.map((m) => (
                    <ToggleButton key={m} value={m} sx={{ px: 2.5, py: 1 }}>
                      {THEME_ICONS[m] || null}
                      {THEME_MODE_LABELS[m] || m}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Stack>
            </Box>

            <Divider />

            <Row
              icon={<TouchApp sx={{ fontSize: fs(16), color: 'text.secondary' }} />}
              title="启用桌面悬浮球"
              desc="单击朗读当前选中文字，可拖动位置"
              control={
                <Switch
                  checked={floatBallEnabled}
                  onChange={(e) => toggleSystemFlag('floatBallEnabled', e.target.checked, '桌面悬浮球')}
                />
              }
            />
            <Box>
              <Button
                size="small"
                variant="outlined"
                startIcon={<MyLocation sx={{ fontSize: fs(16) }} />}
                onClick={handleResetBallPos}
              >
                重置位置
              </Button>
            </Box>
          </Stack>
        )}

        {TABS[tab].key === 'log' && <HistoryPanel />}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5, justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">
          所有改动即时生效并自动保存
        </Typography>
        <Button variant="contained" onClick={onClose}>
          完成
        </Button>
      </DialogActions>
    </Dialog>
  );
}
