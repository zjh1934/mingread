// 创建 GitHub Release。
// 用法：GH_TOKEN=xxx VERSION=3.2.3 RELEASE_BODY=scripts/release-notes/v3.2.3.md node scripts/create-release.js
// 正文从文件读，不走命令行参数——之前踩过「中文参数在 Git Bash 里被剥离」的坑。
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.GH_TOKEN || '';
if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const VERSION = process.env.VERSION || '0.0.0';
const BODY_PATH = path.resolve(__dirname, '..', process.env.RELEASE_BODY || 'tmp_release_body.md');
const body = fs.readFileSync(BODY_PATH, 'utf8');
const payload = JSON.stringify({
  tag_name: `v${VERSION}`,
  name: `明读 v${VERSION}`,
  body,
  draft: false,
  prerelease: false,
});

const req = https.request(
  {
    hostname: 'api.github.com',
    path: '/repos/zjh1934/mingread/releases',
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': 'mingread-release',
    },
  },
  (res) => {
    let s = '';
    res.on('data', (d) => { s += d; });
    res.on('end', () => {
      try {
        const j = JSON.parse(s);
        console.log('status=' + res.statusCode);
        if (j.id) {
          console.log('release_id=' + j.id);
          console.log('url=' + j.html_url);
          console.log(`下一步：RELEASE_DIR=releaseNN RELEASE_ASSET_VER=${VERSION} RELEASE_ID=${j.id} node scripts/upload-release-assets.js`);
        } else {
          console.log(s.slice(0, 400));
        }
      } catch (e) {
        console.log('解析失败: ' + s.slice(0, 300));
      }
    });
  }
);
req.on('error', (e) => console.log('ERR ' + e.message));
req.write(payload);
req.end();
