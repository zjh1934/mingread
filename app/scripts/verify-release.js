// 验收 Release：不只看"接口返回 200"，还要确认
// 用法：GH_TOKEN=xxx RELEASE_ID=123456 node scripts/verify-release.js
//    或 GH_TOKEN=xxx node scripts/verify-release.js   （默认检查 latest）
//   1) 两个附件都是 uploaded 状态、体积正确
//   2) 下载链接真的能拿到（302 → 200）
//   3) 发布说明里的文件名与资产名一致（上一轮就栽在「说明写的是中文名、资产是 ASCII」）
'use strict';

const https = require('https');

const TOKEN = process.env.GH_TOKEN || '';
const OWNER = 'zjh1934';
const REPO = 'mingread';
const RELEASE_ID = process.env.RELEASE_ID || '';

function api(path) {
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: 'api.github.com',
          path,
          headers: {
            Authorization: 'Bearer ' + TOKEN,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'mingread-audit',
          },
        },
        (res) => {
          let s = '';
          res.on('data', (d) => { s += d; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(s));
            } catch (e) {
              reject(new Error('JSON 解析失败: ' + s.slice(0, 200)));
            }
          });
        }
      )
      .on('error', reject);
  });
}

function head(url) {
  return new Promise((resolve) => {
    https
      .get(url, { method: 'HEAD', headers: { 'User-Agent': 'mingread-audit' } }, (res) => {
        resolve({ status: res.statusCode, len: res.headers['content-length'] });
        res.resume();
      })
      .on('error', (e) => resolve({ status: 'ERR ' + e.message }));
  });
}

let failed = 0;
function check(id, desc, ok, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${desc}   |  ${detail}`);
}

(async () => {
  const rel = RELEASE_ID
    ? await api(`/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}`)
    : await api(`/repos/${OWNER}/${REPO}/releases/latest`);
  console.log(`[rel] ${rel.name} | tag=${rel.tag_name} | draft=${rel.draft} | prerelease=${rel.prerelease}`);
  console.log(`[rel] ${rel.html_url}`);

  check('A1', '已正式发布（非草稿、非预发布）', rel.draft === false && rel.prerelease === false, `draft=${rel.draft} pre=${rel.prerelease}`);
  check('A2', '发布说明不为空', (rel.body || '').length > 200, `${(rel.body || '').length} 字`);

  const body = rel.body || '';
  const assets = rel.assets || [];
  check('A3', '附件有 2 个', assets.length === 2, assets.map((a) => a.name).join(', '));

  for (const a of assets) {
    const mb = (a.size / 1048576).toFixed(1);
    check(`B-${a.name}`, `state=uploaded 且体积合理`, a.state === 'uploaded' && a.size > 50 * 1048576, `${a.state} ${mb}MB`);
    // 说明里必须提到这个确切文件名
    check(`C-${a.name}`, '发布说明提到了这个文件名', body.indexOf(a.name) >= 0, body.indexOf(a.name) >= 0 ? '一致' : '**说明与资产名不一致**');
    const dl = await head(a.browser_download_url);
    check(`D-${a.name}`, '下载链接可访问', dl.status === 302 || dl.status === 200, `HTTP ${dl.status}`);
  }

  // latest 指向哪里
  const latest = await api(`/repos/${OWNER}/${REPO}/releases/latest`);
  check('E1', 'latest 指向本版本', latest.tag_name === rel.tag_name, `latest=${latest.tag_name}`);

  console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : 'HAS FAIL'} 失败=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
