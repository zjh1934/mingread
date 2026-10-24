// 测试替身：模拟 Windows 侧「长驻 SAPI 通道」（scripts/sapiHost.js 的行协议），用于在 Linux 沙箱里
// 验证引擎抽象层的路由与降级逻辑。它不是真引擎，不产生真实语音，只产生可校验的 WAV/PCM 数据。
//
// 用法（由 sapiHost 通过环境变量注入）：
//   LDN_SAPI_HOST="$(which node)" LDN_SAPI_HOST_ARGS='["scripts/mock-sapi-host.js"]' node scripts/probe-engine.js status
// 行为开关：
//   MOCK_NO_VOICES=1   枚举不到晓晓/云希（模拟 NVSA 未注册）
//   MOCK_FAIL_SYNTH=1  synth 返回失败（模拟本地引擎合成失败）
//   MOCK_BOOT_FAIL=1   启动即退出（模拟 PowerShell 起不来）
'use strict';

if (process.env.MOCK_BOOT_FAIL === '1') {
  process.stderr.write('mock: boot failed\n');
  process.exit(1);
}

const VOICES = [
  'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
  'Microsoft Yunxi Online (Natural) - Chinese (Mainland)',
];

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function frame(obj) {
  process.stdout.write(`LDNSAPI ${JSON.stringify(obj)}\n`);
}

/** 生成 16kHz/16bit/单声道 的正弦波 PCM，时长按字数估算（约 180ms/字） */
function fakePcm(text) {
  const sampleRate = 16000;
  const ms = Math.max(200, Math.min(6000, String(text).length * 180));
  const samples = Math.floor((sampleRate * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    buf.writeInt16LE(v, i * 2);
  }
  return { buf, sampleRate, ms };
}

frame({ id: 0, ok: true, cmd: 'ready', ps: '0.0.0-mock' });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(line) {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch (e) {
    frame({ id: 0, ok: false, cmd: 'badjson', errorB64: b64('bad request') });
    return;
  }
  const id = req.id;
  const cmd = req.cmd;
  if (cmd === 'ping') {
    frame({ id, ok: true, cmd: 'ping' });
    return;
  }
  if (cmd === 'voices') {
    const names = process.env.MOCK_NO_VOICES === '1' ? [] : VOICES;
    // 故意混入一个不相关语音，验证 pickSapiVoices 的筛选
    const all = names.concat(['Microsoft Huihui - Chinese (Simplified)']);
    frame({
      id,
      ok: true,
      cmd: 'voices',
      voices: all.map((n) => ({ name: b64(n), culture: b64('zh-CN'), gender: 'Female', id: b64(n), desc: b64('') })),
    });
    return;
  }
  if (cmd === 'warmup') {
    frame({ id, ok: true, cmd: 'warmup' });
    return;
  }
  if (cmd === 'synth') {
    if (process.env.MOCK_FAIL_SYNTH === '1') {
      frame({ id, ok: false, cmd: 'synth', errorB64: b64('模拟：本地语音合成失败') });
      return;
    }
    const text = Buffer.from(req.textB64 || '', 'base64').toString('utf8');
    const { buf: pcm, sampleRate } = fakePcm(text);
    frame({
      id,
      ok: true,
      cmd: 'synth',
      audioB64: pcm.toString('base64'),
      sampleRate,
      bitsPerSample: 16,
      channels: 1,
    });
    return;
  }
  frame({ id, ok: false, cmd, errorB64: b64(`unknown cmd: ${cmd}`) });
}
