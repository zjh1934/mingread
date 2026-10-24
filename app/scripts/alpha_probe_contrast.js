// α QA 探针：HC 主题对比度计算（指标 B：所有文本 ≥7:1 WCAG AAA）
'use strict';
const fs = require('fs');
const path = require('path');
const lum = (hex) => {
  const c = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((u) => (u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
const pairs = {
  '正文 primary #ffffff / #000000': ratio('#ffffff', '#000000'),
  '次要 secondary #e6e6e6 / #000000': ratio('#e6e6e6', '#000000'),
  '禁用 disabled #b3b3b3 / #000000': ratio('#b3b3b3', '#000000'),
  '主色前景 #ffff00 / #000000': ratio('#ffff00', '#000000'),
  '主按钮文字 #000000 / #ffff00 (contained)': ratio('#000000', '#ffff00'),
  '次色前景 #00ffff / #000000': ratio('#00ffff', '#000000'),
  '成功 #7dff7d / #000000': ratio('#7dff7d', '#000000'),
  '警告 #ffd400 / #000000': ratio('#ffd400', '#000000'),
  '错误 #ff8080 / #000000': ratio('#ff8080', '#000000'),
  '信息 #66ccff / #000000': ratio('#66ccff', '#000000'),
  '浅色主题次要 #4a5261 / #ffffff': ratio('#4a5261', '#ffffff'),
  '深色主题次要 #c3cbd9 / #0c0f16': ratio('#c3cbd9', '#0c0f16'),
};
const out = [];
let bad = 0;
Object.keys(pairs).forEach((k) => {
  const r = pairs[k];
  const ok = r >= 7;
  if (!ok) bad += 1;
  out.push(`${ok ? 'PASS' : 'FAIL'} ${r.toFixed(2)}:1  ${k}`);
});
out.push(`\n指标 B：${bad === 0 ? 'PASS' : 'FAIL'}（${Object.keys(pairs).length - bad}/${Object.keys(pairs).length} 项 ≥ 7:1）`);
fs.writeFileSync(path.join(__dirname, 'alpha_probe_contrast.txt'), out.join('\n') + '\n');
console.log(out.join('\n'));
