// 探针：真实执行 NVSA 一键部署（下载→解压→一次 UAC→HKCU 配置→四级验证）。
//
// 前置：三个安装包已就位（或下载已完成），否则本探针会自己走下载（慢网很慢）。
// UAC：会弹一次「用户账户控制」，需要人工点「是」——这是设计上限（只问一次）。
//
// 用法（PowerShell 工具，先清 ELECTRON_RUN_AS_NODE）：
//   node node_modules/electron/cli.js scripts/tmp_probe_install.js
// 结果写 dist/probe/install.json，含完整状态迁移轨迹。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 关键：模拟真实 app 的 userData。
// 用 `electron scripts/xxx.js` 启动时没有加载 app 的 package.json，productName 缺失，
// app.getPath('userData') 会变成 %APPDATA%\Electron（纯 ASCII）→ voiceDeploy 不会走
// 「非 ASCII 退回 %LOCALAPPDATA%\langdu-nv\voice-pack」这条分支，于是它会去另一个目录
// 重新下载 142MB。必须在 require voiceDeploy 之前把 userData 设成真实值。
try {
  const realUserData = path.join(process.env.APPDATA || '', '朗读女 Neo');
  app.setPath('userData', realUserData);
} catch (e) {
  console.log('[warn] setPath userData failed: ' + ((e && e.message) || e));
}

const { getVoiceDeploy } = require('../src/main/voiceDeploy');

const OUT = path.join(__dirname, '..', 'dist', 'probe', 'install.json');
const T0 = Date.now();
// --detect-only：只做检测（确认 workDir / 四项检查），不下载、不提权
const DETECT_ONLY = process.argv.includes('--detect-only');

app.whenReady().then(async () => {
  const log = { at: new Date().toISOString(), states: [], detect: null, result: null, error: null };

  let vd = null;
  try {
    vd = getVoiceDeploy();
  } catch (e) {
    log.error = 'getVoiceDeploy: ' + ((e && e.message) || e);
  }

  if (vd) {
    console.log('[deploy] workDir=' + vd.workDir + ' source=' + vd.workDirSource);
    vd.onStateChanged((s) => {
      log.states.push({ tMs: Date.now() - T0, state: s.state, pct: Math.round(s.pct || 0), label: s.label || '' });
      console.log(`[deploy] ${s.state} ${Math.round(s.pct || 0)}% ${s.label || ''}`);
    });

    try {
      const d = await vd.detect({ announce: false });
      log.detect = d;
      console.log('[detect] ' + JSON.stringify({ state: d && d.state, ready: d && d.ready, missing: d && d.missing }));
    } catch (e) {
      console.log('[detect] error ' + ((e && e.message) || e));
    }

    if (DETECT_ONLY) {
      log.detectOnly = true;
      console.log('[detect-only] 跳过 install');
    } else {
      try {
        // install(): 幂等可重入，已下载/已解压/已注册会跳过对应阶段
        const r = await vd.install();
        log.result = {
          ok: !!(r && r.ok),
          state: r && r.state,
          code: r && r.code,
          message: r && r.message,
          alreadyReady: !!(r && r.alreadyReady),
        };
        console.log('[install] ' + JSON.stringify(log.result));
      } catch (e) {
        log.error = 'install: ' + ((e && e.message) || e);
        console.log('[install] error ' + log.error);
      }
    }

    // 装完再探一次：确认引擎真的可用（不只是状态机说成功）
    try {
      const after = await vd.detect({ announce: false });
      log.afterDetect = { state: after && after.state, ready: after && after.ready };
      console.log('[after] ' + JSON.stringify(log.afterDetect));
    } catch (e) {
      log.afterError = (e && e.message) || String(e);
    }
  }

  log.elapsedMs = Date.now() - T0;
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {
    /* noop */
  }
  console.log(`[done] elapsed=${log.elapsedMs}ms states=${log.states.length}`);
  app.exit(log.result && log.result.ok ? 0 : 1);
});
