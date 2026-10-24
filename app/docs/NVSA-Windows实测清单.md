# NVSA 本地语音 · Windows 实测清单

> 面向：在真实 Win10/Win11 机器上验收「本地 NVSA 优先 + 在线 Edge 兜底」。
> 沙箱（Linux，无 wine）**跑不了 NVSA**，本清单之外的行为均已在沙箱用模拟通道验证过（见文末「沙箱已验证 / 未验证」）。
> 全程约 10 分钟，其中下载约 140MB 取决于网速。

---

## 0. 前置

- Windows 10 1607+ / Windows 11（x64），本机管理员权限可用（会弹一次 UAC）
- 项目已 `npm install`；Node 与 Electron 32 可用
- 建议先断网跑第 4 步（验证纯离线），再联网跑第 5 步（验证降级）

## 1. 注册前基线（应全部为「未就绪」）

```powershell
cd app
node scripts/probe-engine.js status
```

预期（未注册时）：

- `engine.active` = `"edge"`
- `engine.local.available` = `false`
- `engine.local.reason` = `"VOICE_NOT_REGISTERED"`
- `engine.local.message` 形如「未检测到本地语音（晓晓/云希），需运行离线语音注册」
- `engine.engines` 里 sapi=false / edge=true

## 2. 一键注册（一次 UAC）

双击 `scripts\register-nvsa.cmd`，或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nvsa.ps1
```

预期输出顺序：下载 NVSA(23MB) → 下载晓晓(54MB)/云希(60MB) → 解压 →
「正在申请管理员授权」→ **UAC 弹窗点“是”** → 写入 HKCU 配置 → 检测到晓晓/云希 → 退出码 0。

落地目录：`%LOCALAPPDATA%\langdu-nv\voice-pack\`（不随安装包分发，运行时下载）。
退出码含义：`2` 下载失败 / `3` 管理员授权失败 / `4` 解压或注册失败 / `5` 注册后仍枚举不到语音。

### 2.1 幂等性检查（关键）

再跑一次同一命令：应输出「已注册且语音包就位，无需重复操作」，**不再弹 UAC**，退出码 0。
加 `-Force` 才会重下重注册。

## 3. 注册表与文件核对

```powershell
reg query HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator
```

预期三条：`NarratorVoicePath` = `...\voice-pack\voices`；`NoEdgeVoices` = `1`；`NoAzureVoices` = `1`。

```powershell
dir "$env:LOCALAPPDATA\langdu-nv\voice-pack\engine\x64\NaturalVoiceSAPIAdapter.dll"
dir "$env:LOCALAPPDATA\langdu-nv\voice-pack\voices"
```

预期：DLL 存在；`voices` 下有两个 `MicrosoftWindows.Voice.zh-CN.*` 子目录且非空。

系统语音里应能看到微软自然语音：

```powershell
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() |
  ForEach-Object { $_.VoiceInfo.Name }
```

预期：出现含 `Xiaoxiao` 与 `Yunxi` 的条目（NVSA 注册名通常带 `Natural`）。

## 4. 本地合成与延迟（验收指标 F：热键→人声 ≤1000ms，本地目标 ≤300ms）

> 先做一次即可完成预热；之后逐次测才是热路径的真实延迟。

```powershell
node scripts/probe-engine.js status      # 预期 active = "sapi"，local.available = true
node scripts/probe-engine.js voices      # 预期两条 source=offline：sapi:xiaoxiao / sapi:yunxi
node scripts/probe-engine.js synth sapi:xiaoxiao "这是一次本地离线语音合成测试。"
node scripts/probe-engine.js synth sapi:xiaoxiao "第二次，测热路径延迟。"
node scripts/probe-engine.js synth sapi:yunxi   "云希男声测试。"
```

预期：

- `engine` = `sapi`，`local` = `true`，`degraded` = `false`
- `format` = `wav`，`sampleRate` 通常为 16000 或 24000，`bytes` > 1000
- 落盘 `dist\probe\synth-*.wav` 可用系统播放器打开，**音质应与在线 Edge 一致**（同为微软神经语音）
- 第 2 次起 `elapsedMs` **≤ 300ms**（若明显更高，说明长驻通道没生效或语音未预热，见第 7 节）

**纯离线验证**：断开网络后重跑上面的 synth，应仍然成功且 `engine` = `sapi`。

## 5. 降级可感知（断网 + 本地不可用）

- 断网时本地仍可用 → 无降级（`fallback` = null）。
- 断网且本地被卸载（见第 8 节）→ 合成应**明确报错**，错误信息同时包含本地与在线的原因，**不得无声播放**。
- 本地可用但单次合成失败 → 自动切在线：结果 `engine` = `edge`、`degraded` = `true`、
  `fallbackReason.reason` = `LOCAL_SYNTH_FAIL`；`voice:getStatus` 的 `degraded` = `true`、
  `fallback.message` 可直接用于状态播报。

## 6. 应用内验证（Electron）

```powershell
npm run build:renderer   # 如 dist 未构建
npm run dev:app          # 或直接 electron .
```

- 启动后日志/状态：引擎为「本地离线语音（NVSA）」，音色两条来源 offline
- 选中文本按 `Ctrl+Alt+R`（默认热键，F1 为可选预设）→ 出声；长文本逐句流式播放正常（wav 逐句拼接）
- 导出音频：文件扩展名应为 `.wav`（本地引擎）而非 `.mp3`
- 注册脚本跑完后若应用已启动：设置里触发刷新或重启应用，`probe-engine.js refresh` 可用于强制重探测

## 7. 出问题怎么定位

| 现象 | 检查 |
|---|---|
| 一直走在线，`reason=VOICE_NOT_REGISTERED` | 第 3 步的注册表与 DLL 是否到位；语音目录是否非 ASCII 路径 |
| `reason=HOST_START_FAILED` | PowerShell 能否启动：`powershell -NoProfile -Command "1"`；是否被策略/杀软拦截 |
| 首次合成很慢（秒级），之后正常 | 预热未生效；确认应用启动后有后台 warmup（长驻 powershell 进程应常驻） |
| 每次合成都 300ms+ | 长驻通道被反复重启：看日志是否出现「本地语音调用超时」 |
| 有声音但音质差/是旧 SAPI 音库 | 音色挑错：`probe-engine.js status` 里 `local.voices[].name` 应含 `Natural` |
| 注册后应用看不到 | 重启应用（SAPI 语音列表在进程内缓存）；或 `probe-engine.js refresh` |

查看长驻通道是否常驻：任务管理器里应有 1 个 `powershell.exe`（命令行含 `-EncodedCommand`），
随应用退出而退出；不应每次朗读都新起一个。

## 8. 卸载（还原现场）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nvsa.ps1 -Unregister
```

预期：一次 UAC 注销 DLL → 删除 HKCU 配置 → 删除 `voice-pack` 目录 → 退出码 0。

---

## 沙箱已验证 / 未验证（不要混淆）

**已验证（Linux 沙箱，真实执行）**：引擎抽象层路由与降级逻辑（`node scripts/test-engine-routing.js`，31 项断言全过），
包括本地优先、本地失败降级、未注册降级、两边都不通时明确报错、关闭兜底时报错、空文本报错、
通道起不来时不挂起、Linux 默认走在线且应用不崩；`node scripts/check-syntax.js` 全量通过。

**未验证（必须在本清单里实测）**：NVSA 下载/解压/regsvr32 注册的真实结果、PowerShell 长驻通道在
Windows 上的真实冷启动与合成耗时、晓晓/云希的真实音质与语音名匹配、UAC 弹窗与退出码、断网纯离线朗读。
