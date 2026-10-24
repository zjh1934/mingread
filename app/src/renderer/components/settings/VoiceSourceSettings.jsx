// 「音色源」设置：内置源 + 用户自建仓库（W-VOICESRC）。
//
// 用户诉求（原话）：「拓展性添加发音人这一块，应该有一个接口……发音人到哪装的这些仓库啊、
// 地址啊我自己来建。」所以这里只做三件事：
//   1. 让用户看得见「现在有哪些源、每个源状态如何」（坏源要能一眼看到坏在哪）；
//   2. 让用户自己加/删源（https 清单地址，或本地 .json 文件）；
//   3. 把源里发现的新音色列出来，单个安装（安装走 voiceDeploy 的状态机，最多一次 UAC）。
//
// 无障碍（低视力基线）：
//   · 所有可点目标 ≥44px（su(44)），字号一律 fs()，状态文字与按钮文字都是大号；
//   · 每个源/音色是 role=listitem，按钮 aria-label 带对象名（读屏不会听到一排「删除」）；
//   · 加载中 / 安装进度用 role=status + aria-live，状态变化同时 announcer.say；
//   · 进度不只靠进度条：旁边一定有「第几步 / 百分比」文字。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, LinearProgress, Stack, TextField, Typography } from '@mui/material';
import { Add, DeleteOutline, FolderOpen, Refresh, Download, CheckCircleOutline, ErrorOutline } from '@mui/icons-material';
import announcer from '../../services/announcer';
import { fs, su } from '../../theme';
import { SettingGroup, HelpText } from './rows';

function bridge() {
  try {
    return typeof window !== 'undefined' ? window.langdu : null;
  } catch (e) {
    return null;
  }
}

const KIND_LABEL = { builtin: '内置', url: '网络仓库', file: '本地文件' };

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '大小未知';
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** 单个源的一行：名字 + 类型 + 状态；用户源带删除按钮 */
function SourceRow({ source, onRemove, removing }) {
  const ok = !!source.ok;
  const status = ok
    ? `可用 · ${source.voiceCount} 个音色${source.voices && source.voices.length ? `（${source.voices.join('、')}）` : ''}`
    : `加载失败：${(source.error && source.error.message) || '未知原因'}`;

  return (
    <Box
      role="listitem"
      sx={{ p: 1.25, borderRadius: 2, border: '1px solid', borderColor: ok ? 'divider' : 'error.main', bgcolor: 'background.default' }}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
        <Box sx={{ flex: 1, minWidth: su(180) }}>
          <Stack direction="row" alignItems="center" spacing={0.75} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography variant="body1" component="span" sx={{ fontWeight: 700, fontSize: fs(15) }}>
              {source.name || source.location}
            </Typography>
            <Box
              component="span"
              sx={{
                px: 0.85,
                py: 0.1,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
                color: 'text.secondary',
                fontSize: fs(12.5),
                fontWeight: 700,
                whiteSpace: 'nowrap',
              }}
            >
              {KIND_LABEL[source.kind] || source.kind}
            </Box>
          </Stack>
          <Typography
            variant="body2"
            component="p"
            sx={{ mt: 0.25, fontSize: fs(13), lineHeight: 1.6, color: ok ? 'text.secondary' : 'error.main', wordBreak: 'break-all' }}
          >
            {status}
          </Typography>
          {source.kind !== 'builtin' ? (
            <Typography variant="body2" component="p" sx={{ fontSize: fs(12.5), color: 'text.secondary', wordBreak: 'break-all' }}>
              {source.location}
            </Typography>
          ) : null}
        </Box>
        {source.kind !== 'builtin' ? (
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteOutline sx={{ fontSize: fs(18) }} />}
            onClick={() => onRemove(source)}
            disabled={removing}
            aria-label={`删除音色源 ${source.name || source.location}`}
            sx={{ minHeight: su(44), flex: '0 0 auto' }}
          >
            {removing ? '删除中…' : '删除'}
          </Button>
        ) : null}
      </Stack>
    </Box>
  );
}

/** 源里发现的一个新音色（非内置） */
function VoiceRow({ voice, onInstall, installing, busy }) {
  const files = Array.isArray(voice.files) ? voice.files : [];
  const total = files.reduce((s, f) => s + (Number(f.sizeBytes) || 0), 0);
  const working = installing === voice.key;
  return (
    <Box
      role="listitem"
      sx={{ p: 1.25, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 0.75 }}>
        <Box sx={{ flex: 1, minWidth: su(200) }}>
          <Typography variant="body1" component="p" sx={{ fontWeight: 700, fontSize: fs(15) }}>
            {voice.displayName}
            <Box component="span" sx={{ ml: 1, fontSize: fs(12.5), fontWeight: 600, color: 'text.secondary' }}>
              {voice.key} · {voice.gender === 'male' ? '男声' : voice.gender === 'female' ? '女声' : '中性'} · {voice.locale}
            </Box>
          </Typography>
          <Typography variant="body2" component="p" sx={{ fontSize: fs(13), color: 'text.secondary', lineHeight: 1.6 }}>
            {voice.sourceName ? `来源：${voice.sourceName} · ` : ''}
            引擎：NVSA 本地神经语音 · 约 {sizeText(total)}
            {files.length > 1 ? ` · ${files.length} 个文件` : ''}
          </Typography>
          {voice.license ? (
            <Typography variant="body2" component="p" sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.6 }}>
              授权：{voice.license}
            </Typography>
          ) : null}
        </Box>
        <Button
          variant="contained"
          startIcon={<Download sx={{ fontSize: fs(18) }} />}
          onClick={() => onInstall(voice)}
          disabled={!!busy}
          aria-label={`安装音色 ${voice.displayName}`}
          sx={{ minHeight: su(44), flex: '0 0 auto' }}
        >
          {working ? '安装中…' : '安装'}
        </Button>
      </Stack>
    </Box>
  );
}

export default function VoiceSourceSettings({ notify }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState('');
  const [installingKey, setInstallingKey] = useState('');
  const [deploy, setDeploy] = useState(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (refresh) => {
      const api = bridge();
      if (!api?.voiceSources) {
        setLoadError('当前环境不支持音色源（主进程接口未就绪）');
        return;
      }
      setLoading(true);
      setLoadError('');
      try {
        const res = refresh ? await api.voiceSources.refresh() : await api.voiceSources.list();
        if (!aliveRef.current) return;
        if (!res) throw new Error('主进程没有返回音色源数据');
        setData(res);
        if (res.ok === false) {
          const first = res.errors && res.errors[0];
          setLoadError((first && first.message) || '音色源加载失败');
        }
      } catch (e) {
        if (!aliveRef.current) return;
        setLoadError(`音色源加载失败：${(e && e.message) || e}`);
      } finally {
        if (aliveRef.current) setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // 安装进度：走主进程广播（与首启引导同一个状态机）
  useEffect(() => {
    const api = bridge();
    if (!api?.voiceDeploy) return undefined;
    let off = null;
    try {
      api.voiceDeploy.getState?.().then((s) => {
        if (aliveRef.current) setDeploy(s || null);
      });
      off = api.voiceDeploy.onStateChanged?.((s) => {
        if (aliveRef.current) setDeploy(s || null);
      });
    } catch (e) {
      /* 桥未就绪保持静默 */
    }
    return () => {
      try {
        if (typeof off === 'function') off();
      } catch (e) {
        /* 忽略 */
      }
    };
  }, []);

  const sources = (data && data.sources) || [];
  const voices = useMemo(() => ((data && data.voices) || []).filter((v) => !v.builtin), [data]);
  const warnings = (data && data.warnings) || [];

  const handleAdd = async () => {
    const location = draft.trim();
    if (!location) {
      notify?.('请先填写音色仓库地址（https）或选择本地清单文件', 'warning', { say: false });
      announcer.say('voiceSourceEmpty', '请先填写音色仓库地址，或选择本地清单文件');
      return;
    }
    const api = bridge();
    if (!api?.voiceSources) return;
    setAdding(true);
    try {
      const res = await api.voiceSources.add({ location });
      if (!aliveRef.current) return;
      if (!res || res.ok === false) {
        const msg = (res && res.error && res.error.message) || '添加失败';
        notify?.(`添加音色源失败：${msg}`, 'error', { priority: 'high' });
        announcer.say('voiceSourceAddFailed', `添加音色源失败：${msg}`, { priority: 'high' });
        return;
      }
      setDraft('');
      if (res.result) setData(res.result);
      const src = res.source;
      if (src && src.ok) {
        notify?.(`已添加音色源「${src.name}」，发现 ${src.voiceCount} 个音色`, 'success', { duration: 2600, say: false });
        announcer.say('voiceSourceAdded', `已添加音色源，发现 ${src.voiceCount} 个音色`);
      } else {
        const msg = (src && src.error && src.error.message) || '清单加载失败';
        notify?.(`音色源已保存，但清单加载失败：${msg}`, 'warning', { duration: 6000, say: false });
        announcer.say('voiceSourceAddedBad', `音色源已保存，但清单加载失败：${msg}`, { priority: 'high' });
      }
    } catch (e) {
      notify?.(`添加音色源失败：${(e && e.message) || e}`, 'error', { priority: 'high' });
    } finally {
      if (aliveRef.current) setAdding(false);
    }
  };

  const handlePick = async () => {
    const api = bridge();
    if (!api?.voiceSources?.pickFile) return;
    try {
      const p = await api.voiceSources.pickFile();
      if (!p) return;
      setDraft(p);
      announcer.say('voiceSourcePicked', '已选择本地清单文件，点添加即可生效');
    } catch (e) {
      notify?.(`选择文件失败：${(e && e.message) || e}`, 'error', { priority: 'high' });
    }
  };

  const handleRemove = async (source) => {
    const api = bridge();
    if (!api?.voiceSources) return;
    setRemovingId(source.id);
    try {
      const res = await api.voiceSources.remove(source.id);
      if (!aliveRef.current) return;
      if (!res || res.ok === false) {
        const msg = (res && res.error && res.error.message) || '删除失败';
        notify?.(`删除音色源失败：${msg}`, 'error', { priority: 'high' });
        return;
      }
      notify?.(`已删除音色源「${source.name || source.location}」`, 'success', { duration: 2200, say: false });
      announcer.say('voiceSourceRemoved', '已删除音色源');
      await load(true);
    } catch (e) {
      notify?.(`删除音色源失败：${(e && e.message) || e}`, 'error', { priority: 'high' });
    } finally {
      if (aliveRef.current) setRemovingId('');
    }
  };

  const handleInstall = async (voice) => {
    const api = bridge();
    if (!api?.voiceDeploy?.installVoice) {
      notify?.('当前版本不支持从音色源安装（主进程接口未就绪）', 'error', { priority: 'high' });
      return;
    }
    setInstallingKey(voice.key);
    announcer.say('voiceSourceInstallStart', `开始安装音色${voice.displayName}，需要一次管理员授权`, { priority: 'high' });
    try {
      const r = await api.voiceDeploy.installVoice(voice.key);
      if (!aliveRef.current) return;
      if (r && r.ok) {
        notify?.(`音色「${voice.displayName}」已安装到本机语音库`, 'success', { duration: 4000, say: false });
        announcer.say('voiceSourceInstalled', `音色${voice.displayName}已安装到本机语音库`);
        try {
          await api.voice?.refresh?.();
        } catch (e) {
          /* 状态刷新失败不影响安装结论 */
        }
      } else {
        const msg = (r && r.error && r.error.message) || (r && r.message) || '未知原因';
        notify?.(`音色「${voice.displayName}」安装失败：${msg}`, 'error', { priority: 'high', duration: 8000 });
        announcer.say('voiceSourceInstallFailed', `音色安装失败：${msg}`, { priority: 'high' });
      }
    } catch (e) {
      notify?.(`音色安装失败：${(e && e.message) || e}`, 'error', { priority: 'high' });
    } finally {
      if (aliveRef.current) setInstallingKey('');
    }
  };

  const busyDeploy = !!(deploy && deploy.busy);
  const pct = deploy ? Number(deploy.pct) || 0 : 0;

  return (
    <SettingGroup
      title="音色源"
      desc="发音人从哪来由你决定：内置源之外，可以添加自己维护的仓库地址（JSON 清单）"
    >
      {/* ---- 当前源 ---- */}
      <Box>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75, flexWrap: 'wrap', rowGap: 0.5 }}>
          <Typography variant="body1" component="p" sx={{ fontWeight: 700, flex: 1, minWidth: 0, fontSize: fs(15) }}>
            当前音色源
          </Typography>
          <Button
            variant="outlined"
            startIcon={<Refresh sx={{ fontSize: fs(18) }} />}
            onClick={() => load(true)}
            disabled={loading}
            aria-label="刷新音色源"
            sx={{ minHeight: su(44) }}
          >
            {loading ? '刷新中…' : '刷新'}
          </Button>
        </Stack>

        <Box role="list" aria-label="音色源列表">
          <Stack spacing={1}>
            {sources.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: fs(13) }}>
                {loading ? '正在读取音色源…' : '还没有可用的音色源'}
              </Typography>
            ) : (
              sources.map((s) => (
                <SourceRow key={`${s.kind}:${s.id}`} source={s} onRemove={handleRemove} removing={removingId === s.id} />
              ))
            )}
          </Stack>
        </Box>

        {loadError ? (
          <Typography role="status" sx={{ mt: 1, fontSize: fs(13), color: 'error.main', lineHeight: 1.6 }}>
            {loadError}
          </Typography>
        ) : null}
      </Box>

      {/* ---- 添加源 ---- */}
      <Box>
        <Typography variant="body1" component="p" sx={{ fontWeight: 600, fontSize: fs(14.5), mb: 0.5 }}>
          添加音色源
        </Typography>
        <Stack spacing={1}>
          <TextField
            fullWidth
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://你的仓库/voices.json 或 C:\音色仓库\voices.json"
            size="small"
            inputProps={{
              'aria-label': '音色源地址',
              'aria-describedby': 'voice-source-help',
              style: { fontSize: fs(14.5) },
            }}
            sx={{ '& .MuiInputBase-root': { minHeight: su(44) } }}
          />
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
            <Button
              variant="contained"
              startIcon={<Add sx={{ fontSize: fs(18) }} />}
              onClick={handleAdd}
              disabled={adding}
              aria-label="添加这个音色源"
              sx={{ minHeight: su(44) }}
            >
              {adding ? '添加中…' : '添加'}
            </Button>
            <Button
              variant="outlined"
              startIcon={<FolderOpen sx={{ fontSize: fs(18) }} />}
              onClick={handlePick}
              aria-label="选择本地音色源清单文件"
              sx={{ minHeight: su(44) }}
            >
              选择本地文件
            </Button>
          </Stack>
        </Stack>
      </Box>

      {/* ---- 发现的新音色 ---- */}
      <Box>
        <Typography variant="body1" component="p" sx={{ fontWeight: 700, fontSize: fs(15), mb: 0.75 }}>
          从音色源发现的音色
        </Typography>
        <Box role="list" aria-label="可安装的音色">
          <Stack spacing={1}>
            {voices.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: fs(13), lineHeight: 1.7 }}>
                还没有发现内置以外的音色。内置的晓晓、云希由「一键安装离线语音」负责，不需要在这里装。
              </Typography>
            ) : (
              voices.map((v) => (
                <VoiceRow
                  key={`${v.sourceId}:${v.key}`}
                  voice={v}
                  onInstall={handleInstall}
                  installing={installingKey}
                  busy={!!installingKey || busyDeploy}
                />
              ))
            )}
          </Stack>
        </Box>
      </Box>

      {/* ---- 安装进度（与首启引导共用状态机） ---- */}
      {busyDeploy || installingKey ? (
        <Box role="status" aria-live="polite" aria-atomic="true">
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{ flex: 1, height: su(8), borderRadius: 1 }}
              aria-hidden="true"
            />
            <Typography component="span" sx={{ fontSize: fs(13), fontWeight: 700, whiteSpace: 'nowrap' }}>
              {pct}%
            </Typography>
          </Stack>
          <Typography sx={{ fontSize: fs(13), color: 'text.secondary', lineHeight: 1.6 }}>
            {(deploy && deploy.label) || '正在准备安装…'}
          </Typography>
        </Box>
      ) : null}

      {warnings.length ? (
        <Box>
          {warnings.slice(0, 4).map((w, i) => (
            <Stack key={`${w.code}:${i}`} direction="row" spacing={0.75} alignItems="flex-start" sx={{ mb: 0.25 }}>
              <ErrorOutline sx={{ fontSize: fs(16), color: 'warning.main', mt: '2px' }} />
              <Typography sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.6 }}>{w.message}</Typography>
            </Stack>
          ))}
        </Box>
      ) : null}

      <HelpText id="voice-source-help">
        清单格式（schemaVersion 1）与可复制的模板见程序目录下的 docs/音色源格式.md：只接受 https 地址，每个文件必须写
        sizeBytes，建议写 sha256（写了就强校验）。一个源坏了不影响其他源；删除自己加的源不会卸载已装好的音色。
      </HelpText>

      {installingKey ? (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <CheckCircleOutline sx={{ fontSize: fs(16), color: 'text.secondary' }} />
          <Typography sx={{ fontSize: fs(12.5), color: 'text.secondary', lineHeight: 1.6 }}>
            安装期间请保持网络连接，最多弹一次管理员授权；失败后点「安装」会从断点继续。
          </Typography>
        </Stack>
      ) : null}
    </SettingGroup>
  );
}
