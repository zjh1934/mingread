// 旧配置兼容测试（settingsStore 权威源，纯 node 可跑，不依赖 Electron app）：
//   node scripts/tmp_probe_legacy_settings.js
//
// 覆盖基线 P2-11 / P1-9 的兼容语义：
//   - 无配置文件            → hotkey=Ctrl+Alt+R, clipboardAuto=true
//   - 旧默认 F1             → 迁移为 Ctrl+Alt+R 并落盘（用户没自选过，不能强行留 F1）
//   - 更旧默认 Control+Alt+S → 迁移为 Ctrl+Alt+R 并落盘
//   - 用户自选值             → 一律原样保留，不改写（含 F1 变体如 Ctrl+Alt+F1 / Shift+F1）
//   - 旧配置显式 clipboardAuto:false → 保留 false（升级不强行开启用户关过的功能）
//   - 旧配置无 clipboardAuto 字段    → 默认 true
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ldn-legacy-'));
const settingsStore = require('../src/main/settingsStore');

let fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) fail += 1;
}

function writeSettings(obj) {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, 'settings.json'), JSON.stringify(obj, null, 2), 'utf8');
}
function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// 1. 无配置文件 → 新默认
settingsStore._setSettingsPathForTest(path.join(TMP, 'settings.json'));
try { fs.unlinkSync(path.join(TMP, 'settings.json')); } catch (e) { /* noop */ }
let s = settingsStore.getSettings();
check('无配置 → hotkey=Ctrl+Alt+R', s.hotkey === 'Ctrl+Alt+R', s.hotkey);
check('无配置 → clipboardAuto=true', s.clipboardAuto === true, String(s.clipboardAuto));

// 2. 旧默认 F1 → 迁移并落盘
writeSettings({ hotkey: 'F1', clipboardAuto: false });
s = settingsStore.getSettings();
check('旧默认 F1 → 迁移为 Ctrl+Alt+R', s.hotkey === 'Ctrl+Alt+R', s.hotkey);
check('旧默认 F1 → 已落盘', readSettingsFile() && readSettingsFile().hotkey === 'Ctrl+Alt+R');
check('旧配置 clipboardAuto:false → 保留', s.clipboardAuto === false, String(s.clipboardAuto));

// 3. 更旧默认 Control+Alt+S → 迁移并落盘
writeSettings({ hotkey: 'Control+Alt+S' });
s = settingsStore.getSettings();
check('旧默认 Control+Alt+S → 迁移为 Ctrl+Alt+R', s.hotkey === 'Ctrl+Alt+R', s.hotkey);
check('Control+Alt+S → 已落盘', readSettingsFile().hotkey === 'Ctrl+Alt+R');

// 4. 用户自选值保留（不动盘）
writeSettings({ hotkey: 'Ctrl+Alt+F1' });
s = settingsStore.getSettings();
check('用户自选 Ctrl+Alt+F1 → 保留', s.hotkey === 'Ctrl+Alt+F1', s.hotkey);
check('用户自选值 → 不重写文件', readSettingsFile().hotkey === 'Ctrl+Alt+F1');

// 5. 用户自选 Shift+F1 保留
writeSettings({ hotkey: 'Shift+F1' });
s = settingsStore.getSettings();
check('用户自选 Shift+F1 → 保留', s.hotkey === 'Shift+F1', s.hotkey);

// 6. 旧配置无 clipboardAuto → 默认 true
writeSettings({ hotkey: 'Ctrl+Alt+R' });
s = settingsStore.getSettings();
check('旧配置无 clipboardAuto → 默认 true', s.clipboardAuto === true, String(s.clipboardAuto));

// 7. saveSettings 合并语义
s = settingsStore.saveSettings({ clipboardAuto: false });
check('saveSettings 可关复制即读', s.clipboardAuto === false && readSettingsFile().clipboardAuto === false);
s = settingsStore.saveSettings({ hotkey: 'F1' });
check('用户主动把热键设为 F1（可选预设）→ 允许并保留', s.hotkey === 'F1' && readSettingsFile().hotkey === 'F1');

console.log(`\n旧配置兼容测试：FAIL=${fail}`);
process.exit(fail ? 1 : 0);
