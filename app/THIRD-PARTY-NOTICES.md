# 第三方组件与许可声明 · 朗读女 Neo v2.1

v2.1 起本项目**不再随包分发任何语音模型或微软语音包**；v2.3.1 起重开**本地 NVSA 引擎**（微软神经语音本地运行，语音包运行时自动下载装配，仍不随安装包分发），语音链路为**本地 NVSA 优先 + Edge 在线兜底**。
因此随包体积仍是几十 MB 量级，也不再有语音包再分发的许可问题。

## 运行时依赖

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts) | 1.2.11 | MIT | 调用微软 Edge 在线语音接口（晓晓 / 云希） |
| [Electron](https://www.electronjs.org/) | 32.3.3 | MIT | 桌面运行时 |
| [React](https://react.dev/) / react-dom | 18.3.1 | MIT | 界面框架 |
| [@mui/material](https://mui.com/) / icons-material | 5.16.x | MIT | UI 组件 |
| [@emotion/react](https://emotion.sh/) / styled | 11.13.x | MIT | MUI 样式引擎 |
| [Zustand](https://zustand-demo.pmnd.rs/) | 4.5.5 | MIT | 状态管理 |
| [Vite](https://vitejs.dev/) | 5.4.x | MIT | 构建工具（仅开发期） |

## 语音服务

- **本地 NVSA 引擎（v2.3.1 起，首选）**：[NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)（MIT）+ 晓晓/云希 MSIX 语音包：运行时自动下载、一次管理员注册后经系统 SAPI5 通道调用，**不随安装包分发**、不缓存语音数据；跑的是与在线 Edge 完全相同的微软神经语音（晓晓 / 云希），音质一致。
- **微软 Edge 语音接口**（`speech.platform.bing.com` 的 WebSocket 服务，兜底）：语音合成由微软提供，本项目只做协议调用，不缓存、不分发语音数据。
- 服务可用性与条款由微软决定；本软件在断网或服务不可达时给出明确提示，绝不静默失败。

## 已移除（相对 v2.0）

| 组件 | 原因 |
|---|---|
| `sherpa-onnx-node` + Kokoro-82M 模型（206MB） | 音质不达标、体积大、CPU 占用高（「效果垃圾」的评价属于 Kokoro，与 NVSA 无关） |
| `lamejs`（WAV→MP3 编码） | 在线语音本身就是 mp3，无需本地转码 |
| 系统 SAPI5 旧语音库（Lili/Anna 等陈旧音色） | 音质老旧；当前 SAPI5 通道仅用于驱动 NVSA 注册的微软神经语音 |

## 重新引入（相对 v2.1–v2.3.0 的「只有 Edge」时期）

| 组件 | 说明 |
|---|---|
| NaturalVoiceSAPIAdapter + 晓晓/云希 MSIX | v2.3.1 重开为本地优先引擎：运行时下载装配（不随包分发）、一次 UAC 注册；许可见上，再分发合规问题同上 |
| 系统 SAPI5 语音通道（PowerShell + System.Speech） | 作为 NVSA 的宿主通道重新启用，仅调用微软神经语音 |

## 开发 / 验证环境专用（不进入产品分发）

| 组件 | 说明 |
|---|---|
| espeak-ng（Linux 沙箱 / CI） | 仅用于在无 Windows、无 Edge 网络的环境验证语音链路（播报 / 降级 / UI 反馈），机器人音色，**不作为产品功能、不进任何产品构建** |

## 合规说明

- 不包含原版「朗读女」的任何代码或资源；功能与交互为独立实现。
- 主进程除「在线语音合成」外不发起任何网络请求；无遥测、无账号、无密钥。
- 本软件以 MIT 协议开源，第三方组件许可见上表。
