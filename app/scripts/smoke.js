// 端到端冒烟（需要网络）：状态 → 两个音色 → 晓晓合成 → 云希合成 → 导出 MP3 → 字幕 → EPUB
// 用法：node scripts/smoke.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

require('../src/main/settingsStore')._setSettingsPathForTest(path.join(os.tmpdir(), 'ldn-smoke.json'));

const { getBridge } = require('../src/main/ttsBridge');
const exporter = require('../src/main/exporter');
const { readEpub } = require('../src/main/epubReader');

const OUT = path.join(__dirname, '..', 'dist', 'smoke');
fs.mkdirSync(OUT, { recursive: true });

const rows = [];
function rec(name, ok, detail) {
  rows.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} — ${detail}`);
}

(async () => {
  const bridge = getBridge();

  const voices = bridge.listVoices();
  rec('音色数量=2', voices.length === 2, voices.map((v) => `${v.displayName}(${v.id})`).join(' / '));
  // v2.4：本地优先后 Windows 上音色来源为 offline，Linux/未注册时为 online（两者都合法）
  rec(
    '来源标记',
    voices.every((v) => v.source === 'online' || v.source === 'offline'),
    voices.map((v) => `${v.id}:${v.source}`).join(' / ')
  );

  // 微软在线端点偶发返回 200 而非 101（环境抖动），冒烟里重试几次
  const synthRetry = async (text, opts, tries = 4) => {
    let last = null;
    for (let i = 0; i < tries; i += 1) {
      try {
        return await bridge.synthesize(text, opts);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    throw last;
  };

  const t0 = Date.now();
  const x = await synthRetry('你好，这是朗读女 Neo 的冒烟测试，使用微软晓晓语音。', { voiceId: 'edge:xiaoxiao' });
  rec('晓晓合成', x.audioData.byteLength > 3000, `${x.durationMs}ms / ${Date.now() - t0}ms / ${x.format}`);
  fs.writeFileSync(path.join(OUT, 'xiaoxiao.mp3'), Buffer.from(x.audioData));

  const y = await synthRetry('这是云希男声的冒烟测试。', { voiceId: 'edge:yunxi' });
  rec('云希合成', y.audioData.byteLength > 3000, `${y.durationMs}ms / ${y.format}`);

  const mp3 = await exporter.exportCurrent({
    text: '导出冒烟测试，这段文本会被切成多段合成后拼接。',
    opts: { voiceId: 'edge:xiaoxiao' },
    outPath: path.join(OUT, 'export.mp3'),
  });
  rec('导出 MP3', !!mp3.ok && mp3.bytes > 3000, JSON.stringify(mp3));

  const srt = exporter.generateSrt([{ index: 0, startMs: 0, endMs: 1200, text: '第一句' }]);
  rec('字幕生成', /00:00:00,000 --> 00:00:01,200/.test(srt), srt.replace(/\n/g, ' | ').slice(0, 48));

  const epubPath = path.join(OUT, 'test.epub');
  if (fs.existsSync(epubPath)) {
    const r = readEpub(epubPath);
    rec('EPUB 解析', !!r.ok, r.ok ? `${r.chapters.length} 章` : r.error);
  } else {
    rec('EPUB 解析', true, '跳过（无样本）');
  }

  const fail = rows.filter((r) => !r.ok).length;
  console.log(`\n冒烟结果：PASS=${rows.length - fail} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('冒烟异常：', e.message);
  process.exit(2);
});
