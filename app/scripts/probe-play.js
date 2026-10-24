// ============================================================================
// probe-play.js —— 播放态实跑验证探针（QA v26）
//
// 目标：填补「播放中」状态零实跑证据的缺口。真启动应用 → 真触发逐句流式朗读
// （沙箱验证引擎 espeak-ng）→ 在播放进行中的多个状态点截图 + 采集布局证据。
//
// 用法（root 下 --no-sandbox 必需；DISPLAY 需已有 X + WM）：
//   LDN_SCEN=play     DISPLAY=:99 node_modules/.bin/electron scripts/probe-play.js --no-sandbox
//   LDN_SCEN=play2x   （2.0x 浅色）
//   LDN_SCEN=playhc   （1.0x 高对比度）
//   LDN_SCEN=playhc2x （2.0x 高对比度）
//   LDN_SCEN=playfull （1.0x 浅色 + 全状态序列：准备中/合成中/继续/上下句/跳转/定时）
//
// 截图写 deliverables/qa-v26-play-*.png；日志写 scripts/probe-play.txt。
// 设计要点：
//   - 触发走真实 UI 路径：编辑器粘贴 10 句短文本 → 点真实「开始朗读」按钮；
//   - 状态判定全部来自真实 DOM（role=status 状态行 / aria-current 高亮 / Slider aria 值）；
//   - 「准备中 / 正在合成」是毫秒级瞬态，探针在页面侧给 synthesizeOne 的首/指定次
//     调用加 2.5s 延迟来放大窗口（等价于慢网慢合成，不改动产品代码）；
//   - 任何状态没抓到都会在日志里明确记 NOT_CAPTURED，不编造。
// ============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(__dirname, '..', '..', 'deliverables');
const LOG = [];
const SCEN = process.env.LDN_SCEN || 'play';

const TEXT =
  '第一句，播放开始。\n第二句，句列表高亮。\n第三句，进度条前进。\n第四句，定时可开启。\n第五句，语速可调节。\n第六句，暂停可继续。\n第七句，上下句可跳。\n第八句，停止回初始。\n第九句，高对比清晰。\n第十句，结束回开头。';

// playbuf 专用：超长句放在第 6 句（避开 current+3 预取窗口）。播放中点它可稳定捕获
// 「正在合成」——首句合成期间被 preparing 掩盖（状态行显示「准备中…」），只有句间
// 跳转到未合成句时 buffering 才显示为「正在合成当前句…」。
const BUF_TEXT =
  '短句一，播放开始。\n短句二，列表就位。\n短句三，进度前进。\n短句四，定时可开。\n短句五，语速可调。\n长句合成测试' +
  '，这段文字没有任何句号，会被当成完整的一句话进行合成，合成期间状态行应当显示正在合成当前句，播放时这段文字会进入大字当前句区域'.repeat(
    45
  ) +
  '\n短句七，播放结束。';

const SCENARIOS = {
  play: { fontScale: 1, theme: 'light', tag: '', full: false },
  play2x: { fontScale: 2, theme: 'light', tag: '2x', full: false },
  playhc: { fontScale: 1, theme: 'hc', tag: 'hc', full: false },
  playhc2x: { fontScale: 2, theme: 'hc', tag: 'hc2x', full: false },
  playfull: { fontScale: 1, theme: 'light', tag: 'full', full: true },
  // 瞬态专用：首句为超长单句（无句读终止符），把「准备中 / 正在合成」窗口拉到 1 秒以上
  playbuf: { fontScale: 1, theme: 'light', tag: 'buf', full: false, bufMode: true },
  playbuf2x: { fontScale: 2, theme: 'light', tag: 'buf2x', full: false, bufMode: true },
};
const cfg = SCENARIOS[SCEN] || SCENARIOS.play;
const P = (name) => `qa-v26-play-${cfg.tag ? `${cfg.tag}-` : ''}${name}.png`;

function log(s) {
  LOG.push(String(s));
  fs.writeFileSync(path.join(__dirname, `probe-play-${SCEN}.txt`), LOG.join('\n') + '\n');
}

function seedUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldnqa26-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ fontScale: cfg.fontScale, floatBallSize: 56, floatBallEnabled: true }, null, 2)
  );
  require('../src/main/settingsStore')._setSettingsPathForTest(file);
  log(`settings.json=${file} fontScale=${cfg.fontScale} theme=${cfg.theme}`);
}

const seed = () =>
  `localStorage.setItem('langdu-neo-settings', JSON.stringify({state:{themeMode:${JSON.stringify(
    cfg.theme
  )},voiceId:'edge:xiaoxiao',rate:0,pitch:0,volume:0},version:1}));`;

try {
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
} catch (e) {
  log('isPackaged override failed: ' + e.message);
}
app.commandLine.appendSwitch('no-sandbox');

// ---- 页面侧：状态提取 + 合成延迟开关（放大瞬态窗口）----
const PAGE_HELPERS = `
window.__ppState = function () {
  var de = document.documentElement;
  var out = {
    scale: getComputedStyle(de).getPropertyValue('--ldn-scale').trim(),
    hc: de.getAttribute('data-theme-hc'),
    overflowX: de.scrollWidth - de.clientWidth,
    docH: de.scrollHeight,
    viewH: de.clientHeight,
  };
  var st = document.querySelector('[role="status"]');
  out.status = st ? st.textContent.replace(/\\s+/g, ' ').trim() : '';
  out.playing = out.status.indexOf('播放中') !== -1;
  out.paused = out.status.indexOf('已暂停') !== -1;
  out.idle = out.status.indexOf('待开始') !== -1;
  out.buffering = out.status.indexOf('正在合成') !== -1;
  out.preparing = out.status.indexOf('准备中') !== -1;
  out.timerChip = out.status.indexOf('定时') !== -1;
  var m = out.status.match(/第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*句/);
  out.curIdx = m ? Number(m[1]) - 1 : -1;
  out.totalSent = m ? Number(m[2]) : 0;
  var curBox = document.querySelector('[aria-label^="当前第"]');
  if (curBox) {
    var typ = curBox.querySelector('.MuiTypography-root');
    var r = curBox.getBoundingClientRect();
    out.curFontPx = typ ? Math.round(parseFloat(getComputedStyle(typ).fontSize)) : null;
    out.curText = typ ? typ.textContent.slice(0, 20) : '';
    out.curRect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  }
  var prog = document.querySelector('[aria-label="播放进度"]');
  if (prog) {
    out.prog = { value: Number(prog.getAttribute('aria-valuenow')), max: Number(prog.getAttribute('aria-valuemax')) };
    var row = prog.closest('.MuiStack-root');
    var times = row ? (row.textContent.match(/\\d+:\\d\\d/g) || []) : [];
    out.timeLabels = times.slice(0, 2);
  }
  var items = [].slice.call(document.querySelectorAll('[aria-label*="句，共"]'));
  out.listCount = items.length;
  var act = items.filter(function (el) { return el.getAttribute('aria-current') === 'true'; })[0];
  out.activeLabel = act ? act.getAttribute('aria-label') : null;
  out.activeBg = act ? getComputedStyle(act).backgroundColor : null;
  if (act) { var ar = act.getBoundingClientRect(); out.activeRect = [Math.round(ar.x), Math.round(ar.y), Math.round(ar.width), Math.round(ar.height)]; }
  var listBox = items.length ? items[0].parentElement : null;
  if (listBox) {
    out.listScroll = { top: Math.round(listBox.scrollTop), h: Math.round(listBox.clientHeight), sh: Math.round(listBox.scrollHeight) };
    var lr = listBox.getBoundingClientRect();
    out.listRect = [Math.round(lr.x), Math.round(lr.y), Math.round(lr.width), Math.round(lr.height)];
  }
  var sb = document.querySelector('.MuiSnackbar-root .MuiAlert-root');
  if (sb) {
    var sr = sb.getBoundingClientRect();
    out.snack = { text: sb.textContent.slice(0, 46), rect: [Math.round(sr.x), Math.round(sr.y), Math.round(sr.width), Math.round(sr.height)] };
    if (out.listRect) {
      var ox = Math.max(0, Math.min(out.snack.rect[0] + out.snack.rect[2], out.listRect[0] + out.listRect[2]) - Math.max(out.snack.rect[0], out.listRect[0]));
      var oy = Math.max(0, Math.min(out.snack.rect[1] + out.snack.rect[3], out.listRect[1] + out.listRect[3]) - Math.max(out.snack.rect[1], out.listRect[1]));
      out.snackOverlapList = [ox, oy];
    }
    if (out.activeRect) {
      var ax = Math.max(0, Math.min(out.snack.rect[0] + out.snack.rect[2], out.activeRect[0] + out.activeRect[2]) - Math.max(out.snack.rect[0], out.activeRect[0]));
      var ay = Math.max(0, Math.min(out.snack.rect[1] + out.snack.rect[3], out.activeRect[1] + out.activeRect[3]) - Math.max(out.snack.rect[1], out.activeRect[1]));
      out.snackOverlapActive = [ax, ay];
    }
  }
  // 外层滚动容器滚动位置（句列表 scrollIntoView 对页面滚动的影响）
  var anchor = document.querySelector('[aria-label^="当前第"]') || document.body;
  var p = anchor.parentElement;
  var sc = null;
  while (p) {
    var oy2 = getComputedStyle(p).overflowY;
    if (oy2 === 'auto' || oy2 === 'scroll' || p === document.scrollingElement) {
      sc = p;
      break;
    }
    p = p.parentElement;
  }
  out.pageScroll = sc ? Math.round(sc.scrollTop) : -1;
  var pp = document.querySelector('[aria-label="播放"],[aria-label="暂停"]');
  out.playBtn = pp ? pp.getAttribute('aria-label') + ' ' + Math.round(pp.getBoundingClientRect().width) + 'x' + Math.round(pp.getBoundingClientRect().height) : 'none';
  var startBtn = [].slice.call(document.querySelectorAll('button')).filter(function (b) { return b.textContent.indexOf('开始朗读') !== -1; })[0];
  out.startBtn = startBtn ? 'present' : 'none';
  return JSON.stringify(out);
};
// 注意：MUI Tooltip 会给外层包裹 span 也注入同名 aria-label（通用 role，读屏不暴露，
// 但会破坏 querySelector 自动化选择器），故一律优先选真实控件元素。
window.__ppPick = function (els) {
  if (!els || !els.length) return null;
  var ctrls = els.filter(function (el) {
    var t = el.tagName;
    return t === 'BUTTON' || t === 'INPUT' || t === 'TEXTAREA' || t === 'A' || el.getAttribute('role') === 'button';
  });
  return (ctrls.length ? ctrls : els)[(ctrls.length ? ctrls : els).length - 1];
};
window.__ppClick = function (sel) {
  var el = window.__ppPick([].slice.call(document.querySelectorAll(sel)));
  if (!el) return false;
  el.click();
  return true;
};
window.__ppClickText = function (text) {
  var els = [].slice.call(document.querySelectorAll('button,[role="button"]'));
  var el = window.__ppPick(els.filter(function (b) { return b.textContent.indexOf(text) !== -1; }));
  if (!el) return false;
  el.click();
  return true;
};
window.__ppClickExact = function (text) {
  var els = [].slice.call(document.querySelectorAll('button,[role="button"]'));
  var el = window.__ppPick(els.filter(function (b) { return b.textContent.trim() === text; }));
  if (!el) return false;
  el.click();
  return true;
};
window.__ppSetText = function (text) {
  var ta = document.querySelector('textarea');
  if (!ta) return false;
  var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};
// 诊断：捕获 audio.play() 被系统拦截的拒绝（自动播放策略）
window.__ppWatchPlay = function () {
  try {
    var orig = HTMLMediaElement.prototype.play;
    window.__playErrs = [];
    HTMLMediaElement.prototype.play = function () {
      var p = orig.apply(this, arguments);
      if (p && typeof p.catch === 'function') {
        p.catch(function (e) { window.__playErrs.push(Date.now() + ':' + String(e && e.name ? e.name : e)); });
      }
      return p;
    };
    return 'watching';
  } catch (e) { return 'err:' + e.message; }
};
// 诊断：全程监听 Snackbar 出现/消失（含错误提示）
window.__ppWatchSnack = function () {
  try {
    window.__snackLog = [];
    var obs = new MutationObserver(function () {
      var el = document.querySelector('.MuiSnackbar-root .MuiAlert-root');
      window.__snackLog.push(Date.now() + ':' + (el ? el.textContent.slice(0, 40) : 'GONE'));
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    return 'watching';
  } catch (e) { return 'err:' + e.message; }
};
void 0;
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function js(win, code, timeoutMs = 20000) {
  const t0 = Date.now();
  const r = await Promise.race([
    win.webContents.executeJavaScript(code),
    sleep(timeoutMs).then(() => ({ __timeout: true })),
  ]);
  const took = Date.now() - t0;
  if (took > 3000) log(`SLOW_JS ${took}ms :: ${String(code).slice(0, 90)}`);
  return r;
}

async function state(win) {
  const s = await js(win, 'window.__ppState()', 10000);
  if (!s || s.__timeout) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

/** 轮询直到满足条件；返回状态或 null（超时） */
async function waitFor(win, pred, timeoutMs, interval = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await state(win);
    if (s && pred(s)) return s;
    await sleep(interval);
  }
  return null;
}

async function shot(win, name) {
  try {
    const img = await win.webContents.capturePage();
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, P(name));
    fs.writeFileSync(p, img.toPNG());
    log(`SHOT ${P(name)} ${img.getSize().width}x${img.getSize().height}`);
    return p;
  } catch (e) {
    log(`SHOT_FAIL ${name}: ${e.message}`);
    return null;
  }
}

/** 截图 + 同时记录状态证据 */
async function cap(win, name, expect) {
  const s = await state(win);
  await shot(win, name);
  if (s) {
    log(
      `EVID ${name} status="${s.status}" curIdx=${s.curIdx}/${s.totalSent} font=${s.curFontPx}px scale=${s.scale} ` +
        `prog=${s.prog ? s.prog.value + '/' + s.prog.max : '-'} time=${s.timeLabels ? s.timeLabels.join('~') : '-'} ` +
        `active=${s.activeLabel} bg=${s.activeBg} listScroll=${s.listScroll ? JSON.stringify(s.listScroll) : '-'} ` +
        `snack=${s.snack ? JSON.stringify(s.snack) : 'none'} overlapList=${s.snackOverlapList ? JSON.stringify(s.snackOverlapList) : '-'} ` +
        `overlapActive=${s.snackOverlapActive ? JSON.stringify(s.snackOverlapActive) : '-'} playBtn=${s.playBtn} overflowX=${s.overflowX} pageScroll=${s.pageScroll} docH=${s.docH}/${s.viewH}`
    );
  } else {
    log(`EVID ${name} STATE_READ_FAILED`);
  }
  if (expect && s && !expect(s)) log(`WARN ${name} 状态与预期不符`);
  return s;
}

let mainWin = null;
let seeded = false;

app.on('browser-window-created', (_e, w) => {
  if (mainWin) return;
  mainWin = w;
  log(`window created ${w.getBounds().width}x${w.getBounds().height}`);
  try {
    w.on('render-process-gone', (_e, d) => log(`RENDER_GONE ${JSON.stringify(d)}`));
    w.webContents.on('did-fail-load', (_e, code, desc) => log(`LOAD_FAIL ${code} ${desc}`));
    w.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) log(`[console:${level}] ${String(message).slice(0, 140)}`);
    });
  } catch (e) {
    /* noop */
  }
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (!seeded) {
          seeded = true;
          await js(w, seed());
          w.webContents.reload();
        }
      } catch (e) {
        log('seed failed: ' + e.message);
      }
    }, 400);
  });
  w.webContents.on('did-finish-load', () => {
    if (!seeded) return;
    setTimeout(run, 1200);
  });
});

/** 轮询等待某元素出现后点击（返回是否点到） */
async function clickWhenExists(win, findExpr, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await js(
      win,
      `(function(){var el=${findExpr}; if(el){el.click(); return true;} return false;})()`
    );
    if (ok === true) return true;
    await sleep(200);
  }
  return false;
}

async function run() {
  const w = mainWin;
  try {
    await js(w, PAGE_HELPERS);

    // 1) 等挂载
    const mounted = await waitFor(
      w,
      (s) => s.startBtn === 'present',
      20000,
      150
    );
    log(`mounted=${!!mounted}`);

    // 2) 粘贴测试文本（真实编辑器路径：展开 → 粘贴 → 收起）
    const injectText = cfg.bufMode ? BUF_TEXT : TEXT;
    const opened = await js(w, `window.__ppClick('[aria-label="展开文本区"]')`);
    await sleep(400);
    const set = await js(w, `window.__ppSetText(${JSON.stringify(injectText)})`);
    await sleep(400);
    const meta = await js(w, `(document.querySelector('textarea')||{}).value ? document.querySelector('textarea').value.length : -1`);
    await js(w, `window.__ppClick('[aria-label="收起文本区"]')`);
    await sleep(300);
    log(`editor open=${opened} setText=${set} textareaLen=${meta} bufMode=${!!cfg.bufMode}`);

    // 3) 真触发播放：点「开始朗读」
    const clicked = await js(w, `window.__ppClickText('开始朗读')`);
    log(`click-start=${clicked}`);

    if (cfg.bufMode) {
      // —— 瞬态专用场景：准备中（首句）→ 播放短句 → 跳转超长句捕获「正在合成」→ 停止 ——
      const prep = await waitFor(w, (s) => s.preparing, 6000, 50);
      if (prep) await cap(w, 'preparing', (s) => s.preparing);
      else log('NOT_CAPTURED preparing');
      const s1 = await waitFor(w, (s) => s.playing && s.curIdx === 0, 20000, 100);
      if (!s1) {
        log('NOT_CAPTURED s1（buf 场景）');
      } else {
        await cap(w, 's1', (s) => s.playing && s.curIdx === 0);
        // 展开句列表后点第 6 句（超长未合成句）→ buffering 窗口 = 合成 + 大 payload IPC
        await js(w, `window.__ppClickText('句列表')`);
        await sleep(900);
        const j = await js(w, `window.__ppClick('[aria-label="第 6 句，共 7 句"]')`);
        const buf = await waitFor(w, (s) => s.buffering, 15000, 50);
        if (buf) await cap(w, 'buffering', (s) => s.buffering);
        else log(`NOT_CAPTURED buffering（click=${j}）`);
        const sLong = await waitFor(w, (s) => s.playing && s.curIdx === 5, 30000, 100);
        if (sLong) {
          await cap(w, 's1-long', (s) => s.playing && s.curIdx === 5);
          const box = await js(
            w,
            `(function(){var b=document.querySelector('[aria-label^="当前第"]'); if(!b) return 'none'; return JSON.stringify({sh:b.scrollHeight, ch:b.clientHeight, sw:b.scrollWidth, cw:b.clientWidth});})()`
          );
          log(`EVID long-cur-box ${box}`);
        } else {
          log('NOT_CAPTURED s1-long（超长句未开始播放）');
        }
      }
      // 停止态诊断：点击后连续采样，定位此前 NOT_CAPTURED 的原因
      const btnDiag = await js(
        w,
        `(function(){
          var els = [].slice.call(document.querySelectorAll('[aria-label="停止"]'));
          return JSON.stringify(els.map(function (el) {
            var r = el.getBoundingClientRect();
            return { tag: el.tagName, disabled: !!el.disabled, aria: el.getAttribute('aria-label'), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], pe: getComputedStyle(el).pointerEvents };
          }));
        })()`
      );
      log(`STOP_BTN_DOM ${btnDiag}`);
      // MutationObserver：记录停止阶段状态行的每次变化
      await js(
        w,
        `(function(){ if(window.__obs) window.__obs.disconnect(); window.__statLog=[];
           var st=document.querySelector('[role="status"]'); if(!st) return 'no-status';
           window.__obs=new MutationObserver(function(){ window.__statLog.push(Date.now()+':'+st.textContent.replace(/\\s+/g,' ').trim()); });
           window.__obs.observe(st,{childList:true,subtree:true,characterData:true});
           return 'observing'; })()`
      );
      const stp = await js(w, `window.__ppClick('[aria-label="停止"]')`);
      log(`click-stop=${stp} at=${new Date().toISOString()}`);
      await sleep(1500);
      const afterDom = await state(w);
      log(`AFTER_DOM_CLICK status="${afterDom ? afterDom.status : '?'}" playing=${afterDom ? afterDom.playing : '?'}`);
      if (afterDom && afterDom.playing) {
        // DOM click 无效 → 派发完整鼠标事件序列
        const ev = await js(
          w,
          `(function(){ var el=document.querySelector('[aria-label="停止"]'); if(!el) return 'no-el';
             ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){ el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window})); });
             return 'dispatched'; })()`
        );
        await sleep(1500);
        const afterEv = await state(w);
        log(`AFTER_EVENTS status="${afterEv ? afterEv.status : '?'}" playing=${afterEv ? afterEv.playing : '?'} (${ev})`);
        if (afterEv && afterEv.playing) {
          // 仍无效 → xdotool 真实鼠标注入（算上窗口内容区偏移）
          try {
            const cb = w.getContentBounds();
            const rect = await js(
              w,
              `(function(){var el=window.__ppPick([].slice.call(document.querySelectorAll('[aria-label="停止"]')])); if(!el) return null; var r=el.getBoundingClientRect(); return JSON.stringify([Math.round(r.x+r.width/2), Math.round(r.y+r.height/2)]);})()`
            );
            const pt = rect ? JSON.parse(rect) : null;
            if (pt) {
              const { execFileSync } = require('child_process');
              const wid = execFileSync('xdotool', ['search', '--name', '选中文字按 F1 即读'], {
                env: process.env,
              })
                .toString()
                .trim()
                .split('\n')[0];
              execFileSync('xdotool', ['windowactivate', '--sync', wid], { env: process.env });
              await sleep(300);
              execFileSync(
                'xdotool',
                ['mousemove', '--sync', String(cb.x + pt[0]), String(cb.y + pt[1]), 'click', '1'],
                { env: process.env }
              );
              log(`XDOTOOL_CLICK at=(${cb.x + pt[0]},${cb.y + pt[1]}) wid=${wid}`);
            }
          } catch (e) {
            log('XDOTOOL_ERR ' + e.message);
          }
          await sleep(2000);
        }
      }
      const obs = await js(w, 'JSON.stringify(window.__statLog || [])');
      log(`STATUS_MUTATIONS ${obs}`);
      for (let i = 0; i < 12; i += 1) {
        await sleep(400);
        const s = await state(w);
        log(
          `STOP_DIAG#${i} ${new Date().toISOString()} ` +
            (s
              ? `status="${s.status}" curIdx=${s.curIdx} playing=${s.playing} paused=${s.paused} idle=${s.idle} playBtn=${s.playBtn} startBtn=${s.startBtn}`
              : 'STATE_NULL')
        );
        if (s && s.idle && s.curIdx === -1) break;
      }
      const ss = await waitFor(w, (s) => s.idle && s.curIdx === -1, 5000, 100);
      if (ss) await cap(w, 'stopped', (s) => s.idle);
      else log('NOT_CAPTURED stopped（见 STOP_DIAG）');
      setTimeout(() => app.quit(), 300);
      return;
    }

    // 4) 「准备中…」
    if (cfg.full) {
      const prep = await waitFor(w, (s) => s.preparing, 3000, 60);
      if (prep) await cap(w, 'preparing', (s) => s.preparing);
      else log('NOT_CAPTURED preparing（首句合成窗口太短或已过去）');
    }

    // 5) 播放中 · 第 1 句（等真的出声）
    const s1 = await waitFor(w, (s) => s.playing && s.curIdx === 0, 20000, 100);
    if (s1) {
      await cap(w, 's1', (s) => s.playing && s.curIdx === 0);
      if (cfg.full) {
        // Snackbar 存活期采样（诊断 4.2s 自动消失是否属实）
        for (let i = 0; i < 28; i += 1) {
          await sleep(250);
          const s = await state(w);
          if (!s || !s.snack) {
            log(`SNACK_LIFE gone after ~${(i + 1) * 250}ms`);
            break;
          }
          if (i === 27) log('SNACK_LIFE still visible after 7000ms');
        }
      }
      // 6) 展开句列表：高亮 + 自动滚动证据
      await js(w, `window.__ppClickText('句列表')`);
      await sleep(900);
      const s1l = await state(w);
      if (s1l && s1l.listCount > 0) await cap(w, 's1-list', (s) => s.playing && s.listCount > 0);
      else log('NOTE 句列表未展开或为空');
    } else {
      log('NOT_CAPTURED s1（播放未进入第 1 句）');
    }

    // 8) 播放中 · 中间句（第 5 句 / 共 10 句）
    const mid = await waitFor(w, (s) => s.playing && s.curIdx === 4, 40000, 150);
    if (mid) {
      await cap(w, 'mid', (s) => s.playing && s.curIdx === 4);
      // 8.1 下一句 → 立刻上一句（趁句内 <1.2s，验证回到上一句；必须紧接着做，
      //     否则自然播放推进会抢先换句）
      await js(w, `window.__ppClick('[aria-label="下一句"]')`);
      const sNext = await waitFor(w, (s) => s.playing && s.curIdx === 5, 8000, 80);
      if (sNext) {
        await js(w, `window.__ppClick('[aria-label="上一句"]')`);
        const sPrev = await waitFor(w, (s) => s.playing && s.curIdx === 4, 8000, 80);
        if (sPrev) await cap(w, 'prev', (s) => s.curIdx === 4);
        else log('NOTE prev 未回到第 4 句（句内 >1.2s 时重播本句，属预期行为）');
      } else {
        log('NOT_CAPTURED next');
      }
      // 8.2 句列表滚到视口底部 + 开定时（触发一条真实通知）：验证 Snackbar 是否遮住句列表区
      await js(
        w,
        `(function(){ var items=[].slice.call(document.querySelectorAll('[aria-label*="句，共"]')); if(items.length){ items[0].parentElement.scrollIntoView({block:'end'}); return 'scrolled'; } return 'no-list'; })()`
      );
      await sleep(400);
      const ti = await js(w, `window.__ppClick('[aria-label="定时关闭"]')`);
      const chipReady = await clickWhenExists(
        w,
        `(function(){var els=[].slice.call(document.querySelectorAll('button,[role="button"]')); return els.filter(function(b){return b.textContent.trim()==='10 分钟'})[0] || null;})()`
      );
      await sleep(300);
      const t3 = await js(w, `window.__ppClickExact('开始')`);
      await sleep(500);
      const sOv = await state(w);
      if (sOv && sOv.snack) await cap(w, 'snack-overlap', (s) => !!s.snack);
      else log(`NOTE snack-overlap 未见 Snackbar（icon=${ti} preset=${chipReady} start=${t3}）`);
      const st = await state(w);
      if (st && st.timerChip) await cap(w, 'timer', (s) => s.timerChip);
      else log(`NOTE 定时 Chip 未出现（icon=${ti} preset=${chipReady} start=${t3}）`);
      // 8.3 进度/时间准确性：间隔 2s 采样，显示时间推进量应 ≈2000ms
      const t1 = Date.now();
      await sleep(2000);
      const mid2 = await state(w);
      const dt = Date.now() - t1;
      log(
        `EVID mid-advance dt=${dt}ms prog1=${mid.prog ? Math.round(mid.prog.value) : '-'} prog2=${mid2 && mid2.prog ? Math.round(mid2.prog.value) : '-'} ` +
          `time1=${mid.timeLabels ? mid.timeLabels[0] : '-'} time2=${mid2 && mid2.timeLabels ? mid2.timeLabels[0] : '-'} ` +
          `listScroll=${mid2 && mid2.listScroll ? JSON.stringify(mid2.listScroll) : '-'}`
      );
    } else {
      log('NOT_CAPTURED mid（未到中间句）');
    }

    if (cfg.full) {
      // 9) 跳转到第 9 句（点击句列表）
      const j = await js(w, `window.__ppClick('[aria-label="第 9 句，共 10 句"]')`);
      const sJump = await waitFor(w, (s) => s.playing && s.curIdx === 8, 12000, 100);
      if (sJump) await cap(w, 'jump', (s) => s.curIdx === 8);
      else log(`NOT_CAPTURED jump（click=${j}）`);
    }

    // 11) 暂停：状态 / 进度冻结 / 按钮可用性
    const p = await js(w, `window.__ppClick('[aria-label="暂停"]')`);
    const sp = await waitFor(w, (s) => s.paused, 6000, 100);
    if (sp) {
      await cap(w, 'paused', (s) => s.paused);
      await sleep(900);
      const sp2 = await state(w);
      log(
        `EVID pause-freeze prog1=${sp.prog ? Math.round(sp.prog.value) : '-'} prog2=${sp2 && sp2.prog ? Math.round(sp2.prog.value) : '-'} ` +
          `time1=${sp.timeLabels ? sp.timeLabels[0] : '-'} time2=${sp2 && sp2.timeLabels ? sp2.timeLabels[0] : '-'} ` +
          `curIdx=${sp.curIdx}->${sp2 ? sp2.curIdx : '-'} playBtn=${sp.playBtn}`
      );
      // 12) 继续播放
      const r = await js(w, `window.__ppClick('[aria-label="播放"]')`);
      const sr = await waitFor(w, (s) => s.playing, 6000, 100);
      if (sr) await cap(w, 'resumed', (s) => s.playing);
      else log(`NOT_CAPTURED resumed（click=${r}）`);
    } else {
      log(`NOT_CAPTURED paused（click=${p}）`);
    }

    // 13) 停止后：回到待开始态（带诊断采样）
    const stp = await js(w, `window.__ppClick('[aria-label="停止"]')`);
    log(`click-stop=${stp} at=${new Date().toISOString()}`);
    for (let i = 0; i < 6; i += 1) {
      await sleep(400);
      const s = await state(w);
      log(
        `STOP_DIAG#${i} ` +
          (s
            ? `status="${s.status}" curIdx=${s.curIdx} playing=${s.playing} paused=${s.paused} idle=${s.idle} playBtn=${s.playBtn} startBtn=${s.startBtn}`
            : 'STATE_NULL')
      );
      if (s && s.idle && s.curIdx === -1) break;
    }
    const ss = await waitFor(w, (s) => s.idle && s.curIdx === -1, 6000, 100);
    if (ss) {
      await cap(w, 'stopped', (s) => s.idle);
      log(
        `EVID stopped-detail curFont=${ss.curFontPx} prog=${ss.prog ? ss.prog.value + '/' + ss.prog.max : '-'} ` +
          `time=${ss.timeLabels ? ss.timeLabels.join('~') : '-'} listCount=${ss.listCount} playBtn=${ss.playBtn} startBtn=${ss.startBtn}`
      );
    } else {
      log('NOT_CAPTURED stopped（见 STOP_DIAG）');
    }
  } catch (e) {
    log('RUN_ERROR ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  }
  setTimeout(() => app.quit(), 300);
}

seedUserData();
try {
  app.requestSingleInstanceLock = () => true;
} catch (e) {
  /* noop */
}
require('../src/main/index.js');

setTimeout(() => {
  try {
    const s = require('../src/main/settingsStore').getSettings();
    log(`main settings: fontScale=${s.fontScale}`);
    BrowserWindow.getAllWindows().forEach((win) => {
      const b = win.getBounds();
      log(`window[${win.getTitle() || win.id}] ${b.width}x${b.height} visible=${win.isVisible()}`);
    });
  } catch (e) {
    log('settings probe failed: ' + e.message);
  }
}, 6500);

app.on('window-all-closed', () => app.quit());
setTimeout(() => {
  log('timeout guard: quitting');
  app.quit();
}, 150000);
