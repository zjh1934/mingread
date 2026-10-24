// 「关于」分区：版本、引擎状态摘要、错误与状态记录。
// 把 v2.3 的「记录」Tab 并进来：记录是排障信息，跟着「关于/诊断」走比单独占一个一级分区更合理。
import React, { useEffect, useState } from 'react';
import { Box, Button, Chip, Divider, Stack, Typography } from '@mui/material';
import { DeleteSweep } from '@mui/icons-material';
import statusHistory from '../../services/statusHistory';
import { fs, su } from '../../theme';
import { SettingGroup, HelpText } from './rows';

const SEVERITY_LABELS = { error: '错误', warning: '警告', success: '成功', info: '提示' };
const SEVERITY_COLORS = { error: 'error', warning: 'warning', success: 'success', info: 'info' };

function InfoRow({ label, value, hint }) {
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.5, alignItems: 'baseline' }}>
        <Typography variant="body2" sx={{ color: 'text.secondary', minWidth: su(96), fontWeight: 600 }}>
          {label}
        </Typography>
        <Typography variant="body1" sx={{ fontWeight: 600, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>
          {value}
        </Typography>
      </Stack>
      {hint ? <HelpText>{hint}</HelpText> : null}
    </Box>
  );
}

/** 错误/状态历史（基线 P2）：Snackbar 会消失，这里留痕可回看，可清空 */
function HistoryPanel() {
  const [items, setItems] = useState(() => statusHistory.getAll());
  const [confirming, setConfirming] = useState(false);

  useEffect(() => statusHistory.subscribe(setItems), []);

  const handleClear = () => {
    statusHistory.clear();
    setConfirming(false);
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="body1" component="h4" sx={{ flex: 1, fontWeight: 700 }}>
          错误与状态记录
        </Typography>
        {items.length > 0 &&
          (confirming ? (
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
              <Button color="error" variant="contained" onClick={handleClear} sx={{ minHeight: su(44) }}>
                确认清空
              </Button>
              <Button onClick={() => setConfirming(false)} sx={{ minHeight: su(44) }}>
                取消
              </Button>
            </Stack>
          ) : (
            <Button
              variant="outlined"
              startIcon={<DeleteSweep sx={{ fontSize: fs(18) }} />}
              onClick={() => setConfirming(true)}
              sx={{ minHeight: su(44) }}
            >
              清空记录
            </Button>
          ))}
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        提示条几秒后会消失，这里保留最近 {statusHistory.STATUS_HISTORY_MAX} 条记录（含全局异常与热键冲突），重启也不会丢。
      </Typography>

      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
          暂无记录
        </Typography>
      ) : (
        <Stack spacing={1} sx={{ mt: 1.25, maxHeight: su(320), overflowY: 'auto', pr: 0.5 }}>
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
              <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
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
    </Box>
  );
}

export default function AboutSection({ status }) {
  const app = (status && status.app) || {};
  const engine = (status && status.engine) || {};
  const voices = (status && status.voices) || [];

  const engineState = engine.ready === false ? '不可用' : engine.online === false ? '离线' : '可用';

  return (
    <>
      <SettingGroup title="应用信息">
        <InfoRow label="名称" value={app.name || '朗读女 Neo'} />
        <InfoRow label="版本" value={app.version ? `v${app.version}` : '未知（主进程未就绪）'} />
        <Divider />
        <InfoRow
          label="朗读引擎"
          value={engine.label || '未获取到引擎信息'}
          hint={engine.detail || undefined}
        />
        <InfoRow label="引擎状态" value={engineState} />
        <InfoRow label="可用音色" value={voices.length ? `${voices.length} 个` : `${engine.voiceCount || 0} 个（待主进程回传）`} />
        {engine.lastError ? <InfoRow label="最近错误" value={engine.lastError} /> : null}
        <HelpText>
          语音默认走本地 NVSA（离线、百毫秒级），不可用时自动回落到微软 Edge 在线神经语音；状态变差时会主动提示。
        </HelpText>
      </SettingGroup>

      <SettingGroup title="诊断">
        <HistoryPanel />
      </SettingGroup>
    </>
  );
}
