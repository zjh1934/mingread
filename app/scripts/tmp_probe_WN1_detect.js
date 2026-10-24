// W-N1 探针：本地离线语音「DETECTING 四项」真实检测 + zipUtils 防 Zip Slip 自测。
//
// 用途：证明 voiceDeploy.detect() 在这台机器上真的能跑出四项结论，而不是纸面实现。
// 不做任何写操作、不下载、不提权。
//
// 用法（PowerShell 里执行，沙箱 Bash 不能起 powershell）：
//   node scripts/tmp_probe_WN1_detect.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { VoiceDeploy } = require('../src/main/voiceDeploy');
const { extractAll } = require('../src/main/zipUtils');
const { VP_ERRORS } = require('../src/main/voicePackSources');

// 失败码 → 期望失败态（静态表 + 运行时分派对照，两者不一致就是 bug）
const EXPECT_FAIL_STATE = {
  [VP_ERRORS.NETWORK]: 'FAILED_DOWNLOAD',
  [VP_ERRORS.EXTRACT]: 'FAILED_EXTRACT',
  [VP_ERRORS.ELEVATION_DENIED]: 'FAILED_ELEVATION',
  [VP_ERRORS.NETFX3]: 'FAILED_NETFX3',
  [VP_ERRORS.REGISTER]: 'FAILED_REGISTER',
  [VP_ERRORS.CONFIG]: 'FAILED_REGISTER',
  [VP_ERRORS.VERIFY_FAILED]: 'FAILED_VERIFY',
};

// ---------------------------------------------------------------- 迷你 ZIP 构造器（仅用于安全自测）

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
    lfh.writeUInt16LE(0x800, 6); // UTF-8 名
    lfh.writeUInt16LE(0, 8); // stored
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    locals.push(lfh, name, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x800, 8);
    cen.writeUInt16LE(0, 10);
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

function zipSelfTest() {
  const root = path.join(os.tmpdir(), `wn1-zip-${process.pid}-${Date.now()}`);
  const out = { root, cases: [] };
  fs.mkdirSync(root, { recursive: true });

  // 用例 1：正常条目应解压成功
  const goodZip = path.join(root, 'good.zip');
  fs.writeFileSync(goodZip, buildZip([{ name: 'ok/hello.txt', data: 'hello' }]));
  try {
    const goodDir = path.join(root, 'out-good');
    const r = extractAll(goodZip, goodDir);
    out.cases.push({
      case: '正常条目',
      pass: r.files === 1 && fs.readFileSync(path.join(goodDir, 'ok', 'hello.txt'), 'utf8') === 'hello',
      files: r.files,
    });
  } catch (e) {
    out.cases.push({ case: '正常条目', pass: false, error: e.message });
  }

  // 用例 2：`../` 越界条目必须整体拒绝，且磁盘上不得留下任何文件
  const badZip = path.join(root, 'slip.zip');
  fs.writeFileSync(
    badZip,
    buildZip([
      { name: 'inner/ok.txt', data: 'ok' },
      { name: '../escaped.txt', data: 'pwned' },
    ])
  );
  const badDir = path.join(root, 'out-bad');
  let rejected = false;
  let msg = '';
  try {
    extractAll(badZip, badDir);
  } catch (e) {
    rejected = true;
    msg = e.message;
  }
  const escapedPath = path.join(root, 'escaped.txt');
  const leaked = fs.existsSync(escapedPath);
  const partial = fs.existsSync(badDir) && fs.readdirSync(badDir).length > 0;
  out.cases.push({
    case: 'Zip Slip（../）',
    pass: rejected && !leaked && !partial,
    rejected,
    leaked,
    partiallyWritten: partial,
    error: msg,
  });

  // 用例 3：绝对路径条目必须拒绝
  const absZip = path.join(root, 'abs.zip');
  fs.writeFileSync(absZip, buildZip([{ name: 'C:/Windows/pwned.txt', data: 'x' }]));
  let rejectedAbs = false;
  let msgAbs = '';
  try {
    extractAll(absZip, path.join(root, 'out-abs'));
  } catch (e) {
    rejectedAbs = true;
    msgAbs = e.message;
  }
  out.cases.push({ case: '绝对路径', pass: rejectedAbs, rejected: rejectedAbs, error: msgAbs });

  out.pass = out.cases.every((c) => c.pass);
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    /* 忽略清理失败 */
  }
  return out;
}

// ---------------------------------------------------------------- 失败分支分派（纯内存，无副作用）

async function branchCheck() {
  const spoken = [];
  const dep = new VoiceDeploy({ announce: async (p) => spoken.push(p.text), emit: () => {} });
  const rows = [];
  for (const [code, expect] of Object.entries(EXPECT_FAIL_STATE)) {
    spoken.length = 0;
    const r = dep._failFrom(dep._err(code, `测试失败：${code}`, '下一步：点重试。'));
    rows.push({
      code,
      state: r.state,
      expect,
      pass: r.state === expect && spoken.length === 1 && spoken[0].indexOf('下一步') >= 0,
      announced: spoken[0] || '',
      snapshotFailed: dep.getSnapshot().failed,
    });
  }
  // 重入保护：_busy 时第二次 install() 必须立刻返回 DEPLOY_BUSY（不得重入下载/提权）
  dep._busy = true;
  const busy = await dep.install();
  dep._busy = false;
  dep.dispose();
  return { rows, pass: rows.every((r) => r.pass), reentrant: { code: busy.code, ok: busy.code === 'DEPLOY_BUSY' } };
}

// ---------------------------------------------------------------- 主流程

(async () => {
  const t0 = Date.now();
  const dep = new VoiceDeploy({ announce: async () => {}, emit: () => {} });
  const report = {
    probe: 'W-N1-detect',
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    workDir: dep.workDir,
    workDirSource: dep.workDirSource,
  };

  const snap = await dep.detect();
  const c = snap.checks || {};
  report.detect = {
    state: snap.state,
    ready: snap.ready,
    elapsedMs: Date.now() - t0,
    '1_systemSpeech': c.systemSpeech,
    '2_nvsaRegistry': c.registry,
    '3_engineFiles': c.files,
    '4_voiceEnumeration': c.voices && {
      ok: c.voices.ok,
      matched: c.voices.matched,
      matchedKeys: c.matchedKeys,
      installedCount: (c.voices.names || []).length,
      installedSample: (c.voices.names || []).slice(0, 8),
      message: c.voices.message,
    },
    missing: c.missing,
    summary: c.summary,
  };
  report.zipSelfTest = zipSelfTest();
  report.failBranches = await branchCheck();

  console.log(JSON.stringify(report, null, 2));
  dep.dispose();
})().catch((e) => {
  console.error('探针异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
