// ============================================================================
// ⚠️⚠️ espeak-ng 后端 —— 沙箱 / CI 验证专用，【不进入产品分发】⚠️⚠️
//
// 存在理由（且仅是理由）：
//   项目产品路径只在 Windows 上交付：本地 NVSA（SAPI）优先 + 在线 Edge 兜底。
//   但在 Linux 沙箱 / CI 里两者都不可用（无 wine、Edge 端点被 CDN 边缘层拒绝），
//   导致整条语音链路（播报 / 降级 / UI 反馈）长期无人能真正验证。
//   本后端用系统级 espeak-ng 在沙箱里提供一条能出声的引擎，让链路可被端到端验证。
//
// 明确边界：
//   - 机器人音色，音质差，仅用于验证「链路通不通」，不是给最终用户用的音色。
//   - 不得在 Windows / 产品构建里启用；不得作为产品功能宣传。
//   - 仅 Linux（及其他非 Windows 的沙箱/POSIX）环境且能找到 espeak-ng 时可探测为可用。
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { voiceKeyOf } = require('./voiceCatalog');
const { ENGINE_ERR } = require('./engineErrors');
const { splitSentences, proportionalSentenceMarks, parseWavHeader } = require('../util');

const PROBE_TTL_OK_MS = 5 * 60 * 1000; // 可用时缓存 5 分钟（探测要起进程，别每次合成都跑）
const PROBE_TTL_FAIL_MS = 30 * 1000; // 不可用时只缓存 30 秒（装上 espeak-ng 后能尽快感知）
const ESPEAK_BIN = 'espeak-ng';

/** espeak 侧不可用原因（本地定义：engineErrors.js 是引擎共享契约，不擅自扩充） */
const ESPEAK_REASON = {
  NOT_POSIX: 'ESPEAK_NOT_POSIX', // Windows / 产品路径不启用本引擎
  BIN_NOT_FOUND: 'ESPEAK_BIN_NOT_FOUND', // PATH 里没有 espeak-ng
  PROBE_FAILED: 'ESPEAK_PROBE_FAILED', // 二进制存在但跑不起来
  NO_ZH_VOICE: 'ESPEAK_NO_ZH_VOICE', // 没装中文语音（cmn）
};

/** 各原因对应的可读文案（供降级播报 / 状态展示，不静默失败） */
const ESPEAK_REASON_TEXT = {
  ESPEAK_NOT_POSIX: 'espeak 验证引擎仅在 Linux/沙箱环境启用',
  ESPEAK_BIN_NOT_FOUND: '未找到 espeak-ng，沙箱验证语音不可用',
  ESPEAK_PROBE_FAILED: 'espeak-ng 探测失败',
  ESPEAK_NO_ZH_VOICE: 'espeak-ng 未安装中文语音（cmn）',
};

/**
 * 验证用音色表：espeak-ng 只有 cmn（普通话）一个中文音，用音高偏移粗略区分
 * xiaoxiao / yunxi 两个 key，保证用户在两个引擎间切换时选择不丢（上层只认 key）。
 */
const ESPEAK_VOICES = [
  {
    key: 'xiaoxiao',
    id: 'espeak:xiaoxiao',
    name: '晓晓（沙箱验证音色）',
    gender: 'female',
    variant: 'cmn',
    pitchOffset: 12,
    desc: 'espeak-ng 普通话 · 机器人音色 · 沙箱/CI 验证专用，不进入产品分发',
  },
  {
    key: 'yunxi',
    id: 'espeak:yunxi',
    name: '云希（沙箱验证音色）',
    gender: 'male',
    variant: 'cmn',
    pitchOffset: -12,
    desc: 'espeak-ng 普通话 · 机器人音色 · 沙箱/CI 验证专用，不进入产品分发',
  },
];

/** 同步在 PATH 里找 espeak-ng（契约：isAvailable 不起进程、不发请求） */
let _bin; // string | false | undefined（undefined = 未查找）
function findBinary() {
  if (_bin !== undefined) return _bin || null;
  // 测试/特殊部署可用 LDN_ESPEAK_BIN 显式指定路径
  const envBin = process.env.LDN_ESPEAK_BIN;
  if (envBin) {
    try {
      if (fs.statSync(envBin).isFile()) {
        _bin = envBin;
        return _bin;
      }
    } catch (e) {
      /* 指定的路径不存在则按找不到处理 */
    }
    _bin = false;
    return null;
  }
  if (process.platform === 'win32') {
    _bin = false; // 产品路径（Windows）永不启用本引擎
    return null;
  }
  const dirs = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, ESPEAK_BIN);
    try {
      if (fs.statSync(p).isFile()) {
        _bin = p;
        return _bin;
      }
    } catch (e) {
      /* 继续找下一个目录 */
    }
  }
  _bin = false;
  return null;
}

/** 跑一次 espeak-ng，拿 stdout/stderr/退出码（stdout 可能是 WAV 二进制） */
function runEspeak(args, { timeoutMs = 30000, maxStdout = 64 * 1024 * 1024 } = {}) {
  const bin = findBinary();
  if (!bin) {
    const err = new Error(ESPEAK_REASON_TEXT[ESPEAK_REASON.BIN_NOT_FOUND]);
    err.reason = ESPEAK_REASON.BIN_NOT_FOUND;
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const out = [];
    const errChunks = [];
    let outLen = 0;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch (e) {
        /* noop */
      }
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      outLen += c.length;
      if (outLen > maxStdout) {
        killed = true;
        try {
          child.kill('SIGKILL');
        } catch (e) {
          /* noop */
        }
        return;
      }
      out.push(c);
    });
    child.stderr.on('data', (c) => errChunks.push(c));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const err = new Error(`espeak-ng 执行超时（>${timeoutMs}ms）`);
        err.reason = ESPEAK_REASON.PROBE_FAILED;
        reject(err);
        return;
      }
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(errChunks).toString('utf8') });
    });
  });
}

/** 从 `espeak-ng --voices` 输出里挑中文语音（cmn / yue / zh 均可）。
 *  行格式：` 5  cmn  --/M  Chinese_(Mandarin...)  sit/cmn  (zh-cmn 5)(zh 5)`，语言码在第二列 */
function pickZhVoices(voicesText) {
  return String(voicesText || '')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && /^(zh|cmn|yue)(-|$)/.test(cols[1] || ''))
    .map((cols) => cols[1]);
}

class EspeakBackend {
  constructor() {
    this._probe = null; // { at, value }
  }

  get id() {
    return 'espeak';
  }

  /** 本地离线引擎（进程在本机，不联网） */
  get kind() {
    return 'local';
  }

  get label() {
    return 'espeak-ng 中文语音（沙箱/CI 验证专用）';
  }

  /** 本引擎的固定说明：验证专用、不进入产品分发（供上层展示/播报） */
  get verificationOnly() {
    return true;
  }

  /** 最近一次探测结果（无副作用；未探测过返回 null） */
  lastProbe() {
    return this._probe ? this._probe.value : null;
  }

  /** 同步粗判：非 Windows 且 PATH 里有 espeak-ng（不起进程） */
  isAvailable() {
    if (process.platform === 'win32') return false;
    return !!findBinary();
  }

  invalidate() {
    this._probe = null;
    return this;
  }

  /**
   * 探测：确认二进制能跑且装了中文语音（结果带缓存）
   * @returns {Promise<{available:boolean, reason?:string, message?:string, voices?:Array, detail?:object}>}
   */
  async probe(force) {
    if (process.platform === 'win32') {
      const value = {
        available: false,
        reason: ESPEAK_REASON.NOT_POSIX,
        message: `${ESPEAK_REASON_TEXT[ESPEAK_REASON.NOT_POSIX]}（当前：${process.platform}，产品路径不启用本引擎）`,
      };
      this._probe = { at: Date.now(), value }; // 也缓存：状态展示需要给出"为什么没用 espeak"
      return value;
    }
    const now = Date.now();
    if (!force && this._probe) {
      const ttl = this._probe.value.available ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS;
      if (now - this._probe.at < ttl) return this._probe.value;
    }
    const value = await this._probeNow();
    this._probe = { at: Date.now(), value };
    return value;
  }

  async _probeNow() {
    const bin = findBinary();
    if (!bin) {
      return {
        available: false,
        reason: ESPEAK_REASON.BIN_NOT_FOUND,
        message: ESPEAK_REASON_TEXT[ESPEAK_REASON.BIN_NOT_FOUND],
      };
    }
    let version = '';
    try {
      const v = await runEspeak(['--version'], { timeoutMs: 10000 });
      if (v.code !== 0) {
        return {
          available: false,
          reason: ESPEAK_REASON.PROBE_FAILED,
          message: `${ESPEAK_REASON_TEXT[ESPEAK_REASON.PROBE_FAILED]}（--version 退出码 ${v.code}）：${v.stderr.trim()}`,
        };
      }
      version = String(v.stdout || '').toString('utf8').split('\n')[0].trim();
    } catch (e) {
      return {
        available: false,
        reason: ESPEAK_REASON.PROBE_FAILED,
        message: `${ESPEAK_REASON_TEXT[ESPEAK_REASON.PROBE_FAILED]}：${e && e.message ? e.message : e}`,
      };
    }
    let zh = [];
    try {
      const v = await runEspeak(['--voices'], { timeoutMs: 10000 });
      if (v.code !== 0) {
        return {
          available: false,
          reason: ESPEAK_REASON.PROBE_FAILED,
          message: `${ESPEAK_REASON_TEXT[ESPEAK_REASON.PROBE_FAILED]}（--voices 退出码 ${v.code}）`,
        };
      }
      zh = pickZhVoices(v.stdout.toString('utf8'));
    } catch (e) {
      return {
        available: false,
        reason: ESPEAK_REASON.PROBE_FAILED,
        message: `${ESPEAK_REASON_TEXT[ESPEAK_REASON.PROBE_FAILED]}：${e && e.message ? e.message : e}`,
      };
    }
    if (!zh.length) {
      return {
        available: false,
        reason: ESPEAK_REASON.NO_ZH_VOICE,
        message: ESPEAK_REASON_TEXT[ESPEAK_REASON.NO_ZH_VOICE],
        detail: { bin, version },
      };
    }
    return {
      available: true,
      voices: ESPEAK_VOICES.map((v) => ({ key: v.key, name: v.name })),
      detail: { bin, version, zhVoices: zh },
    };
  }

  listVoices() {
    const p = this._probe;
    if (!p || !p.value.available) return [];
    return ESPEAK_VOICES.map((def) => ({
      id: def.id,
      engine: 'espeak',
      displayName: def.name,
      locale: 'zh-CN',
      gender: def.gender,
      desc: def.desc,
      source: 'offline',
      nativeId: def.variant,
      available: true,
      verificationOnly: true,
    }));
  }

  /** 后台预热：静音合成一次，把进程冷启动挪出热键路径 */
  warmup() {
    if (process.platform === 'win32' || !findBinary()) return;
    setImmediate(async () => {
      try {
        await this.synthesize('一', {});
      } catch (e) {
        /* 预热失败不影响后续调用（probe/synthesize 会如实报错） */
      }
    });
  }

  /**
   * 合成：spawn `espeak-ng -v cmn <文本> --stdout` 拿 WAV
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number}} opts
   * @returns {Promise<import('../../shared/types').TtsResult>} 失败必 throw（绝不返回空音频）
   */
  async synthesize(text, opts = {}) {
    const o = opts || {};
    if (process.platform === 'win32') {
      const err = new Error(ESPEAK_REASON_TEXT[ESPEAK_REASON.NOT_POSIX]);
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      err.reason = ESPEAK_REASON.NOT_POSIX;
      throw err;
    }
    const p = await this.probe();
    if (!p.available) {
      const err = new Error(p.message || ESPEAK_REASON_TEXT[p.reason] || 'espeak 验证语音不可用');
      err.code = ENGINE_ERR.LOCAL_UNAVAILABLE;
      err.reason = p.reason;
      throw err;
    }

    const key = voiceKeyOf(o.voiceId) || 'xiaoxiao';
    const def = ESPEAK_VOICES.find((v) => v.key === key) || ESPEAK_VOICES[0];

    // 参数映射（我们的 -50~+100 语速 / -50~+50 音量与音调 → espeak 的 wpm / 振幅 / 音高）
    const wpm = Math.max(80, Math.min(400, Math.round(170 * (1 + (Number(o.rate) || 0) / 100))));
    const amp = Math.max(0, Math.min(200, 100 + (Number(o.volume) || 0)));
    const pitch = Math.max(0, Math.min(99, 50 + (Number(o.pitch) || 0) + def.pitchOffset));

    const text_ = String(text == null ? '' : text);
    const timeoutMs = Math.min(60000, 15000 + text_.length * 50);
    const r = await runEspeak(
      ['-v', def.variant, '-s', String(wpm), '-p', String(pitch), '-a', String(amp), '--stdout', text_],
      { timeoutMs }
    );

    if (r.code !== 0 || !r.stdout.length) {
      const err = new Error(
        `espeak 合成失败（退出码 ${r.code}）：${r.stderr.trim() || '未产出音频数据'}`
      );
      err.code = ENGINE_ERR.LOCAL_SYNTH_FAIL;
      err.reason = ESPEAK_REASON.PROBE_FAILED;
      throw err;
    }

    const buf = r.stdout;
    if (!(buf.length > 44 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE')) {
      const err = new Error('espeak 输出不是合法 WAV（缺 RIFF/WAVE 头）');
      err.code = ENGINE_ERR.LOCAL_SYNTH_FAIL;
      throw err;
    }

    const { sampleRate, numChannels, bitsPerSample } = parseWavHeader(buf);
    const bytesPerSample = Math.max(1, Math.floor((bitsPerSample || 16) / 8));
    const byteRate = (sampleRate || 22050) * (numChannels || 1) * bytesPerSample;
    const pcmBytes = Math.max(0, buf.length - 44);
    const durationMs = Math.max(1, Math.round((pcmBytes / byteRate) * 1000));
    const sentences = proportionalSentenceMarks(splitSentences(text_), durationMs);

    return {
      audioData: new Uint8Array(buf),
      sampleRate: sampleRate || 22050,
      durationMs,
      // espeak 无词级边界，按句给出可用于高亮的时间点（与 SAPI 后端同策略）
      markers: sentences.map((s) => ({ name: 'sentence', timeMs: s.startMs })),
      sentences,
      backend: 'espeak',
      format: 'wav',
      voiceId: def.id,
      voiceName: def.name,
      // 明示这是验证专用引擎，上层可据此加标注
      verificationOnly: true,
    };
  }

  /** 状态展示用信息（不触发副作用） */
  getInfo() {
    const p = this._probe;
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      platform: process.platform,
      supported: process.platform !== 'win32' && !!findBinary(),
      bin: findBinary(),
      verificationOnly: true,
      probedAt: p ? p.at : null,
      available: p ? p.value.available : null,
      reason: p && !p.value.available ? p.value.reason : null,
      message: p && !p.value.available ? p.value.message : null,
      detail: p && p.value.detail ? p.value.detail : null,
      voices: p && p.value.voices ? p.value.voices : [],
    };
  }

  /** 无长驻资源（每次合成独立进程，超时即杀），空实现以满足契约 */
  dispose() {}
}

module.exports = EspeakBackend;
module.exports.EspeakBackend = EspeakBackend;
module.exports.ESPEAK_REASON = ESPEAK_REASON;
module.exports.ESPEAK_REASON_TEXT = ESPEAK_REASON_TEXT;
module.exports.ESPEAK_VOICES = ESPEAK_VOICES;
