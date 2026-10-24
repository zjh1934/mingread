// 音色源（voice source）加载 / 校验 / 合并。
//
// 定位：把「发音人从哪来」从代码里的硬编码 pin，变成一份可被用户自己维护的清单（manifest）。
//   内置源 = voicePackSources 里的 pin（永远存在、永远优先于「不存在」）；
//   用户源 = settings.json 的 voiceSources: [{id, kind:'url'|'file', location, name}]，
//            用户自己建仓库（一个 https 地址或本地 .json 文件），应用只负责读清单。
//
// 三条设计红线：
//   1. 逐源降级：任何一个源取不到 / JSON 坏 / 校验不过，只影响它自己，其余源照常可用；
//      错误必须留在返回值里（errors + source.error），不许静默吞掉。
//   2. 校验从严：只收 https（本地 file:// 仅限用户显式添加的本地源）、sizeBytes 必填、
//      sha256 有则强校验、key 唯一、拒绝 `..` 等路径穿越。清单是外部输入，按不可信处理。
//   3. 合并可预测：按「内置源 → 用户源添加顺序」依次合并，**后来的覆盖同 key 的先前项**
//      （用户源优先级更高），被覆盖的来源记在 voice.overrides 上，UI 可解释「为什么变了」。
//
// 本模块必须在纯 Node 下可 require（探针脚本要用）：不顶层 require electron / settingsStore。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

const S = require('./voicePackSources');

/** 清单协议版本（不兼容变更必须 +1，加载器对 != 本值的清单一律拒绝） */
const SCHEMA_VERSION = 1;

const BUILTIN_SOURCE_ID = 'builtin';

/** 当前支持的引擎：engine → 必需的适配器 */
const SUPPORTED_ENGINES = {
  'nvsa-sapi': {
    label: '本地离线神经语音（NVSA / SAPI5）',
    adapters: ['nvsa'],
    archiveRequired: true,
  },
};

/** 当前支持的适配器（应用内置，不允许由远端清单提供——避免远程下发 DLL 去 regsvr32） */
const SUPPORTED_ADAPTERS = ['nvsa'];

/** 保留 key：与 voiceCatalog 的内置兜底音色同名会打架 */
const RESERVED_KEYS = ['system'];

const LIMITS = {
  manifestBytes: 512 * 1024, // 清单本身 512 KB 上限
  voices: 64, // 单源最多 64 个音色
  filesPerVoice: 16, // 单音色最多 16 个文件
  nameLen: 120,
  displayNameLen: 60,
  urlLen: 2048,
  fileNameLen: 120,
  keyLen: 32,
  fetchTimeoutMs: 20000,
};

/** 源级错误码（UI 直接拿这个分派文案） */
const SOURCE_ERRORS = {
  ENTRY_INVALID: 'SRC_ENTRY_INVALID', // 源条目本身不合法（既不是 https 也不是绝对路径）
  FETCH: 'SRC_FETCH', // 网络取不到（DNS / 断流 / 超时）
  HTTP: 'SRC_HTTP', // 4xx / 5xx
  TOO_LARGE: 'SRC_TOO_LARGE', // 清单超过 512 KB
  JSON: 'SRC_JSON', // 不是合法 JSON
  SCHEMA: 'SRC_SCHEMA', // 清单结构/字段校验不通过（细节在 source.error.details）
  LOCAL: 'SRC_LOCAL', // 本地文件读不到
  NO_FETCH: 'SRC_NO_FETCH', // 运行环境没有 fetch
};

// ---------------------------------------------------------------- 基础判定

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function isPosInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** 路径穿越 / 控制字符判定（清单里的任何「会被当成路径用」的字段都要过这一关） */
function dangerousPath(p) {
  const s = String(p == null ? '' : p);
  if (!s) return true;
  if (s.indexOf('\0') >= 0) return true;
  if (s.indexOf('\\') >= 0) return true; // 一律用 /，反斜杠只可能是绕过手法
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch (e) {
    return true; // 非法百分号编码
  }
  if (decoded.indexOf('\0') >= 0 || decoded.indexOf('\\') >= 0) return true;
  return decoded.split('/').some((seg) => seg === '..');
}

/** 归档文件名：不允许任何目录成分（解压目标的目录名由它派生，绝不能被清单控制） */
function checkArchiveFileName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, message: '文件名为空' };
  if (n.length > LIMITS.fileNameLen) return { ok: false, message: `文件名过长（>${LIMITS.fileNameLen}）` };
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return { ok: false, message: '文件名包含路径分隔符或非法字符' };
  if (n === '.' || n === '..') return { ok: false, message: '文件名不能是 . 或 ..' };
  if (n.startsWith('.')) return { ok: false, message: '文件名不能以点开头' };
  return { ok: true, name: n };
}

/** 归档 → 解压目录名（去掉 .msix/.zip/.appx 后缀） */
function dirNameOf(fileName) {
  return String(fileName).replace(/\.(msix|appx|zip)$/i, '');
}

/**
 * 校验下载地址。
 * @param {string} raw
 * @param {{allowLocal?:boolean}} opts allowLocal = 该清单来自用户显式添加的本地文件
 */
function validateUrl(raw, opts) {
  const o = opts || {};
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { ok: false, message: '地址为空' };
  if (s.length > LIMITS.urlLen) return { ok: false, message: `地址过长（>${LIMITS.urlLen}）` };

  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return { ok: false, message: '不是合法的 URL' };
  }
  if (u.username || u.password) return { ok: false, message: '地址里不允许带账号密码' };

  // 注意：`new URL()` 会先把 `/a/../../b` 规范化掉，所以「原始串里有没有 ..」
  // 必须在解析后仍然单独检查一遍（这是作者最容易写错、也最需要明确拒绝的形态）。
  let rawDecoded = s;
  try {
    rawDecoded = decodeURIComponent(s);
  } catch (e) {
    return { ok: false, message: '地址包含非法的百分号编码' };
  }
  if (rawDecoded.indexOf('\\') >= 0 || rawDecoded.split('/').some((seg) => seg === '..')) {
    return { ok: false, message: '地址包含 .. 路径穿越或非法字符' };
  }

  // 查询串/锚点也可能夹带路径穿越手法，一并检查（空串是正常的，只查非空值）
  const suspect = [u.pathname, u.search, u.hash].filter((x) => !!x);
  if (suspect.some((x) => dangerousPath(x))) {
    return { ok: false, message: '地址包含 .. 路径穿越或非法字符' };
  }

  if (u.protocol === 'https:') return { ok: true, kind: 'https', url: u.toString() };
  if (u.protocol === 'http:') return { ok: false, message: '必须使用 https（http 明文下载不允许）' };
  if (u.protocol === 'file:') {
    if (!o.allowLocal) return { ok: false, message: '远端清单里不允许 file://（只能是你自己添加的本地源）' };
    let p;
    try {
      p = fileURLToPath(u);
    } catch (e) {
      return { ok: false, message: 'file:// 地址无法解析成本地路径' };
    }
    if (!path.isAbsolute(p)) return { ok: false, message: 'file:// 必须是绝对路径' };
    if (dangerousPath(p.replace(/\\/g, '/'))) return { ok: false, message: '本地路径包含 .. 或非法字符' };
    return { ok: true, kind: 'file', url: u.toString(), localPath: p };
  }
  return { ok: false, message: `不支持的协议 ${u.protocol}（只允许 https）` };
}

// ---------------------------------------------------------------- 清单校验

/**
 * 校验并规范化一份清单。
 *
 * 返回：{ ok, errors:[{path,code,message}], warnings:[...], manifest }
 *   - ok=false 时 manifest 为 null（不做「部分可用」——半个清单比没有更危险）
 *   - errors 逐条定位到字段路径，方便仓库作者自助排查
 *
 * @param {*} raw 已解析的 JSON
 * @param {{allowLocal?:boolean}} [opts]
 */
function validateManifest(raw, opts) {
  const o = opts || {};
  const errors = [];
  const warnings = [];
  const add = (p, code, message) => errors.push({ path: p, code, message });

  if (!isObj(raw)) {
    add('$', 'MANIFEST_TYPE', '清单必须是一个 JSON 对象');
    return { ok: false, errors, warnings, manifest: null };
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    add('schemaVersion', 'SCHEMA_VERSION', `schemaVersion 必须是 ${SCHEMA_VERSION}（收到 ${JSON.stringify(raw.schemaVersion)}）`);
  }
  const name = str(raw.name);
  if (!name) add('name', 'NAME', 'name 必填（仓库名字，显示在设置里）');
  else if (name.length > LIMITS.nameLen) add('name', 'NAME', `name 过长（>${LIMITS.nameLen}）`);

  const voicesRaw = raw.voices;
  if (!Array.isArray(voicesRaw) || voicesRaw.length === 0) {
    add('voices', 'VOICES_EMPTY', 'voices 必须是非空数组');
  } else if (voicesRaw.length > LIMITS.voices) {
    add('voices', 'VOICES_TOO_MANY', `音色数量超过上限 ${LIMITS.voices}`);
  }

  const voices = [];
  const seenKeys = new Map(); // key → 首次出现的位置
  const seenDirs = new Map(); // dirName(小写) → key（解压目录不能撞车）

  if (Array.isArray(voicesRaw)) {
    voicesRaw.forEach((v, i) => {
      const at = `voices[${i}]`;
      if (!isObj(v)) {
        add(at, 'VOICE_TYPE', '音色必须是对象');
        return;
      }
      const key = str(v.key);
      if (!/^[a-z][a-z0-9_-]*$/.test(key) || key.length < 2 || key.length > LIMITS.keyLen) {
        add(`${at}.key`, 'VOICE_KEY', `key 只能是小写字母开头的 a-z0-9_-（2~${LIMITS.keyLen} 字符）`);
      } else if (RESERVED_KEYS.indexOf(key) >= 0) {
        add(`${at}.key`, 'VOICE_KEY_RESERVED', `key「${key}」是应用保留字，请换一个`);
      } else if (seenKeys.has(key)) {
        add(`${at}.key`, 'VOICE_KEY_DUPLICATE', `key「${key}」重复（第一次出现在 ${seenKeys.get(key)}）`);
      } else {
        seenKeys.set(key, at);
      }

      const displayName = str(v.displayName);
      if (!displayName) add(`${at}.displayName`, 'VOICE_NAME', 'displayName 必填');
      else if (displayName.length > LIMITS.displayNameLen) add(`${at}.displayName`, 'VOICE_NAME', `displayName 过长（>${LIMITS.displayNameLen}）`);

      const engine = str(v.engine);
      const engineDef = SUPPORTED_ENGINES[engine];
      if (!engineDef) {
        add(`${at}.engine`, 'VOICE_ENGINE', `engine「${engine}」不受支持（当前支持：${Object.keys(SUPPORTED_ENGINES).join(' / ')}）`);
      }

      const locale = str(v.locale) || 'zh-CN';
      if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale)) add(`${at}.locale`, 'VOICE_LOCALE', 'locale 形如 zh-CN');

      const gender = str(v.gender) || 'neutral';
      if (['female', 'male', 'neutral'].indexOf(gender) < 0) add(`${at}.gender`, 'VOICE_GENDER', 'gender 只能是 female / male / neutral');

      // requires：依赖的适配器，必须是 engine 必需适配器的超集
      let requires = [];
      if (v.requires != null) {
        if (!Array.isArray(v.requires)) add(`${at}.requires`, 'VOICE_REQUIRES', 'requires 必须是字符串数组');
        else {
          v.requires.forEach((r, j) => {
            const a = str(r);
            if (SUPPORTED_ADAPTERS.indexOf(a) < 0) add(`${at}.requires[${j}]`, 'VOICE_REQUIRES', `未知适配器「${a}」（当前支持：${SUPPORTED_ADAPTERS.join(' / ')}）`);
            else if (requires.indexOf(a) < 0) requires.push(a);
          });
        }
      }
      if (engineDef) {
        engineDef.adapters.forEach((a) => {
          if (requires.indexOf(a) < 0) requires.push(a); // 声明 engine 即隐含依赖，自动补齐
        });
      }

      // files
      const files = [];
      const filesRaw = v.files;
      if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
        add(`${at}.files`, 'VOICE_FILES', 'files 必须是非空数组（至少要有一个下载地址）');
      } else if (filesRaw.length > LIMITS.filesPerVoice) {
        add(`${at}.files`, 'VOICE_FILES', `files 数量超过上限 ${LIMITS.filesPerVoice}`);
      } else {
        filesRaw.forEach((f, j) => {
          const fat = `${at}.files[${j}]`;
          if (!isObj(f)) {
            add(fat, 'FILE_TYPE', 'files 的元素必须是对象');
            return;
          }
          const primary = validateUrl(f.url, { allowLocal: !!o.allowLocal });
          if (!primary.ok) add(`${fat}.url`, 'FILE_URL', primary.message);

          // 镜像（可选）：urls 数组里的每个地址都要能过同一套校验
          const urls = [];
          if (primary.ok) urls.push(primary.url);
          if (f.urls != null) {
            if (!Array.isArray(f.urls)) add(`${fat}.urls`, 'FILE_URL', 'urls 必须是字符串数组');
            else {
              f.urls.forEach((m, k) => {
                const r = validateUrl(m, { allowLocal: !!o.allowLocal });
                if (!r.ok) add(`${fat}.urls[${k}]`, 'FILE_URL', r.message);
                else if (urls.indexOf(r.url) < 0) urls.push(r.url);
              });
            }
          }

          if (f.sizeBytes == null) add(`${fat}.sizeBytes`, 'FILE_SIZE', 'sizeBytes 必填（字节数，用于下载校验）');
          else if (!isPosInt(f.sizeBytes)) add(`${fat}.sizeBytes`, 'FILE_SIZE', 'sizeBytes 必须是正整数（字节）');
          else if (f.sizeBytes > 8 * 1024 * 1024 * 1024) add(`${fat}.sizeBytes`, 'FILE_SIZE', 'sizeBytes 过大（>8 GB）');

          let sha256 = null;
          if (f.sha256 != null && str(f.sha256)) {
            const h = str(f.sha256).toLowerCase();
            if (!/^[a-f0-9]{64}$/.test(h)) add(`${fat}.sha256`, 'FILE_SHA256', 'sha256 必须是 64 位十六进制字符串');
            else sha256 = h;
          } else {
            warnings.push({ path: `${fat}.sha256`, code: 'FILE_SHA256_MISSING', message: '未提供 sha256：只能做体积校验，建议补上' });
          }

          // 文件名：优先清单显式给，否则从主地址推断
          let fileName = str(f.fileName);
          if (!fileName && primary.ok) {
            try {
              const u = new URL(primary.url);
              fileName = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
            } catch (e) {
              fileName = '';
            }
          }
          const fn = checkArchiveFileName(fileName);
          if (!fn.ok) add(`${fat}.fileName`, 'FILE_NAME', `文件名不合法：${fn.message}`);
          else if (urls.length) files.push({ url: urls[0], urls, sizeBytes: isPosInt(f.sizeBytes) ? f.sizeBytes : 0, sha256, fileName: fn.name, dirName: dirNameOf(fn.name) });
        });
      }

      // 同一音色内解压目录不能重复
      files.forEach((f) => {
        const dk = String(f.dirName).toLowerCase();
        if (!dk) {
          add(`${at}.files`, 'FILE_NAME', `文件名「${f.fileName}」去掉后缀后为空`);
          return;
        }
        if (seenDirs.has(dk)) {
          add(`${at}.files`, 'FILE_DIR_DUPLICATE', `解压目录「${f.dirName}」与 ${seenDirs.get(dk)} 冲突（同一目录会被覆盖）`);
        } else {
          seenDirs.set(dk, at);
        }
      });

      if (files.length) {
        voices.push({
          key,
          displayName,
          gender,
          locale,
          engine,
          requires,
          files,
          keywords: Array.isArray(v.keywords) ? v.keywords.map(str).filter(Boolean).slice(0, 8) : [],
          license: str(v.license) || null,
          homepage: str(v.homepage) || null,
          version: str(v.version) || null,
        });
      }
    });
  }

  if (errors.length) return { ok: false, errors, warnings, manifest: null };
  return {
    ok: true,
    errors,
    warnings,
    manifest: { schemaVersion: SCHEMA_VERSION, name, voices },
  };
}

// ---------------------------------------------------------------- 内置源

let _builtinCache = null;

/** 内置源（来自 voicePackSources 的 pin）；同步、无 I/O、永不失败 */
function builtinSource() {
  if (_builtinCache) return _builtinCache;
  const v = validateManifest(S.defaultManifest(), { allowLocal: true });
  // 内置 pin 校验不过属于代码 bug（不是用户输入问题），这里必须让它可见
  if (!v.ok) {
    const detail = v.errors.map((e) => `${e.path}: ${e.message}`).join('；');
    throw new Error(`内置音色源清单不合法（这属于程序缺陷）：${detail}`);
  }
  _builtinCache = v.manifest;
  return _builtinCache;
}

function builtinVoices() {
  return builtinSource().voices.map((v) => ({ ...v, sourceId: BUILTIN_SOURCE_ID, sourceName: builtinSource().name, builtin: true }));
}

// ---------------------------------------------------------------- 用户源条目

/**
 * 把用户输入（URL 或本地路径）规范化成一个源条目。
 * 只做结构校验，不读文件、不联网（添加后由 loadSources 负责取清单）。
 * @param {{location?:string, url?:string, path?:string, name?:string}} payload
 */
function makeSourceEntry(payload) {
  const p = payload || {};
  const location = str(p.location || p.url || p.path);
  if (!location) return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: '请填写仓库地址或选择本地清单文件' } };

  let kind = '';
  let normalized = '';
  if (/^https:\/\//i.test(location)) {
    const u = validateUrl(location, { allowLocal: false });
    if (!u.ok) return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: u.message } };
    kind = 'url';
    normalized = u.url;
  } else if (/^http:\/\//i.test(location)) {
    return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: '必须使用 https（http 明文地址不允许）' } };
  } else if (/^file:\/\//i.test(location)) {
    const u = validateUrl(location, { allowLocal: true });
    if (!u.ok) return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: u.message } };
    kind = 'file';
    normalized = u.localPath;
  } else if (path.isAbsolute(location)) {
    if (dangerousPath(location.replace(/\\/g, '/'))) {
      return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: '本地路径包含 .. 或非法字符' } };
    }
    kind = 'file';
    normalized = path.normalize(location);
  } else {
    return { ok: false, error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: '地址必须以 https:// 开头，或是本地清单文件的绝对路径' } };
  }

  const id = sourceIdOf(kind, normalized);
  return { ok: true, entry: { id, kind, location: normalized, name: str(p.name) || null } };
}

/** settings.json 里的用户源（纯 Node 下 settingsStore 不可用 → 视为空） */
function readUserEntries() {
  try {
    // eslint-disable-next-line global-require
    const settingsStore = require('./settingsStore');
    const s = settingsStore.getSettings();
    return Array.isArray(s && s.voiceSources) ? s.voiceSources : [];
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- 取清单

async function fetchManifestText(url, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) {
    const e = new Error('当前运行环境不支持网络请求');
    e.code = SOURCE_ERRORS.NO_FETCH;
    throw e;
  }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), LIMITS.fetchTimeoutMs) : null;
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl ? ctrl.signal : undefined,
        redirect: 'follow',
        headers: { 'User-Agent': 'mingread/2.4 (+https://github.com/zjh1934/mingread)' },
      });
    } catch (err) {
      const e = new Error(`取清单失败：${(err && err.message) || err}`);
      e.code = SOURCE_ERRORS.FETCH;
      throw e;
    }
    if (!res || !res.ok) {
      const e = new Error(`取清单失败：HTTP ${(res && res.status) || '无响应'}`);
      e.code = SOURCE_ERRORS.HTTP;
      throw e;
    }
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > LIMITS.manifestBytes) {
      const e = new Error(`清单超过 ${Math.round(LIMITS.manifestBytes / 1024)} KB 上限`);
      e.code = SOURCE_ERRORS.TOO_LARGE;
      throw e;
    }
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readLocalManifestText(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (e) {
    const err = new Error(`本地清单不存在或不可读：${p}`);
    err.code = SOURCE_ERRORS.LOCAL;
    throw err;
  }
  if (!st.isFile()) {
    const err = new Error(`不是文件：${p}`);
    err.code = SOURCE_ERRORS.LOCAL;
    throw err;
  }
  if (st.size > LIMITS.manifestBytes) {
    const err = new Error(`清单超过 ${Math.round(LIMITS.manifestBytes / 1024)} KB 上限`);
    err.code = SOURCE_ERRORS.TOO_LARGE;
    throw err;
  }
  try {
    return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    const err = new Error(`读取本地清单失败：${e.message}`);
    err.code = SOURCE_ERRORS.LOCAL;
    throw err;
  }
}

function parseManifestText(text) {
  try {
    return JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim());
  } catch (e) {
    const err = new Error(`清单不是合法 JSON：${e.message}`);
    err.code = SOURCE_ERRORS.JSON;
    throw err;
  }
}

/**
 * 载入单个源；任何失败都变成 source.error，绝不抛出（逐源降级）。
 */
async function loadOne(entryInput, opts) {
  const o = opts || {};
  // 已存条目也要重新过一遍地址校验：settings.json 是用户可手改的文件，
  // 不能让「http:// 或 ../」绕过添加时的校验，从这里混进下载链。
  const raw = typeof entryInput === 'string' ? { location: entryInput } : isObj(entryInput) ? entryInput : {};
  const made = makeSourceEntry({ location: raw.location, name: raw.name });
  if (made.ok && str(raw.id)) made.entry.id = str(raw.id);
  const base = {
    id: 'unknown',
    kind: 'url',
    location: '',
    name: null,
    builtin: false,
    ok: false,
    error: null,
    voiceCount: 0,
    voices: [],
    at: Date.now(),
  };
  if (!made.ok) {
    return {
      source: { ...base, id: 'invalid', error: { code: made.error.code, message: made.error.message, details: [] } },
      manifest: null,
    };
  }
  const entry = made.entry;
  const source = { ...base, id: entry.id, kind: entry.kind, location: entry.location, name: entry.name || entry.location };

  try {
    const text =
      entry.kind === 'file' ? readLocalManifestText(entry.location) : await fetchManifestText(entry.location, o);
    const parsed = parseManifestText(text);
    const checked = validateManifest(parsed, { allowLocal: entry.kind === 'file' });
    if (!checked.ok) {
      const err = new Error(checked.errors.map((x) => `${x.path}：${x.message}`).join('；'));
      err.code = SOURCE_ERRORS.SCHEMA;
      err.details = checked.errors;
      throw err;
    }
    source.ok = true;
    source.name = (entry.name || '').trim() || checked.manifest.name;
    source.manifestName = checked.manifest.name;
    source.voiceCount = checked.manifest.voices.length;
    source.voices = checked.manifest.voices.map((v) => v.key);
    source.warnings = checked.warnings;
    return { source, manifest: checked.manifest };
  } catch (e) {
    source.ok = false;
    source.error = {
      code: e.code || SOURCE_ERRORS.SCHEMA,
      message: (e && e.message) || String(e),
      details: Array.isArray(e.details) ? e.details : [],
    };
    return { source, manifest: null };
  }
}

/** 源 id：按「类型 + 地址」派生，稳定且可去重（重复添加同一地址不会翻倍） */
function sourceIdOf(kind, location) {
  return `src_${crypto.createHash('sha1').update(`${kind}:${location}`).digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------- 合并

function mergeManifests(pairs) {
  const byKey = new Map();
  const order = [];
  const warnings = [];
  const dirOwner = new Map();

  for (const { source, manifest } of pairs) {
    if (!manifest) continue;
    for (const v of manifest.voices) {
      const prev = byKey.get(v.key);
      if (prev) {
        warnings.push({
          code: 'VOICE_OVERRIDDEN',
          message: `音色「${v.key}」被「${source.name}」覆盖（原来源：${prev.sourceName}）`,
        });
      } else {
        order.push(v.key);
      }
      for (const f of v.files) {
        const dk = String(f.dirName).toLowerCase();
        const owner = dirOwner.get(dk);
        if (owner && owner !== v.key) {
          // 不同 key 抢同一个解压目录：后装的会覆盖先装的，必须让用户看见
          warnings.push({
            code: 'FILE_DIR_CONFLICT',
            message: `「${v.key}」与「${owner}」的解压目录同名（${f.dirName}），后安装的会覆盖前一个`,
          });
        } else if (!owner) {
          dirOwner.set(dk, v.key);
        }
      }
      byKey.set(v.key, {
        ...v,
        sourceId: source.id,
        sourceName: source.name,
        builtin: !!source.builtin,
        overrides: prev ? prev.sourceId : null,
      });
    }
  }

  return { voices: order.map((k) => byKey.get(k)), warnings };
}

// ---------------------------------------------------------------- 对外 API

let _cache = null;

/** 最近一次 loadSources 的结果（同步可读；voiceDeploy 用它解析安装目标） */
function getCache() {
  return _cache;
}

function invalidateCache() {
  _cache = null;
}

/**
 * 载入全部源（内置 + 用户），逐源降级后合并。
 * @param {{entries?:Array, fetchImpl?:Function, noCache?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, at:number, sources:Array, voices:Array, warnings:Array, errors:Array}>}
 */
async function loadSources(opts) {
  const o = opts || {};
  let entries = Array.isArray(o.entries) ? o.entries : readUserEntries();
  if (!Array.isArray(entries)) entries = [];

  const builtinManifest = builtinSource();
  const builtin = {
    id: BUILTIN_SOURCE_ID,
    kind: 'builtin',
    location: 'app://builtin-voices',
    name: builtinManifest.name,
    manifestName: builtinManifest.name,
    builtin: true,
    ok: true,
    error: null,
    voiceCount: builtinManifest.voices.length,
    voices: builtinManifest.voices.map((v) => v.key),
    warnings: [],
    at: Date.now(),
  };

  const sources = [builtin];
  const pairs = [{ source: builtin, manifest: builtinManifest }];
  const errors = [];

  for (const entry of entries) {
    let rec;
    try {
      // eslint-disable-next-line no-await-in-loop
      rec = await loadOne(entry, o);
    } catch (e) {
      rec = {
        source: {
          id: 'unknown',
          kind: 'url',
          location: '',
          name: null,
          builtin: false,
          ok: false,
          error: { code: SOURCE_ERRORS.ENTRY_INVALID, message: (e && e.message) || String(e), details: [] },
          voiceCount: 0,
          voices: [],
          at: Date.now(),
        },
        manifest: null,
      };
    }
    sources.push(rec.source);
    pairs.push(rec);
    if (!rec.source.ok) {
      errors.push({
        sourceId: rec.source.id,
        location: rec.source.location,
        code: rec.source.error.code,
        message: rec.source.error.message,
      });
    }
  }

  const merged = mergeManifests(pairs);
  const warnings = merged.warnings.slice();
  for (const s of sources) {
    for (const w of s.warnings || []) warnings.push({ ...w, sourceId: s.id });
  }
  const result = {
    ok: true, // 只要内置源在，整体就可用；单源失败看 errors / sources[].error
    at: Date.now(),
    sources,
    voices: merged.voices,
    warnings,
    errors,
    schemaVersion: SCHEMA_VERSION,
    engines: Object.keys(SUPPORTED_ENGINES),
    adapters: SUPPORTED_ADAPTERS,
  };
  if (!o.noCache) _cache = result;
  return result;
}

/**
 * 同步查一个音色（先看合并缓存，再退回内置源）。
 * voiceDeploy 用它把「安装哪个 key」解析成具体文件列表。
 */
function findVoiceSync(key) {
  const k = str(key);
  if (!k) return null;
  if (_cache) {
    const hit = _cache.voices.find((v) => v.key === k);
    if (hit) return hit;
  }
  return builtinVoices().find((v) => v.key === k) || null;
}

/** 全部可用音色（缓存优先；未载入时只有内置） */
function listVoicesSync() {
  return _cache ? _cache.voices.slice() : builtinVoices();
}

module.exports = {
  SCHEMA_VERSION,
  BUILTIN_SOURCE_ID,
  SUPPORTED_ENGINES,
  SUPPORTED_ADAPTERS,
  RESERVED_KEYS,
  LIMITS,
  SOURCE_ERRORS,
  validateManifest,
  validateUrl,
  checkArchiveFileName,
  dirNameOf,
  makeSourceEntry,
  readUserEntries,
  loadSources,
  loadOne,
  getCache,
  invalidateCache,
  findVoiceSync,
  listVoicesSync,
  builtinSource,
  builtinVoices,
};
