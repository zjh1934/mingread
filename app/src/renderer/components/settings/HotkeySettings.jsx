// 「常用 → 划词朗读热键」：本产品的命门设置（选中文字按热键即读）。
// 从 v2.3 单页展开式里独立成组后，热键状态（已生效 / 被占用）紧跟在输入框右边，
// 不再需要滚动或切换 Tab 才能看到「到底生效了没有」。
import React from 'react';
import { Box, Chip, Stack, TextField, Typography } from '@mui/material';
import { Keyboard } from '@mui/icons-material';
import { fs, su } from '../../theme';
import { SettingGroup, HelpText } from './rows';

const HOTKEY_CHIPS = ['F1', 'Ctrl+Alt+R', 'Ctrl+Alt+F1', 'Shift+F1'];

export default function HotkeySettings({ hotkey, hotkeyOk, hotkeyDraft, setHotkeyDraft, onApply }) {
  return (
    <SettingGroup
      title="划词朗读热键"
      desc="在任意程序选中文字后按该热键即开始朗读。改动立即生效，无需保存。"
    >
      <Box>
        <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <TextField
            size="small"
            label="热键组合"
            value={hotkeyDraft}
            onChange={(e) => setHotkeyDraft(e.target.value)}
            onBlur={() => onApply(hotkeyDraft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onApply(hotkeyDraft);
            }}
            helperText="可直接输入，如 F1、Ctrl+Alt+R；回车或离开输入框即生效"
            FormHelperTextProps={{ sx: { fontSize: fs(13), mx: 0 } }}
            InputProps={{
              startAdornment: <Keyboard sx={{ fontSize: fs(20), mr: 1, color: 'text.secondary' }} />,
            }}
            inputProps={{ 'aria-label': '划词朗读热键组合' }}
            sx={{ width: su(280), maxWidth: '100%' }}
          />
          {hotkeyOk === true && (
            <Chip size="medium" color="success" variant="outlined" label="已生效" sx={{ height: su(44) }} />
          )}
          {hotkeyOk === false && (
            <Chip
              size="medium"
              color="error"
              variant="filled"
              label="注册失败（可能被占用）"
              sx={{ height: su(44) }}
            />
          )}
        </Stack>
      </Box>

      <Box>
        <Typography variant="body2" component="p" sx={{ fontWeight: 600, mb: 0.75 }}>
          常用热键（点一下即切换）
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }} alignItems="center">
          {HOTKEY_CHIPS.map((k) => {
            const active = hotkey === k;
            return (
              <Chip
                key={k}
                size="medium"
                label={k}
                clickable
                onClick={() => onApply(k)}
                color={active ? 'primary' : 'default'}
                variant={active ? 'filled' : 'outlined'}
                aria-pressed={active}
                aria-label={`把热键设为 ${k}${active ? '，当前使用中' : ''}`}
                sx={{ height: su(44), fontSize: fs(14) }}
              />
            );
          })}
        </Stack>
      </Box>

      <HelpText>
        热键被其他程序占用时不会静默失败：右上角会显示「注册失败」并语音提示，请换一个组合或关闭占用它的程序。
      </HelpText>
    </SettingGroup>
  );
}
