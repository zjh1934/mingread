import React, { useMemo } from 'react';
import { Box, Stack, Button, Typography, Chip, Tooltip, IconButton } from '@mui/material';
import { FolderOpen, DeleteSweep, MenuBook, ExpandMore, ExpandLess, ArticleOutlined } from '@mui/icons-material';
import { fs, su } from '../theme'; // α：px → rem/calc(px*scale)，随字号档位缩放

function readingMinutes(text, rate) {
  const chars = String(text || '').replace(/\s/g, '').length;
  if (!chars) return 0;
  // 中文朗读约 4.5 字/秒，语速 ±50% 线性近似
  const speed = 4.5 * (1 + (Number(rate) || 0) / 100);
  return Math.max(1, Math.round(chars / Math.max(speed, 1) / 60));
}

/**
 * 朗读文本卡片（次级）：低视力用户不打字，文本主要来自导入。
 *  - 默认收起：只占一行，保留「导入」主入口与字数摘要
 *  - 展开后才显示文本框 / 章节目录 / 清空
 */
export default function Editor({
  value,
  onChange,
  onImport,
  onClear,
  chapters,
  bookTitle,
  activeChapter,
  onSelectChapter,
  onSelectAll,
  rate,
  open,
  onToggle,
}) {
  const chars = useMemo(() => String(value || '').replace(/\s/g, '').length, [value]);
  const minutes = useMemo(() => readingMinutes(value, rate), [value, rate]);
  const hasChapters = Array.isArray(chapters) && chapters.length > 0;
  const meta =
    chars > 0 ? `字数 ${chars.toLocaleString('zh-CN')} · 预计约 ${minutes} 分钟` : '还没有文本';

  const toggle = (
    <Tooltip title={open ? '收起文本区' : '展开查看 / 编辑文本'}>
      <IconButton onClick={onToggle} aria-label={open ? '收起文本区' : '展开文本区'} aria-expanded={open}>
        {open ? <ExpandLess sx={{ fontSize: fs(22) }} /> : <ExpandMore sx={{ fontSize: fs(22) }} />}
      </IconButton>
    </Tooltip>
  );

  return (
    <Box
      sx={{
        p: { xs: 1.25, md: 1.5 },
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
        <ArticleOutlined sx={{ fontSize: fs(20), color: 'text.secondary' }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          朗读文本
        </Typography>
        {bookTitle ? (
          <Chip
            size="small"
            icon={<MenuBook sx={{ fontSize: fs(15) }} />}
            label={bookTitle}
            variant="outlined"
            sx={{ maxWidth: su(220) }}
          />
        ) : null}
        <Typography variant="body2" color="text.secondary" noWrap sx={{ display: { xs: 'none', sm: 'block' } }}>
          {meta}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<FolderOpen />} onClick={onImport}>
          导入 txt / md / epub
        </Button>
        {toggle}
      </Stack>

      {/* 小屏把字数摘要放第二行，避免与按钮抢位 */}
      <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'block', sm: 'none' }, mt: 0.5 }}>
        {meta}
      </Typography>

      {open && (
        <Box sx={{ display: 'flex', flexDirection: 'column', mt: 1.5, minHeight: 0 }}>
          {hasChapters && (
            <Box
              sx={{
                mb: 1.5,
                p: 1.25,
                borderRadius: 2,
                bgcolor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  章节目录
                </Typography>
                <Chip size="small" variant="outlined" label={`${chapters.length} 章`} sx={{ height: su(20) }} />
                <Box sx={{ flex: 1 }} />
                <Button size="small" sx={{ minWidth: 0, py: 0, fontSize: fs(13) }} onClick={onSelectAll}>
                  全书
                </Button>
              </Stack>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, maxHeight: su(96), overflowY: 'auto' }}>
                {chapters.map((c, i) => (
                  <Chip
                    key={`${c.title}-${i}`}
                    size="small"
                    clickable
                    label={`${i + 1}. ${c.title || '未命名章节'}`}
                    color={activeChapter === i ? 'primary' : 'default'}
                    variant={activeChapter === i ? 'filled' : 'outlined'}
                    onClick={() => onSelectChapter(i)}
                    sx={{
                      maxWidth: su(240),
                      '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    }}
                  />
                ))}
              </Box>
            </Box>
          )}

          <Box
            component="textarea"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="在此粘贴或输入要朗读的内容，也可以从 txt / md / epub 导入。文本仅在本机处理。"
            spellCheck={false}
            sx={{
              minHeight: su(200),
              width: '100%',
              resize: 'none',
              p: 1.75,
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
              outline: 'none',
              bgcolor: 'background.default',
              color: 'text.primary',
              fontSize: fs(15.5),
              lineHeight: 1.85,
              fontFamily: 'inherit',
              transition: 'border-color .15s',
              '&:focus': { borderColor: 'primary.main' },
            }}
          />

          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {meta}
            </Typography>
            <Typography variant="caption" color="text.disabled" sx={{ display: { xs: 'none', sm: 'block' } }}>
              支持 .txt / .md / .epub，epub 自动解析章节目录
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Tooltip title="清空文本与章节">
              <span>
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<DeleteSweep />}
                  disabled={!value && !hasChapters}
                  onClick={onClear}
                >
                  清空
                </Button>
              </span>
            </Tooltip>
          </Stack>
        </Box>
      )}
    </Box>
  );
}
