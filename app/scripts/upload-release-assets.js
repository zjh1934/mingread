// 上传 Release 附件（流式，无 curl 超时问题，文件名纯 ASCII 避免编码坑）。
//
// 为什么不用 curl：
//   1) Git Bash 把中文参数传给 node/curl 时会丢字符，导致资产名变成 "MingRead-2.4.0-.exe"；
//   2) curl -m 600 到点会切断连接，GitHub 侧资产卡在 starter 状态（实测踩到）。
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'zjh1934';
const REPO = 'mingread';
const RELEASE_ID = Number(process.env.RELEASE_ID) || 422845721; // 发新版时用 RELEASE_ID=xxx 覆盖
const TOKEN = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('[up] 缺少 GH_TOKEN');
  process.exit(1);
}

// 目录与目标名：源文件用扩展名扫描定位，不在代码里写中文文件名
// （Git Bash → node 传中文参数会丢字符，这也是上一轮资产名变成 "MingRead-2.4.0-.exe" 的原因）
// 发版时用 RELEASE_DIR / RELEASE_ASSET_VER 覆盖，避免每次改源码
const SRC_DIR = path.resolve(__dirname, '..', process.env.RELEASE_DIR || 'release6');
const ASSET_VER = process.env.RELEASE_ASSET_VER || '2.4.0';
const TARGETS = [
  // 名称用纯 ASCII：Git Bash 传中文会丢字符（真实踩过，资产名变成 "MingRead-2.4.0-.exe"）
  { ext: '.exe', name: `MingRead-${ASSET_VER}-setup.exe` },
  { ext: '.zip', name: `MingRead-${ASSET_VER}-win-x64.zip` },
];

function findSource(ext) {
  try {
    const hit = fs.readdirSync(SRC_DIR).find((f) => f.toLowerCase().endsWith(ext));
    return hit ? path.join(SRC_DIR, hit) : null;
  } catch (e) {
    return null;
  }
}

function api(method, apiPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'mingread-release',
          ...(payload
            ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: s ? JSON.parse(s) : null });
          } catch (e) {
            resolve({ status: res.statusCode, json: null, raw: s.slice(0, 200) });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 流式上传一个大文件到 uploads.github.com */
function uploadAsset(filePath, assetName) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    const started = Date.now();
    let sent = 0;
    let lastLog = 0;

    const req = https.request(
      {
        hostname: 'uploads.github.com',
        // name 必须 percent-encode；这里手工拼，避免 shell 层传中文
        path: `/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(assetName)}`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'User-Agent': 'mingread-release',
        },
      },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          try {
            const j = JSON.parse(s);
            if (j.state === 'uploaded' || j.id) {
              const sec = ((Date.now() - started) / 1000).toFixed(1);
              console.log(`[up] OK ${j.name} ${(j.size / 1048576).toFixed(1)}MB state=${j.state} ${sec}s`);
              resolve(j);
            } else {
              reject(new Error(`${res.statusCode} ${j.message || s.slice(0, 160)}`));
            }
          } catch (e) {
            reject(new Error(`${res.statusCode} 解析失败 ${s.slice(0, 160)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(0); // 不设超时：大文件上传慢是常态，超时切断会让资产卡在 starter

    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      sent += chunk.length;
      const now = Date.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        const pct = ((sent / size) * 100).toFixed(1);
        const kbps = (sent / 1024 / ((now - started) / 1000)).toFixed(0);
        console.log(`[up] ${assetName} ${pct}% ${(sent / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)}MB ${kbps}KB/s`);
      }
    });
    rs.on('error', reject);
    rs.pipe(req);
  });
}

(async () => {
  // 1) 清掉卡在 starter 的旧资产（它们是 curl 超时留下的，无法完成）
  const list = await api('GET', `/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets`);
  if (Array.isArray(list.json)) {
    for (const a of list.json) {
      if (a.state !== 'uploaded') {
        const del = await api('DELETE', `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
        console.log(`[up] 删除未完成资产 ${a.name} (${a.state}) -> ${del.status}`);
      } else {
        console.log(`[up] 已存在完整资产 ${a.name}，跳过`);
      }
    }
  }

  // 2) 逐个上传
  for (const t of TARGETS) {
    const p = findSource(t.ext);
    if (!p) {
      console.log(`[up] 跳过（${SRC_DIR} 下没有 ${t.ext}）`);
      continue;
    }
    console.log(`[up] 开始上传 ${t.name}  <- ${path.basename(p)} ${(fs.statSync(p).size / 1048576).toFixed(1)}MB`);
    await uploadAsset(p, t.name);
  }
  console.log('[up] 全部完成');
})().catch((e) => {
  console.error('[up] 失败:', e.message);
  process.exit(1);
});
