// W-DYNVOICE 探针：动态音色注册（音色源装好的新音色要能被选到）。
//
// 纯 Node，不依赖 electron / Windows / 真实语音：
//   node scripts/tmp_probe_WDYNVOICE.js
//
// 验证点：
//   ① 注册 2 个动态音色 → voiceKeyOf 能解析、VOICE_KEYS 含它们
//   ② 重复 key（含与内置同名）→ 不重复追加、不覆盖内置
//   ③ 内置 xiaoxiao / yunxi / system 两级兜底行为不变
//   ④ clearDynamicVoices() 后完全恢复原状
//   ⑤ 动态音色存在时，只有 Huihui 的系统语音仍只判成 system（不被动态项误判）
'use strict';

const path = require('path');

const CATALOG = path.join(__dirname, '..', 'src', 'main', 'backends', 'voiceCatalog');
const catalog = require(CATALOG);

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`);
  }
}

const XIAOXIAO_NVSA = 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)';
const YUNXI_NVSA = 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)';
const HUIHUI = 'Microsoft Huihui - Chinese (Simplified)';

// 原始目录快照（用来验证 ④ 是否真的恢复）
const ORIG_VOICE_KEYS = catalog.VOICE_KEYS.slice();
const ORIG_SAPI_KEYS = catalog.SAPI_VOICES.map((d) => d.key);
const ORIG_CHAIN_KEYS = Object.keys(catalog.VOICE_FALLBACK_CHAIN).sort();

const keysOf = (picked) => (picked || []).map((x) => x.key);

console.log('\n=== 0. 基线快照 ===');
check('内置键 = xiaoxiao / yunxi / system', ORIG_VOICE_KEYS.join(',') === 'xiaoxiao,yunxi,system', ORIG_VOICE_KEYS);
check('内置 SAPI 目录 3 项', ORIG_SAPI_KEYS.length === 3, ORIG_SAPI_KEYS);

console.log('\n=== 1. 注册 2 个动态音色 ===');
const reg1 = catalog.registerDynamicVoices([
  { key: 'xiaochen', displayName: '晓晨', gender: 'female', locale: 'zh-CN', desc: '测试音色 A' },
  { key: 'yunye', displayName: '云野', gender: 'male', locale: 'zh-CN' },
]);
check('added = 2', reg1.added.length === 2, reg1.added);
check('无 ignored', reg1.ignored.length === 0, reg1.ignored);
check('voiceKeyOf("sapi:xiaochen") = xiaochen', catalog.voiceKeyOf('sapi:xiaochen') === 'xiaochen', catalog.voiceKeyOf('sapi:xiaochen'));
check('voiceKeyOf("xiaochen")（无前缀）也能解析', catalog.voiceKeyOf('xiaochen') === 'xiaochen', catalog.voiceKeyOf('xiaochen'));
check('voiceKeyOf("sapi:yunye") = yunye', catalog.voiceKeyOf('sapi:yunye') === 'yunye');
check('VOICE_KEYS 含两个新 key', catalog.VOICE_KEYS.indexOf('xiaochen') >= 0 && catalog.VOICE_KEYS.indexOf('yunye') >= 0, catalog.VOICE_KEYS);
check('SAPI_VOICES 追加了同构定义', catalog.SAPI_VOICES.filter((d) => d.dynamic).length === 2, catalog.SAPI_VOICES.map((d) => d.key));
check('getDynamicVoices() = 2 且带 id/name', catalog.getDynamicVoices().length === 2 && catalog.getDynamicVoices()[0].id === 'sapi:xiaochen', catalog.getDynamicVoices());
check('新 key 的兜底链为空数组', Array.isArray(catalog.VOICE_FALLBACK_CHAIN.xiaochen) && catalog.VOICE_FALLBACK_CHAIN.xiaochen.length === 0, catalog.VOICE_FALLBACK_CHAIN.xiaochen);
check('fallbackKeysOf(xiaochen) = []（不会链到别人的音色）', catalog.fallbackKeysOf('xiaochen').length === 0, catalog.fallbackKeysOf('xiaochen'));
check('voicePlanOf(xiaochen) 只有自身', (() => {
  const p = catalog.voicePlanOf('xiaochen');
  return p.length === 1 && p[0].key === 'xiaochen' && p[0].isFallback === false;
})(), catalog.voicePlanOf('xiaochen'));
check('默认兜底链未被改动（yunxi → xiaoxiao）', catalog.fallbackKeysOf('yunxi').join(',') === 'xiaoxiao', catalog.fallbackKeysOf('yunxi'));

console.log('\n=== 2. 重复 key：不重复追加、不覆盖内置 ===');
const sapiLenBefore = catalog.SAPI_VOICES.length;
const keysLenBefore = catalog.VOICE_KEYS.length;
const reg2 = catalog.registerDynamicVoices([
  { key: 'xiaochen', displayName: '冒名的晓晨' },
  { key: 'xiaoxiao', displayName: '冒名的晓晓', gender: 'male' },
  { key: 'yunye', displayName: '云野' },
]);
check('added = 0（全部忽略）', reg2.added.length === 0, reg2.added);
check('ignored = 3 且原因可分辨', reg2.ignored.length === 3 && reg2.ignored.some((x) => x.reason === 'BUILTIN_KEY'), reg2.ignored);
check('SAPI_VOICES 长度未变', catalog.SAPI_VOICES.length === sapiLenBefore, [sapiLenBefore, catalog.SAPI_VOICES.length]);
check('VOICE_KEYS 长度未变', catalog.VOICE_KEYS.length === keysLenBefore, [keysLenBefore, catalog.VOICE_KEYS.length]);
check('重复注册有 warning 记录', catalog.getDynamicVoiceWarnings().some((w) => w.code === 'DYNAMIC_VOICE_DUPLICATE'), catalog.getDynamicVoiceWarnings());
const xx = catalog.SAPI_VOICES.find((d) => d.key === 'xiaoxiao');
check('内置 xiaoxiao 未被覆盖（name/gender/keywords 原样）', xx.name === '晓晓' && xx.gender === 'female' && xx.keywords.join(',') === 'xiaoxiao,晓晓', xx);
const xc = catalog.SAPI_VOICES.find((d) => d.key === 'xiaochen');
check('动态 xiaochen 未被覆盖', xc.name === '晓晨', xc);

console.log('\n=== 3. 内置两级兜底不变（动态音色在场时）===');
const p3a = catalog.pickSapiVoices([XIAOXIAO_NVSA, YUNXI_NVSA]);
check('晓晓 + 云希 = 2 个 nvsa', p3a.length === 2 && p3a.every((x) => x.kind === 'nvsa'), p3a);
check('顺序仍是内置优先（xiaoxiao, yunxi）', keysOf(p3a).join(',') === 'xiaoxiao,yunxi', keysOf(p3a));
const p3b = catalog.pickSapiVoices([HUIHUI]);
check('只有 Huihui → 只有 system', p3b.length === 1 && p3b[0].key === 'system' && p3b[0].kind === 'system', p3b);
check('system 的 id 未变', p3b[0].id === 'sapi:system', p3b[0].id);
check('空枚举 → 空结果（不因动态音色凭空造出可用）', catalog.pickSapiVoices([]).length === 0);
check('matchesVoice 仍按 keywords 子串匹配', catalog.matchesVoice(XIAOXIAO_NVSA, catalog.SAPI_VOICES[0]) === true);

console.log('\n=== 3b. 动态音色真的装了 → 能被挑中并可选用 ===');
const p3c = catalog.pickSapiVoices([XIAOXIAO_NVSA, 'Microsoft Xiaochen Online (Natural) - Chinese (Mainland)']);
check('内置 + 动态同列（2 个）', p3c.length === 2, p3c);
check('动态 key 出现在结果里', keysOf(p3c).indexOf('xiaochen') >= 0, keysOf(p3c));
check('动态项 kind = nvsa', (p3c.find((x) => x.key === 'xiaochen') || {}).kind === 'nvsa', p3c);
// 复刻 synthesize() 的选音色表达式（不启通道）：voiceKeyOf → find → 回落 picked[0]
const picked3c = p3c;
const keyOfDyn = catalog.voiceKeyOf('sapi:xiaochen') || 'xiaoxiao';
const chosen = picked3c.find((x) => x.key === keyOfDyn) || picked3c[0];
check('synthesize 选音色逻辑命中山动态音色', chosen.key === 'xiaochen', chosen);
const keyOfUnknown = catalog.voiceKeyOf('sapi:not-installed') || 'xiaoxiao';
const chosenUnknown = picked3c.find((x) => x.key === keyOfUnknown) || picked3c[0];
check('未知 key 不抛错、回落 picked[0]', chosenUnknown.key === 'xiaoxiao', chosenUnknown);

console.log('\n=== 5. 动态音色 keywords 写宽了也不抢系统兜底 ===');
const reg5 = catalog.registerDynamicVoices([
  { key: 'broadvoice', displayName: '宽关键字音色', keywords: ['chinese', '中文', 'broadvoice'] },
]);
check('宽关键字音色注册成功', reg5.added.join(',') === 'broadvoice', reg5);
const p5 = catalog.pickSapiVoices([HUIHUI]);
check('仍只返回 system（不因动态项误判）', p5.length === 1 && p5[0].key === 'system', p5);
check('动态项没有把 Huihui 抢走', keysOf(p5).indexOf('broadvoice') < 0, keysOf(p5));
const p5b = catalog.pickSapiVoices(['Microsoft Broadvoice Online (Natural) - Chinese (Mainland)']);
check('真装了自然语音时动态项仍可被选中', keysOf(p5b).indexOf('broadvoice') >= 0, p5b);

console.log('\n=== 4. clearDynamicVoices() → 完全恢复原状 ===');
const removed = catalog.clearDynamicVoices();
check('移除 3 个动态音色', removed === 3, removed);
check('VOICE_KEYS 恢复原样', catalog.VOICE_KEYS.join(',') === ORIG_VOICE_KEYS.join(','), catalog.VOICE_KEYS);
check('SAPI_VOICES 恢复原样', catalog.SAPI_VOICES.map((d) => d.key).join(',') === ORIG_SAPI_KEYS.join(','), catalog.SAPI_VOICES.map((d) => d.key));
check('VOICE_FALLBACK_CHAIN 恢复原样', Object.keys(catalog.VOICE_FALLBACK_CHAIN).sort().join(',') === ORIG_CHAIN_KEYS.join(','), Object.keys(catalog.VOICE_FALLBACK_CHAIN));
check('getDynamicVoices() 为空', catalog.getDynamicVoices().length === 0, catalog.getDynamicVoices());
check('voiceKeyOf("sapi:xiaochen") → null', catalog.voiceKeyOf('sapi:xiaochen') === null, catalog.voiceKeyOf('sapi:xiaochen'));
check('兜底行为回到原样（Huihui → system）', keysOf(catalog.pickSapiVoices([HUIHUI])).join(',') === 'system', catalog.pickSapiVoices([HUIHUI]));
check('兜底行为回到原样（晓晓+云希 → 2 nvsa）', keysOf(catalog.pickSapiVoices([XIAOXIAO_NVSA, YUNXI_NVSA])).join(',') === 'xiaoxiao,yunxi');

console.log('\n=== 6. sapiBackend 集成：注册后被 listVoices 列出 ===');
function loadBackend() {
  // eslint-disable-next-line global-require
  return require(path.join(__dirname, '..', 'src', 'main', 'backends', 'sapiBackend'));
}
let backendOk = true;
let b = null;
try {
  const SapiBackend = loadBackend();
  b = new SapiBackend();
  catalog.registerDynamicVoices([{ key: 'xiaochen', displayName: '晓晨', gender: 'female', locale: 'zh-CN' }]);
  // 注入一份「已探测」结果，等价于系统枚举到三条语音（含新装的晓晨）
  b._probe = {
    at: Date.now(),
    value: {
      available: true,
      kind: 'nvsa',
      installed: [XIAOXIAO_NVSA, 'Microsoft Xiaochen Online (Natural) - Chinese (Mainland)'],
      voices: catalog.pickSapiVoices([XIAOXIAO_NVSA, 'Microsoft Xiaochen Online (Natural) - Chinese (Mainland)']),
    },
  };
  const list = b.listVoices();
  check('listVoices 含新装动态音色', list.some((v) => v.id === 'sapi:xiaochen'), list.map((v) => v.id));
  check('动态音色 displayName / locale 正确', (() => {
    const v = list.find((x) => x.id === 'sapi:xiaochen') || {};
    return v.displayName === '晓晨' && v.locale === 'zh-CN' && v.source === 'offline' && v.available === true;
  })(), list.find((x) => x.id === 'sapi:xiaochen'));
  check('未装到系统的动态音色不会被列出', !list.some((v) => v.id === 'sapi:yunye'), list.map((v) => v.id));
  // 已注册但枚举里没有 → probe 不得因此判定可用
  const p = catalog.pickSapiVoices([]);
  check('未装到系统时 pick 结果为空（可用性只认枚举）', p.length === 0, p);

  const info = b.getInfo();
  check('getInfo().dynamicVoices 有可用性字段', !!info.dynamicVoices && typeof info.dynamicVoices.ready === 'boolean', info.dynamicVoices);
} catch (e) {
  backendOk = false;
  check(`sapiBackend 集成可运行（${(e && e.message) || e}）`, false, (e && e.stack) || '');
}
if (b) {
  try {
    b.dispose();
  } catch (e) {
    /* 未启动的通道 dispose 不应影响结论 */
  }
}
if (backendOk) catalog.clearDynamicVoices();
check('收尾：目录已回到内置三件套', catalog.SAPI_VOICES.map((d) => d.key).join(',') === ORIG_SAPI_KEYS.join(','), catalog.SAPI_VOICES.map((d) => d.key));

console.log(`\n结果：PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
