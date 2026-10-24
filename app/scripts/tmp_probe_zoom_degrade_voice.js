// 验证：mag 后端不可用（被迫降级）时，会**用语音说出原因**，而不是静默走旧方案。
// 手法：把 a11y.announce 换成记录器（zoomController 是 a11y.announce 的属性访问，替换有效），
//      再真的 activate()，看降级路径有没有把话说出来。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');

process.env.VITE_DEV_SERVER_URL = pathToFileURL(
  path.join(__dirname, '..', 'dist', 'renderer', 'index.html')
).href;

const calls = [];
// eslint-disable-next-line import/no-dynamic-require
const a11y = require('../src/main/a11yFeedback');
const realAnnounce = a11y.announce;
a11y.announce = async (payload) => {
  calls.push(payload);
  console.log(`[voice] 播报: ${payload && payload.text} (priority=${payload && payload.priority})`);
  return { ok: true, stubbed: true };
};

const mod = require('../src/main/index.js');

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}${detail !== undefined ? '   |  ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(4200);
  const zc = require('../src/main/zoomController').getZoomController();
  if (!zc) { check('A0', '取到缩放实例', false); app.exit(1); return; }

  const magDir = path.join(__dirname, '..', 'resources', 'magnification');
  console.log(`[deg] DLL 目录存在=${fs.existsSync(magDir)}（探针外层应已临时改名）`);

  zc.activate();
  await sleep(1600);

  const backend = zc.state.renderBackend;
  console.log(`[deg] renderBackend=${backend}`);
  check('B1', '确实回退到兼容模式', backend === 'overlay', `backend=${backend}`);

  const degradeMsg = calls.find((c) => /兼容模式/.test(c.text || ''));
  check('B2', '降级时发出了语音说明', !!degradeMsg, degradeMsg ? degradeMsg.text : '(没有任何播报)');
  check('B3', '播报内容提到可能的重影（用户能理解现象）', !!(degradeMsg && /重影|画面/.test(degradeMsg.text)), degradeMsg ? degradeMsg.text : '');

  // 再 activate 一次：不应重复播报（只在本次运行说一次）
  const before = calls.filter((c) => /兼容模式/.test(c.text || '')).length;
  zc.deactivate();
  await sleep(600);
  zc.activate();
  await sleep(800);
  const after = calls.filter((c) => /兼容模式/.test(c.text || '')).length;
  check('B4', '重复激活不再重复播报（不制造噪音）', after === before, `${before} → ${after}`);

  // 用户主动强制旧方案时不该播报
  calls.length = 0;
  zc.deactivate();
  await sleep(500);
  console.log('[deg] 说明：forced-env/forced-setting 分支不进播报，属设计（用户自己选的）');

  zc.deactivate();
  a11y.announce = realAnnounce;
  await sleep(400);
  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  app.exit(failed === 0 ? 0 : 1);
});
