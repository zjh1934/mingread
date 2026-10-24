// 静态契约审计：找出「调用了不存在的东西」这一类问题。
//
// 人工看代码容易漏，这类问题适合机器查：
//   1. preload 里 ipcRenderer.invoke/on 的通道 → 主进程有没有对应的 ipcMain.handle/on
//   2. 主进程注册的通道 → preload 有没有暴露（反向，用于发现死通道）
//   3. 渲染层调的 bridge 方法 → preload 的 api 对象里有没有这个 key
//   4. 所有本地 require/import 的路径是否存在（断链 = 虚空引用）
//   5. 主进程模块之间的循环依赖
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const problems = [];
const warnings = [];

function add(list, kind, detail) {
  list.push({ kind, detail });
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC, []);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// 1) IPC 通道对齐
// ---------------------------------------------------------------------------
const mainChannels = new Map(); // channel -> [files]

// 有些通道用常量注册（ipcMain.handle(C.IPC_A11Y_ANNOUNCE, ...)），
// 静态正则只看到变量名。这里把 constants 里所有 'xxx:yyy' 形状的值先收进来。
try {
  const constSrc = fs.readFileSync(path.join(SRC, 'shared', 'constants.js'), 'utf8');
  const rc = /IPC_[A-Z0-9_]+\s*:\s*['"]([^'"]+)['"]/g;
  let mc;
  while ((mc = rc.exec(constSrc)) !== null) mainChannels.set(mc[1], ['shared/constants.js(常量)']);
} catch (e) {
  /* 没有 constants 文件就跳过 */
}

// 有些模块用 Object.entries(handlers).forEach(([ch, fn]) => ipcMain.handle(ch, fn)) 动态注册，
// 静态分析看不到具体通道名。检测到这种写法就不再把「未匹配」当成硬错误。
let hasDynamicRegister = false;
const preloadInvoke = new Map();
const preloadOn = new Map();

for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  if (f.includes(`${path.sep}main${path.sep}`)) {
    const re = /ipcMain\.(handle|on)\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const ch = m[2];
      if (!mainChannels.has(ch)) mainChannels.set(ch, []);
      mainChannels.get(ch).push(rel(f));
    }
    // 动态注册模式：ipcMain.handle(ch, ...) / ipcMain.on(ch, ...)
    if (/ipcMain\.(?:handle|on)\(\s*[A-Za-z_$]/.test(txt) && /Object\.entries\(/.test(txt)) {
      hasDynamicRegister = true;
    }
  }
  if (f.includes(`${path.sep}preload${path.sep}`)) {
    const reI = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = reInvoke()) !== null) { /* placeholder */ }
    function reInvoke() { return null; }
    let mm;
    const ri = /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g;
    while ((mm = ri.exec(txt)) !== null) {
      if (!preloadInvoke.has(mm[1])) preloadInvoke.set(mm[1], []);
      preloadInvoke.get(mm[1]).push(rel(f));
    }
    const rn = /ipcRenderer\.(?:on|once)\(\s*['"]([^'"]+)['"]/g;
    while ((mm = rn.exec(txt)) !== null) {
      if (!preloadOn.has(mm[1])) preloadOn.set(mm[1], []);
      preloadOn.get(mm[1]).push(rel(f));
    }
  }
}

for (const [ch, who] of preloadInvoke) {
  if (!mainChannels.has(ch)) {
    if (hasDynamicRegister) {
      // 主进程存在动态注册 → 静态分析无法确认，交给运行时脚本 tmp_audit_ipc_runtime.js
      add(warnings, 'IPC 动态', `preload invoke '${ch}' 未见字面量注册（主进程含动态注册，需运行时确认）`);
    } else {
      add(problems, 'IPC 断链', `preload invoke '${ch}' 没有对应的 ipcMain.handle（${who.join(',')}）`);
    }
  }
}
// 收集主进程所有 webContents.send / win.webContents.send 的通道名
const sendChannels = new Set();
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const rs = /(?:webContents\.send|\bsend\(|sendToWindow\([^,]+,\s*)\(?\s*['"]([^'"]+)['"]/g;
  let mm;
  while ((mm = rs.exec(txt)) !== null) sendChannels.add(mm[1]);
  // 处理 sendToWindow(win, 'chan', ...) 这种两参形式
  const rs2 = /sendToWindow\([^,]+,\s*['"]([^'"]+)['"]/g;
  while ((mm = rs2.exec(txt)) !== null) sendChannels.add(mm[1]);
}

for (const [ch, who] of preloadOn) {
  if (!mainChannels.has(ch) && !sendChannels.has(ch)) {
    // 渲染层发出去的事件（ipcRenderer.send）也可能在这里，先记为待确认
    add(warnings, 'IPC 订阅', `preload 订阅 '${ch}'，主进程未见同名 handle/on（可能由 webContents.send 单向发出，需人工确认）（${who.join(',')}）`);
  }
}

// ---------------------------------------------------------------------------
// 2) 渲染层调用的 bridge 方法 vs preload 暴露的 key
// ---------------------------------------------------------------------------
const preloadSrc = fs.readFileSync(path.join(SRC, 'preload', 'index.js'), 'utf8');
// 粗提取 api 对象的第一层 key：形如 "\n  keyName:" 或 "\n  keyName("
const apiKeys = new Set();
{
  const body = preloadSrc.slice(preloadSrc.indexOf('const api = {'));
  const re = /^\s{2}([A-Za-z_$][\w$]*)\s*[:(]/gm;
  let m;
  while ((m = re.exec(body)) !== null) apiKeys.add(m[1]);
}

const rendererFiles = files.filter((f) => f.includes(`${path.sep}renderer${path.sep}`));
const calls = new Map(); // method -> files
for (const f of rendererFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  // window.langdu.xxx / window.mingread.xxx / api()?.xxx / bridge()?.xxx
  const re = /(?:window\.(?:langdu|mingread)|bridge\(\)|api\(\))\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    if (!calls.has(m[1])) calls.set(m[1], new Set());
    calls.get(m[1]).add(rel(f));
  }
}
for (const [method, who] of calls) {
  if (!apiKeys.has(method)) {
    add(problems, 'bridge 断链', `渲染层调用 .${method}()，但 preload 的 api 里没有这个 key（${[...who].join(',')}）`);
  }
}

// ---------------------------------------------------------------------------
// 3) 本地 require/import 路径是否存在
// ---------------------------------------------------------------------------
for (const f of files) {
  const txt = fs.readFileSync(f, 'utf8');
  const dir = path.dirname(f);
  const re = /(?:require\(\s*['"](\.[^'"]+)['"]\s*\)|from\s+['"](\.[^'"]+)['"])/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const spec = m[1] || m[2];
    const base = path.resolve(dir, spec);
    const cands = [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.jsx')];
    if (!cands.some((c) => fs.existsSync(c))) {
      add(problems, '断链引用', `${rel(f)} 引用了不存在的路径 '${spec}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4) 主进程模块循环依赖（只查 src/main 内的相对 require）
// ---------------------------------------------------------------------------
const graph = new Map();
for (const f of files.filter((x) => x.includes(`${path.sep}main${path.sep}`))) {
  const txt = fs.readFileSync(f, 'utf8');
  const dir = path.dirname(f);
  const deps = [];
  // 只统计行首（无缩进）的 require —— 那才是模块加载时就执行的顶层依赖。
  // 函数体内的 require 是惰性的，不会形成加载期循环。
  const topLevel = txt
    .split(/\r?\n/)
    .filter((line) => /^[^\s\/]/.test(line) && line.indexOf('require(') >= 0)
    .join('\n');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(topLevel)) !== null) {
    const base = path.resolve(dir, m[1]);
    for (const c of [`${base}.js`, path.join(base, 'index.js'), base]) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        deps.push(c);
        break;
      }
    }
  }
  graph.set(f, deps);
}
const state = new Map(); // 0=未访问 1=栈中 2=完成
const cycles = [];
function dfs(node, stack) {
  state.set(node, 1);
  stack.push(node);
  for (const d of graph.get(node) || []) {
    if (state.get(d) === 1) {
      const i = stack.indexOf(d);
      cycles.push(stack.slice(i).concat(d).map(rel).join(' -> '));
    } else if (!state.get(d)) {
      dfs(d, stack);
    }
  }
  stack.pop();
  state.set(node, 2);
}
for (const n of graph.keys()) if (!state.get(n)) dfs(n, []);
for (const c of cycles) add(problems, '循环依赖', c);

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
console.log('='.repeat(70));
console.log(`扫描文件 ${files.length} 个 | 主进程通道 ${mainChannels.size} 个 | preload 暴露 key ${apiKeys.size} 个`);
console.log(`动态注册检测：${hasDynamicRegister ? '存在（部分通道需运行时确认）' : '无'}`);
console.log('='.repeat(70));

if (problems.length) {
  console.log(`\n【必须修】${problems.length} 项`);
  for (const p of problems) console.log(`  [${p.kind}] ${p.detail}`);
} else {
  console.log('\n【必须修】0 项');
}

if (warnings.length) {
  console.log(`\n【待确认】${warnings.length} 项`);
  for (const w of warnings) console.log(`  [${w.kind}] ${w.detail}`);
}

// 顺便列出「注册了但没人用」的通道，帮助发现死代码
const unused = [...mainChannels.keys()].filter((ch) => !preloadInvoke.has(ch) && !preloadOn.has(ch));
if (unused.length) {
  console.log(`\n【主进程注册但 preload 未使用】${unused.length} 个（可能是内部 send 通道或死代码）`);
  console.log('  ' + unused.join('\n  '));
}

// 主进程 send 了但没人订阅（渲染层没监听）—— 通常是历史残留
const orphanSends = [...sendChannels].filter((ch) => !preloadOn.has(ch) && !preloadInvoke.has(ch) && !mainChannels.has(ch));
if (orphanSends.length) {
  console.log(`\n【主进程 send 但无人订阅】${orphanSends.length} 个（历史残留，可清理）`);
  console.log('  ' + orphanSends.join('\n  '));
}

process.exit(problems.length ? 1 : 0);
