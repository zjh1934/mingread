// 全量语法检查（主进程 / preload / shared）：node --check 等价
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src/main', 'src/preload', 'src/shared'];

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile() && p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

let fail = 0;
let ok = 0;
for (const d of DIRS) {
  const abs = path.join(ROOT, d);
  if (!fs.existsSync(abs)) continue;
  for (const file of walk(abs)) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      ok += 1;
    } catch (e) {
      fail += 1;
      console.error(`[FAIL] ${path.relative(ROOT, file)}`);
      console.error(String(e.stderr || e.message).split('\n').slice(0, 4).join('\n'));
    }
  }
}
console.log(`语法检查：OK=${ok} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
