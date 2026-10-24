// W-FIX1 探针：验证「已开始朗读」延迟确认闸门的两条路径
//
// 运行（清掉 ELECTRON_RUN_AS_NODE，让 electron 以主进程身份跑脚本）：
//   env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe scripts/tmp_probe_WFIX1_announce.js
//
// 验证层级说明：
//   - 被测对象是 App 实际使用的那一层 —— createStartAnnounceGate / shouldConfirmStart
//     （src/renderer/hooks/startAnnounceGate.js）。它是纯 JS、无 React 依赖，探针用
//     esbuild 把 ESM 现场转成 CJS 后 require，跑的就是产品源码本身，不是复制品。
//   - useDelayedAnnounce 只是把 playback.isPlaying 接进闸门；playback 的出声判定
//     由 useStreamingPlayback 负责（本 worker 禁改）。因此这里用 mock 的 isSounding
//     注入两条时序：100ms 内出声 / 全程不出声。
//   - 另加一条静态断言：App.jsx 的 handleRead 里不能再出现「立即 announce('start')」。
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const GATE_SRC = path.join(ROOT, 'src', 'renderer', 'hooks', 'startAnnounceGate.js');
const APP_JSX = path.join(ROOT, 'src', 'renderer', 'App.jsx');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadGate() {
  const esbuild = require('esbuild');
  const src = fs.readFileSync(GATE_SRC, 'utf8');
  const code = esbuild.transformSync(src, { loader: 'js', format: 'cjs', target: 'node18' }).code;
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports,
    require,
    mod,
    GATE_SRC,
    path.dirname(GATE_SRC)
  );
  return mod.exports;
}

async function main() {
  const { createStartAnnounceGate, shouldConfirmStart, START_CONFIRM_DELAY_MS } = loadGate();
  const results = [];
  const D = START_CONFIRM_DELAY_MS;

  const check = (id, title, pass, detail) => {
    results.push({ id, title, pass: !!pass, detail });
    console.log(`${pass ? '  [PASS]' : '  [FAIL]'} ${id} ${title}  ${detail}`);
  };

  console.log(`\n=== W-FIX1 播报延迟确认探针（确认窗口 ${D}ms）===\n`);

  check('C0', '确认窗口为 700ms', D === 700, `START_CONFIRM_DELAY_MS=${D}`);

  // 纯函数判定：出声时永不补播；静默且超时才补播
  const pureCases = [
    [{ isSounding: true, elapsedMs: 900 }, false, '出声 → 不播'],
    [{ isSounding: false, elapsedMs: 699 }, false, '未到点 → 不播'],
    [{ isSounding: false, elapsedMs: 700 }, true, '到点仍静默 → 播'],
  ].every(([arg, want]) => shouldConfirmStart({ ...arg, delayMs: D }) === want);
  check('C1', 'shouldConfirmStart 判定表', pureCases, '3 组样本全部符合预期');

  // ---------------- 路径 A：快路径（100ms 内出声 → 不播） ----------------
  console.log('\n--- 路径 A：快路径（本地 NVSA，触发后 100ms 出声）---');
  {
    const state = { playing: false };
    const said = [];
    const t0 = Date.now();
    const gate = createStartAnnounceGate({
      announce: (name, params) => said.push({ name, at: Date.now() - t0 }),
      isSounding: () => state.playing,
    });
    gate.arm('start');
    console.log(`    t=0ms   arm('start') 已挂起`);
    await sleep(100);
    state.playing = true; // 正文真的响了
    console.log(`    t≈${Date.now() - t0}ms isPlaying=true（正文出声）`);
    await sleep(D + 350); // 越过确认窗口，确保定时器已触发
    console.log(`    t≈${Date.now() - t0}ms 观察结束：announce 调用 ${said.length} 次 ${JSON.stringify(said)}`);
    check(
      'A1',
      `快路径 700ms 后未播「已开始朗读」`,
      said.length === 0,
      `announce 次数=${said.length}（期望 0）`
    );
    check('A2', '定时器已到期停止（无残留）', gate.armed === false, `armed=${gate.armed}`);
  }

  // ---------------- 路径 B：慢路径（全程不出声 → 播） ----------------
  console.log('\n--- 路径 B：慢路径（在线兜底 / 合成慢，700ms 内没有出声）---');
  {
    const state = { playing: false };
    const said = [];
    const t0 = Date.now();
    const gate = createStartAnnounceGate({
      announce: (name, params) => said.push({ name, at: Date.now() - t0 }),
      isSounding: () => state.playing,
    });
    gate.arm('start');
    console.log(`    t=0ms   arm('start') 已挂起`);
    await sleep(D - 100);
    console.log(`    t≈${Date.now() - t0}ms isPlaying 仍为 false，announce 次数 ${said.length}`);
    await sleep(400);
    const first = said[0];
    console.log(`    t≈${Date.now() - t0}ms announce 调用 ${said.length} 次 ${JSON.stringify(said)}`);
    check(
      'B1',
      '慢路径 700ms 后补播了「已开始朗读」',
      said.length === 1 && said[0].name === 'start',
      `name=${first ? first.name : 'null'}`
    );
    check(
      'B2',
      '补播时机落在确认窗口（不早于 700ms）',
      !!first && first.at >= D - 20 && first.at <= D + 350,
      `实测 t=${first ? first.at : 'null'}ms`
    );
    check('B3', '静默期未提前播报', said.filter((x) => x.at < D - 20).length === 0, `提前播报条数=${said.filter((x) => x.at < D - 20).length}`);
  }

  // ---------------- 路径 C：重复触发只留最后一次 ----------------
  console.log('\n--- 路径 C：连按两次（第二次覆盖第一次，不叠加播报）---');
  {
    const state = { playing: false };
    const said = [];
    const t0 = Date.now();
    const gate = createStartAnnounceGate({
      announce: (name) => said.push({ name, at: Date.now() - t0 }),
      isSounding: () => state.playing,
    });
    gate.arm('start');
    await sleep(300);
    gate.arm('start'); // 第二次触发
    console.log(`    t≈${Date.now() - t0}ms 第二次 arm（应清掉第一次的定时器）`);
    await sleep(D + 500);
    console.log(`    t≈${Date.now() - t0}ms announce 调用 ${said.length} 次 ${JSON.stringify(said)}`);
    check('C2', '只播报 1 次（旧定时器被清理）', said.length === 1, `announce 次数=${said.length}`);
    check(
      'C3',
      '播报时间戳属于第二次触发（≥1000ms）',
      !!said[0] && said[0].at >= 300 + D - 20,
      `实测 t=${said[0] ? said[0].at : 'null'}ms`
    );
  }

  // ---------------- 路径 D：停止/暂停时 cancel 让旧播报作废 ----------------
  console.log('\n--- 路径 D：挂起期间被取消（停止 / 暂停 / 新一轮朗读）---');
  {
    const state = { playing: false };
    const said = [];
    const t0 = Date.now();
    const gate = createStartAnnounceGate({
      announce: (name) => said.push({ name, at: Date.now() - t0 }),
      isSounding: () => state.playing,
    });
    gate.arm('start');
    await sleep(250);
    gate.cancel();
    await sleep(D + 300);
    console.log(`    t≈${Date.now() - t0}ms cancel 后观察结束：announce 次数 ${said.length}`);
    check('D1', 'cancel 后不补播', said.length === 0, `announce 次数=${said.length}`);
  }

  // ---------------- 路径 E：确定性时序（注入时钟，排除真定时器抖动） ----------------
  console.log('\n--- 路径 E：注入时钟的确定性时序（严格 100ms 出声 / 700ms 判定）---');
  {
    const run = (soundAtMs) => {
      const clock = { now: 0, playing: false };
      const calls = [];
      const sched = { fn: null };
      const gate = createStartAnnounceGate({
        announce: (name) => calls.push({ name, at: clock.now }),
        isSounding: () => clock.playing,
        clock: () => clock.now,
        schedule: (fn) => {
          sched.fn = fn;
          return 1;
        },
        cancelSchedule: () => {
          sched.fn = null;
        },
      });
      gate.arm('start');
      if (soundAtMs != null) {
        clock.now = soundAtMs;
        clock.playing = true; // 例如 t=100ms 正文出声
      }
      clock.now = D; // 定时器到点
      const pending = sched.fn;
      sched.fn = null;
      if (pending) pending();
      return { calls, armCleared: gate.armed === false };
    };

    const fast = run(100);
    const slow = run(null);
    console.log(`    快路径(t=100ms 出声) → announce=${JSON.stringify(fast.calls)}`);
    console.log(`    慢路径(t=700ms 仍静默) → announce=${JSON.stringify(slow.calls)}`);
    check('F1', '100ms 出声 → 不播报', fast.calls.length === 0, `announce 次数=${fast.calls.length}`);
    check('F2', '全程静默 → 700ms 播报 1 次', slow.calls.length === 1 && slow.calls[0].at === D, `announce=${JSON.stringify(slow.calls)}`);
  }

  // ---------------- 静态断言：App.jsx 已改为延迟确认 ----------------
  console.log('\n--- 静态检查：App.jsx 的播报接线 ---');
  {
    const src = fs.readFileSync(APP_JSX, 'utf8');
    const readBlock = src.slice(src.indexOf('const handleRead'), src.indexOf('const readRef'));
    const playBlock = src.slice(src.indexOf('const handlePlay'), src.indexOf('const handlePause'));
    check('E1', 'handleRead 内不再立即 announce(start)', !/announcer\.announce\(\s*'start'/.test(readBlock), `命中=${/announcer\.announce\(\s*'start'/.test(readBlock)}`);
    check('E2', "handleRead 内改用 startAnnounce.arm('start')", /startAnnounce\.arm\(\s*'start'/.test(readBlock), `命中=${/startAnnounce\.arm\(\s*'start'/.test(readBlock)}`);
    // v2.4.0 编排者裁决：handlePlay 在无音频时直接 return，不再 arm('start')
    //（否则 700ms 后会念一句「已开始朗读」而实际什么都没播）。故断言改为：
    // 必须走延迟确认且只 arm('resume')，且不得残留即时 announce('start')。
    check(
      'E3',
      "handlePlay 走延迟确认且只 arm('resume')",
      /startAnnounce\.arm\(\s*'resume'\s*\)/.test(playBlock) &&
        !/announcer\.announce\(\s*'start'/.test(playBlock) &&
        /!playback\.hasAudio/.test(playBlock),
      `arm(resume)=${/startAnnounce\.arm\(\s*'resume'\s*\)/.test(playBlock)} guard=${/!playback\.hasAudio/.test(playBlock)}`
    );
    check('E4', '暂停 / 停止仍然立即播报（未被延迟化）', /announcer\.announce\('pause'\)/.test(src) && /announcer\.announce\('stop'\)/.test(src), 'pause/stop 的 announce 均保留');
  }

  const failed = results.filter((r) => !r.pass);
  const ok = failed.length === 0;

  console.log('\n===== 结论 =====');
  console.log(
    JSON.stringify(
      {
        ok,
        total: results.length,
        failed: failed.map((f) => f.id),
        fastPath: '触发后 100ms 出声 → 700ms 后 announce 次数 0（不念「已开始朗读」）',
        slowPath: '触发后全程不出声 → 约 700ms 补播「已开始朗读」1 次',
        delayMs: D,
      },
      null,
      2
    )
  );
  console.log(ok ? '\nOK：两条路径均符合预期。' : '\nFAIL：存在不符合预期的用例，见上方 [FAIL]。');
  return ok ? 0 : 3;
}

(async () => {
  let code = 2;
  try {
    code = await main();
  } catch (e) {
    console.error('[W-FIX1] 探针自身异常：', e && e.stack ? e.stack : e);
    code = 2;
  }
  // 以 Electron 主进程身份运行时必须显式退出，否则事件循环不会自己结束
  if (process.versions && process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    try {
      require('electron').app.exit(code);
    } catch (e) {
      process.exit(code);
    }
  } else {
    process.exit(code);
  }
})();
