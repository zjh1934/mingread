// Edge 在线语音后端（唯一合成方案）：微软 Edge 语音接口，输出 mp3。
// 依赖 node-edge-tts（MIT）；音色固定为晓晓 / 云希。
'use strict';

const C = require('../../shared/constants');
const { splitSentences, proportionalSentenceMarks } = require('../util');

const LOCALE = 'zh-CN';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const MP3_BYTES_PER_SEC = 48000 / 8; // 48kbps CBR ≈ 6000 B/s
const SAMPLE_RATE = 24000;

let mod = null;
let loaded = false;
let loadErr = null;

function load() {
  if (loaded) return mod;
  loaded = true;
  try {
    // eslint-disable-next-line global-require
    const m = require('node-edge-tts');
    if (m && typeof m.EdgeTTS === 'function') mod = m;
  } catch (e) {
    loadErr = e;
    mod = null;
  }
  return mod;
}

function voiceDef(voiceId) {
  const key = String(voiceId || '').replace(/^edge:/, '');
  return C.EDGE_VOICES.find((v) => v.key === key) || C.EDGE_VOICES[0];
}

/** pitch(-50~+50，与旧版一致按音分处理) → Edge 百分比 */
function pitchToPercent(pitch) {
  const factor = Math.pow(2, (Number(pitch) || 0) / 1200);
  return Math.round((factor - 1) * 100);
}

const signed = (v) => `${v >= 0 ? '+' : ''}${v}%`;

class EdgeTtsBackend {
  get id() {
    return 'edge';
  }

  /** 引擎种类：本地离线 / 在线（引擎抽象层契约字段） */
  get kind() {
    return 'online';
  }

  get label() {
    return '微软 Edge 在线语音';
  }

  isAvailable() {
    return !!load();
  }

  /** 在线引擎无缓存，空实现以满足契约 */
  invalidate() {
    return this;
  }

  /** 在线引擎无长驻资源，空实现以满足契约 */
  warmup() {}

  dispose() {}

  listVoices() {
    return C.EDGE_VOICES.map((v) => ({
      id: v.id,
      engine: 'edge',
      displayName: v.name,
      locale: LOCALE,
      gender: v.gender,
      desc: v.desc,
      source: 'online',
      nativeId: `${LOCALE}-${v.shortName}`,
      available: this.isAvailable(),
    }));
  }

  /**
   * @param {string} text
   * @param {{voiceId?:string, rate?:number, pitch?:number, volume?:number}} opts
   */
  async synthesize(text, opts) {
    const m = load();
    if (!m) {
      const err = new Error('在线语音组件不可用（缺少 node-edge-tts 依赖）');
      err.code = C.ERR.EDGE_NETWORK;
      throw err;
    }
    const def = voiceDef(opts.voiceId);
    const tts = new m.EdgeTTS({
      voice: `${LOCALE}-${def.shortName}`,
      lang: LOCALE,
      outputFormat: OUTPUT_FORMAT,
      saveSubtitles: true,
      rate: signed(Math.max(-50, Math.min(100, Number(opts.rate) || 0))),
      pitch: signed(pitchToPercent(opts.pitch)),
      volume: signed(Math.max(-50, Math.min(50, Number(opts.volume) || 0))),
      timeout: 20000,
    });

    const chunks = [];
    const marks = [];
    try {
      for await (const chunk of tts.streamAudio(String(text))) {
        if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        else if (chunk && typeof chunk.start === 'number') {
          marks.push({ name: 'word', timeMs: Math.round(chunk.start) });
        }
      }
    } catch (e) {
      const err = new Error(
        `在线合成失败：${e && e.message ? e.message : e}。请检查网络后重试（本软件只有在线语音一种方案）。`
      );
      err.code = C.ERR.EDGE_NETWORK;
      err.cause = e;
      throw err;
    }

    const audioData = new Uint8Array(Buffer.concat(chunks));
    if (audioData.length === 0) {
      const err = new Error('在线合成失败：未收到音频数据（服务无响应）');
      err.code = C.ERR.EDGE_NETWORK;
      throw err;
    }
    const durationMs = Math.max(
      Math.round((audioData.length / MP3_BYTES_PER_SEC) * 1000),
      marks.length ? marks[marks.length - 1].timeMs : 0
    );
    return {
      audioData,
      sampleRate: SAMPLE_RATE,
      durationMs,
      markers: marks,
      sentences: proportionalSentenceMarks(splitSentences(text), durationMs),
      backend: 'edge',
      format: 'mp3',
    };
  }
}

module.exports = EdgeTtsBackend;
