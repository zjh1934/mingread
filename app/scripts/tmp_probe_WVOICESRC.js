// W-VOICESRC 探针：音色源清单的校验 / 逐源降级 / 合并顺序 + 部署计划零回归比对。
//
// 不联网、不写注册表、不下载：假 fetch + 临时目录里的本地清单，
// 全部是纯内存/临时文件断言，任何机器上都能跑。
//
// 用法：node scripts/tmp_probe_WVOICESRC.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const V = require('../src/main/voiceSources');
const S = require('../src/main/voicePackSources');
const { VoiceDeploy } = require('../src/main/voiceDeploy');

const CASES = [];
function record(name, pass, detail) {
  CASES.push({ case: name, pass: !!pass, detail });
}

const SHA = 'a'.repeat(64);

function validManifest(over) {
  const m = {
    schemaVersion: 1,
    name: '探针仓库',
    voices: [
      {
        key: 'probevoice',
        displayName: '探针音色',
        gender: 'female',
        locale: 'zh-CN',
        engine: 'nvsa-sapi',
        requires: ['nvsa'],
        files: [
          {
            url: 'https://example.com/voices/Probe.Voice.1.0.msix',
            urls: ['https://mirror.example.com/voices/Probe.Voice.1.0.msix'],
            sizeBytes: 1024,
            sha256: SHA,
          },
        ],
        license: '测试用',
        homepage: 'https://example.com',
      },
    ],
  };
  return Object.assign(m, over || {});
}

function codes(res) {
  return (res.errors || []).map((e) => e.code);
}

// ---------------------------------------------------------------- ① 合法清单
{
  const res = V.validateManifest(validManifest());
  const v = res.ok ? res.manifest.voices[0] : null;
  record('① 合法清单通过', res.ok && v && v.key === 'probevoice' && v.files[0].dirName === 'Probe.Voice.1.0' && v.files[0].urls.length === 2, {
    ok: res.ok,
    errors: res.errors,
    dirName: v && v.files[0].dirName,
    urls: v && v.files[0].urls,
  });
}

// ---------------------------------------------------------------- ② 逐条拒绝
{
  // http
  const m = validManifest();
  m.voices[0].files[0].url = 'http://example.com/a.msix';
  const r = V.validateManifest(m);
  record('②-1 http 被拒', !r.ok && codes(r).indexOf('FILE_URL') >= 0, r.errors);

  // 缺 sizeBytes
  const m2 = validManifest();
  delete m2.voices[0].files[0].sizeBytes;
  const r2 = V.validateManifest(m2);
  record('②-2 缺 sizeBytes 被拒', !r2.ok && codes(r2).indexOf('FILE_SIZE') >= 0, r2.errors);

  // sizeBytes 写成字符串
  const m2b = validManifest();
  m2b.voices[0].files[0].sizeBytes = '1024';
  const r2b = V.validateManifest(m2b);
  record('②-3 sizeBytes 非数字被拒', !r2b.ok && codes(r2b).indexOf('FILE_SIZE') >= 0, r2b.errors);

  // URL 路径穿越
  const m3 = validManifest();
  m3.voices[0].files[0].url = 'https://example.com/a/../../etc/x.msix';
  m3.voices[0].files[0].urls = [];
  const r3 = V.validateManifest(m3);
  record('②-4 URL 路径穿越被拒', !r3.ok && codes(r3).indexOf('FILE_URL') >= 0, r3.errors);

  // URL 编码的路径穿越
  const m3b = validManifest();
  m3b.voices[0].files[0].url = 'https://example.com/a/%2e%2e/x.msix';
  m3b.voices[0].files[0].urls = [];
  const r3b = V.validateManifest(m3b);
  record('②-5 编码穿越（%2e%2e）被拒', !r3b.ok && codes(r3b).indexOf('FILE_URL') >= 0, r3b.errors);

  // fileName 穿越
  const m4 = validManifest();
  m4.voices[0].files[0].fileName = '../evil.msix';
  const r4 = V.validateManifest(m4);
  record('②-6 fileName 路径穿越被拒', !r4.ok && codes(r4).indexOf('FILE_NAME') >= 0, r4.errors);

  // key 重复
  const m5 = validManifest();
  m5.voices.push(JSON.parse(JSON.stringify(m5.voices[0])));
  m5.voices[1].files[0].url = 'https://example.com/voices/Other.1.0.msix';
  m5.voices[1].files[0].fileName = 'Other.1.0.msix';
  const r5 = V.validateManifest(m5);
  record('②-7 key 重复被拒', !r5.ok && codes(r5).indexOf('VOICE_KEY_DUPLICATE') >= 0, r5.errors);

  // sha256 格式
  const m6 = validManifest();
  m6.voices[0].files[0].sha256 = 'tooshort';
  const r6 = V.validateManifest(m6);
  record('②-8 sha256 格式错被拒', !r6.ok && codes(r6).indexOf('FILE_SHA256') >= 0, r6.errors);

  // 远端清单里出现 file://
  const m7 = validManifest();
  m7.voices[0].files[0].url = 'file:///C:/voices/a.msix';
  m7.voices[0].files[0].urls = [];
  const r7 = V.validateManifest(m7, { allowLocal: false });
  record('②-9 远端清单 file:// 被拒', !r7.ok && codes(r7).indexOf('FILE_URL') >= 0, r7.errors);

  // 本地清单里允许 file://
  const r8 = V.validateManifest(m7, { allowLocal: true });
  record('②-10 本地清单 file:// 允许', r8.ok, r8.errors);

  // schemaVersion 不匹配
  const r9 = V.validateManifest(validManifest({ schemaVersion: 2 }));
  record('②-11 schemaVersion≠1 被拒', !r9.ok && codes(r9).indexOf('SCHEMA_VERSION') >= 0, r9.errors);

  // 保留 key
  const m10 = validManifest();
  m10.voices[0].key = 'system';
  const r10 = V.validateManifest(m10);
  record('②-12 保留 key「system」被拒', !r10.ok && codes(r10).indexOf('VOICE_KEY_RESERVED') >= 0, r10.errors);

  // 不支持的 engine
  const m11 = validManifest();
  m11.voices[0].engine = 'azure-rest';
  const r11 = V.validateManifest(m11);
  record('②-13 不支持的 engine 被拒', !r11.ok && codes(r11).indexOf('VOICE_ENGINE') >= 0, r11.errors);

  // 添加源的入口也拒绝 http
  const add = V.makeSourceEntry({ location: 'http://example.com/voices.json' });
  record('②-14 添加源拒绝 http', !add.ok && add.error.code === V.SOURCE_ERRORS.ENTRY_INVALID, add.error);
}

// ---------------------------------------------------------------- ③ 逐源降级
async function degradation() {
  const good = validManifest();
  const entries = [
    { id: 'bad1', kind: 'url', location: 'https://bad.example.com/voices.json' },
    { id: 'bad2', kind: 'url', location: 'https://bad2.example.com/voices.json' },
    { id: 'good1', kind: 'url', location: 'https://good.example.com/voices.json' },
  ];
  const fetchImpl = async (url) => {
    if (String(url).indexOf('good.example.com') >= 0) {
      return { ok: true, status: 200, text: async () => JSON.stringify(good) };
    }
    if (String(url).indexOf('bad2.') >= 0) {
      // 第二个坏源：HTTP 200 但 JSON 坏了 + 字段不合规
      const broken = validManifest();
      delete broken.voices[0].files[0].sizeBytes;
      return { ok: true, status: 200, text: async () => JSON.stringify(broken) };
    }
    throw new Error('模拟断网');
  };
  const res = await V.loadSources({ entries, fetchImpl, noCache: true });
  const byId = {};
  res.sources.forEach((s) => {
    byId[s.id] = s;
  });
  const goodOk = byId.good1 && byId.good1.ok && byId.good1.voiceCount === 1;
  const bad1Bad = byId.bad1 && !byId.bad1.ok && byId.bad1.error.code === V.SOURCE_ERRORS.FETCH;
  const bad2Bad = byId.bad2 && !byId.bad2.ok && byId.bad2.error.code === V.SOURCE_ERRORS.SCHEMA;
  const stillBuiltin = res.voices.find((v) => v.key === 'xiaoxiao');
  record('③ 一个坏源不影响好源', goodOk && bad1Bad && bad2Bad && !!stillBuiltin && res.errors.length === 2, {
    sources: res.sources.map((s) => ({ id: s.id, ok: s.ok, code: s.error && s.error.code })),
    errors: res.errors.length,
    voiceKeys: res.voices.map((v) => v.key),
  });

  // 用户源覆盖内置同 key
  const override = validManifest();
  override.name = '覆盖仓库';
  override.voices[0].key = 'xiaoxiao';
  override.voices[0].displayName = '晓晓（我的镜像）';
  override.voices[0].files[0].url = 'https://example.com/voices/Xiaoxiao.Mirror.msix';
  override.voices[0].files[0].urls = [];
  override.voices[0].files[0].sizeBytes = 123;
  delete override.voices[0].files[0].sha256;
  const res2 = await V.loadSources({
    entries: [{ id: 'mine', kind: 'url', location: 'https://mine.example.com/voices.json' }],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(override) }),
    noCache: false,
  });
  const x = res2.voices.find((v) => v.key === 'xiaoxiao');
  const y = res2.voices.find((v) => v.key === 'yunxi');
  record(
    '④ 合并顺序（用户源覆盖内置）',
    x && x.displayName === '晓晓（我的镜像）' && x.builtin === false && x.overrides === 'builtin' && y && y.builtin === true,
    {
      xiaoxiao: x && { name: x.displayName, source: x.sourceId, builtin: x.builtin, overrides: x.overrides, size: x.files[0].sizeBytes },
      yunxi: y && { builtin: y.builtin, source: y.sourceId },
      warnings: res2.warnings,
    }
  );

  // 缓存生效：findVoiceSync 能取到用户覆盖项
  const hit = V.findVoiceSync('xiaoxiao');
  record('④-2 findVoiceSync 命中缓存（覆盖项）', !!hit && hit.displayName === '晓晓（我的镜像）' && hit.sourceId === 'mine', hit && hit.displayName);

  return res2;
}

// ---------------------------------------------------------------- ⑤ 部署计划零回归
function planRegression() {
  const dep = new VoiceDeploy({ announce: async () => {}, emit: () => {} });
  try {
    // 故意先跑过「用户源覆盖 xiaoxiao」：一键安装仍必须用内置 pin（缓存不得影响它）
    const plan = dep._plan(null, { builtinOnly: true });
    const old = S.downloadTargets();
    const pick = (t) => ({ id: t.id, label: t.label, urls: t.urls, fileName: t.fileName, sizeBytes: t.sizeBytes });
    const same = JSON.stringify(plan.targets.map(pick)) === JSON.stringify(old.map(pick));
    const sameTotal = plan.totalBytes === S.TOTAL_BYTES;
    const sameDirs =
      JSON.stringify(plan.voices.map((v) => v.dirName)) ===
      JSON.stringify(S.VOICE_PACKS.map((p) => S.msixDirName(p)));
    record('⑤ 内置源安装目标与改造前逐字段等价（且不受用户覆盖影响）', same && sameTotal && sameDirs && plan.default === true, {
      same,
      sameTotal,
      sameDirs,
      planDefault: plan.default,
      targets: plan.targets.map((t) => `${t.id}:${t.sizeBytes}`),
      oldTargets: old.map((t) => `${t.id}:${t.sizeBytes}`),
      total: plan.totalBytes,
    });

    // 单音色计划（走缓存里的用户覆盖项）
    const one = dep._plan(['xiaoxiao']);
    record(
      '⑤-2 单音色计划按清单取文件',
      one.targets.length === 2 &&
        one.targets[1].sizeBytes === 123 &&
        one.targets[1].fileName === 'Xiaoxiao.Mirror.msix' &&
        one.default === false,
      { targets: one.targets.map((t) => ({ id: t.id, fileName: t.fileName, size: t.sizeBytes })) }
    );

    // 未知 key：不改状态、不 busy、不抛
    const stateBefore = dep.state;
    return dep
      .installVoice('no_such_voice')
      .then((r) => {
        record(
          '⑤-3 未知音色被拒绝且不改状态',
          r.ok === false && r.code === 'VOICE_UNKNOWN' && dep.state === stateBefore && dep.busy === false,
          { code: r.code, state: dep.state, message: r.message }
        );
      })
      .finally(() => dep.dispose());
  } catch (e) {
    dep.dispose();
    record('⑤ 内置源安装目标与改造前逐字段等价（且不受用户覆盖影响）', false, { error: e.message });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------- ⑦ 按清单下载 + 解压（不联网、不提权）
// 只跑 download/extract 两段：注册与写配置需要 UAC / 注册表，探针绝不碰。
// 目的：证明「安装目标确实来自 manifest 的 files」，而不是函数里写死的常量。

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data || '', 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x800, 6);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    locals.push(lfh, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const body = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

function responseWith(buf) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (k) => (String(k).toLowerCase() === 'content-length' ? String(buf.length) : null),
    },
    // eslint-disable-next-line func-names
    body: (async function* () {
      yield buf;
    })(),
  };
}

async function installPath() {
  const crypto = require('crypto');
  const tmp = path.join(os.tmpdir(), `wvoicesrc-install-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(tmp, 'engine', 'x64'), { recursive: true });
  // 引擎已就位（体积正确的 NVSA 包 + DLL）：下载阶段会跳过它，解压阶段也不会重建 engine
  fs.writeFileSync(path.join(tmp, S.NVSA.asset.fileName), Buffer.alloc(S.NVSA.asset.sizeBytes));
  fs.writeFileSync(path.join(tmp, 'engine', 'x64', 'NaturalVoiceSAPIAdapter.dll'), 'stub', 'utf8');

  const zipBuf = buildZip([{ name: 'voice/data.bin', data: 'hello' }]);
  const sha = crypto.createHash('sha256').update(zipBuf).digest('hex');
  const manifest = {
    schemaVersion: 1,
    name: '安装路径测试源',
    voices: [
      {
        key: 'probeinst',
        displayName: '安装测试音色',
        engine: 'nvsa-sapi',
        requires: ['nvsa'],
        files: [{ url: 'https://example.com/downloads/ProbeInst.msix', sizeBytes: zipBuf.length, sha256: sha }],
      },
    ],
  };
  await V.loadSources({
    entries: [{ id: 'instsrc', kind: 'url', location: 'https://inst.example.com/voices.json' }],
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(manifest) }),
    noCache: false,
  });

  const dep = new VoiceDeploy({
    workDir: tmp,
    announce: async () => {},
    emit: () => {},
    fetchImpl: async () => responseWith(zipBuf),
  });
  const plan = dep._plan(['probeinst']);
  try {
    await dep._downloadPhase(plan);
    const filePath = path.join(tmp, 'ProbeInst.msix');
    const downloaded = fs.existsSync(filePath) && fs.statSync(filePath).size === zipBuf.length;
    await dep._extractPhase(plan);
    const voiceDir = path.join(tmp, 'voices', 'ProbeInst');
    const extracted = fs.existsSync(path.join(voiceDir, 'voice', 'data.bin'));
    const engineKept = fs.existsSync(path.join(tmp, 'engine', 'x64', 'NaturalVoiceSAPIAdapter.dll'));
    record('⑦ 按清单下载 + 解压 + sha256 校验', downloaded && extracted && engineKept && dep._filesReady(plan), {
      downloaded,
      extracted,
      engineKept,
      filesReady: dep._filesReady(plan),
      targets: plan.targets.map((t) => `${t.fileName}:${t.sizeBytes}`),
    });

    // sha256 不符：必须删掉文件并报下载失败（不能把错内容送进解压）
    const bad = JSON.parse(JSON.stringify(manifest));
    bad.voices[0].key = 'probebad';
    bad.voices[0].displayName = '校验失败音色';
    bad.voices[0].files[0].url = 'https://example.com/downloads/ProbeBad.msix';
    bad.voices[0].files[0].sha256 = 'b'.repeat(64);
    await V.loadSources({
      entries: [{ id: 'instsrc2', kind: 'url', location: 'https://inst2.example.com/voices.json' }],
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(bad) }),
      noCache: false,
    });
    const badPlan = dep._plan(['probebad']);
    let err = null;
    try {
      await dep._downloadPhase(badPlan);
    } catch (e) {
      err = e;
    }
    const badFile = path.join(tmp, 'ProbeBad.msix');
    record('⑦-2 sha256 不符被拒且不留残文件', !!err && err.vpCode === S.VP_ERRORS.NETWORK && !fs.existsSync(badFile), {
      code: err && err.vpCode,
      message: err && err.message,
      fileExists: fs.existsSync(badFile),
    });
  } finally {
    dep.dispose();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* 忽略清理失败 */
    }
  }
}

// ---------------------------------------------------------------- 主流程
(async () => {
  const report = {
    probe: 'W-VOICESRC',
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    schemaVersion: V.SCHEMA_VERSION,
    supportedEngines: Object.keys(V.SUPPORTED_ENGINES),
  };

  const tmp = path.join(os.tmpdir(), `wvoicesrc-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // 本地源：file:// 只允许在显式添加的本地清单里
    const localManifest = validManifest();
    localManifest.voices[0].files[0].url = 'file:///C:/voices/Probe.Voice.1.0.msix';
    localManifest.voices[0].files[0].urls = [];
    const localPath = path.join(tmp, 'voices.json');
    fs.writeFileSync(localPath, JSON.stringify(localManifest, null, 2), 'utf8');
    const localRes = await V.loadOne({ kind: 'file', location: localPath }, {});
    record('⑥ 本地清单（file://）可加载', localRes.source.ok && localRes.source.voiceCount === 1, {
      ok: localRes.source.ok,
      error: localRes.source.error,
    });

    const badLocal = path.join(tmp, 'broken.json');
    fs.writeFileSync(badLocal, '{ "schemaVersion": 1, "name": "x", ', 'utf8');
    const badRes = await V.loadOne({ kind: 'file', location: badLocal }, {});
    record('⑥-2 坏 JSON 只影响自己', !badRes.source.ok && badRes.source.error.code === V.SOURCE_ERRORS.JSON, badRes.source.error);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (e) {
      /* 忽略清理失败 */
    }
  }

  await degradation();
  await planRegression();
  await installPath();

  report.cases = CASES;
  report.pass = CASES.every((c) => c.pass);
  report.summary = `${CASES.filter((c) => c.pass).length}/${CASES.length} 通过`;
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exit(1);
})().catch((e) => {
  console.error('探针异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
