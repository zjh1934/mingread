# 朗读女 Neo v2.3.0 交付说明

> 版本：v2.3.0 ｜ 日期：2026-10-24 ｜ 主题：**集成 LensZoom「屏幕缩放（复刻 macOS 缩放）」模块并修复毛坯缺陷**
>
> ⚠️ **v2.3.1 起默认值已变更（本文是 v2.3.0 当时的历史记录，下文 F1 / 复制即读 / 语音链路的描述以当时为准）**：
> ① 默认热键 `F1` → **`Ctrl+Alt+R`**（F1 保留为可选预设，正好绕开旧版朗读女占键）；
> ② 复制即读**默认关 → 默认开**（低视力刚需，带节流与长度上限）；
> ③ 语音链路**只有 Edge → 本地 NVSA 优先 + Edge 在线兜底**（「效果垃圾」属于已废弃的 Kokoro，与 NVSA 无关）。
> 现行状态以 `新对话接手说明.md` 与 `app/README.md` 为准。

---

## 一、本轮交付内容

### 1. LensZoom 屏幕缩放模块（从项目资产集成）

用户放在项目资产（tdrive → assets → `LensZoom-屏幕缩放内嵌模块`）的毛坯模块，已完整集成进 朗读女 Neo，并逐条修复其缺陷。

**交互定版（三入口一致）**：

| 入口 | 操作 |
|---|---|
| 全局热键（默认兜底） | `Ctrl+Alt+=` 放大一档 · `Ctrl+Alt+-` 缩小一档 · `Ctrl+Alt+0` 退出缩放 |
| 系统托盘 | 「屏幕缩放」子菜单：放大 / 缩小 / 退出 / 暂停·恢复 |
| 桌面悬浮球 | 右键菜单：朗读选中 / 播放 / 暂停 / 停止 / 放大 / 缩小 / 退出缩放 / 隐藏悬浮球 |
| 设置界面 | 设置 → 屏幕缩放分区：全部参数可视化调节 |

**缩放行为**（复刻 macOS）：倍率 2x~16x 整数步进（像素锐利）；跟随策略三种——指针为不动点（等同 macOS「跟随指针」）/ 指针恒居中 / 到边缘才推动画面；过渡平滑；放大时**鼠标穿透**（点击仍能操作下层界面，不打断朗读）；倍率缩回 1x 自动退出；多显示器自动跟随（光标跨屏时覆盖层迁移并重新捕获）；左上角 HUD 显示倍率/FPS（调试可开）。

### 2. 毛坯缺陷修复清单（F1~F10 + 收口 3 项）

| # | 问题 | 修复 |
|---|---|---|
| F1 | **毛坯依赖 koffi / uiohook-napi 原生模块做全局滚轮钩子，本环境二者都不存在且禁装 → 用户根本无法触发缩放** | 新增「热键触发模式」兜底：`zoomTrigger` 设置 auto/hotkey；auto 模式有原生模块用滚轮、没有自动降级热键；本机实测热键三键全部注册成功 |
| F2 | 退出逻辑缺陷：zoomMin=2 时永远退不出放大 | 缩到 1x 即退出（与 macOS 一致）；zoomMin>1 时缩小到 zoomMin 停住，退出走 Ctrl+Alt+0 / 托盘 / reset |
| F3 | 多显示器不跟随（只在激活时定位一次） | 渲染循环逐帧检测光标所在显示器，跨屏即迁移覆盖层并通知重新捕获屏幕流 |
| F4 | 帧率上限改设置不生效 | applySettingsPatch 检测 zoomFrameLimit 变化即热重启渲染循环 |
| F5 | 「暂停」语义错误（直接关闭缩放） | 改为「冻结」：画面定格在当前倍率，恢复后继续 |
| F6 | 覆盖层加载失败无容错 | loadFile catch + did-fail-load 监听 + 告警不崩溃 |
| F7 | app 未 ready 时 screen 调用可能抛异常 | safeCursorPoint 三级降级 |
| F8 | 无单例访问入口（托盘/悬浮球无法调用） | getZoomController() 模块级单例 |
| F9 | 改朗读热键时 `unregisterAll()` 会把缩放热键一起清掉 | hotkeyTray 重注册后补注册缩放热键 |
| F10 | 激活早于覆盖层加载完成时，覆盖层收不到激活通知 | did-finish-load 后补发 zoom:activate |
| S1（收口） | 悬浮球 56x56 窗口会裁切右键菜单（菜单 158x274） | 菜单打开时球窗口临时扩容至菜单尺寸（右侧空间不足自动向左翻转），关闭恢复 |
| S2（收口） | 菜单「隐藏悬浮球」无命令 | floatBall handleCmd 增加 hide |
| S3（收口） | 退出缩放后屏幕捕获流仍在后台跑 | 退出时通知覆盖层停流（省电、避免隐藏窗口继续录屏） |

### 3. 文件变更

- 新增：`src/main/zoomController.js`（747 行，修复版控制器）、`src/main/zoomPreload.js`、`src/main/zoom-overlay.html`（按接口契约重写）、`src/renderer/components/ZoomSettings.jsx`
- 修改：`settingsStore.js`（zoom* 默认值）、`ipc.js`（zoom patch 透传 + floatBall 载荷透传）、`index.js`（装配 zoomController）、`hotkeyTray.js`（托盘缩放的子菜单 + 热键补注册）、`floatBall.js`（zoom 命令 + 菜单扩容 + hide）、`preload/index.js`（zoom API）、`App.jsx`（缩放状态条）、`SettingsDialog.jsx`（屏幕缩放分区）、`public/floatball.html`（右键菜单）、`README.md`
- 版本：constants.js / package.json → 2.3.0

## 二、验证证据

- 语法检查：`node scripts/check-syntax.js` → **OK=18 FAIL=0**
- 渲染构建：`vite build` → **通过**（499KB / gzip 158KB）
- 探针（electron main）：zoomController 加载 OK；**Ctrl+Alt+= / Ctrl+Alt+- / Ctrl+Alt+0 三键全部注册成功**（无冲突）；`zoom:get` 返回 trigger=hotkey；`zoom:nudge(true)` 激活并创建覆盖层（加载 src/main/zoom-overlay.html）；togglePause 冻结语义正确；缩到 1x 自动退出正确；stop 后热键注销
- 真机冒烟（electron .）：`[zoom] trigger=hotkey zoomHotkeyOk=true`、`[floatball] created`、`[capture] saved` 全链路无错误
- floatball 探针：右键菜单 8 项 + 2 分隔，无 JS 错误
- 截图：`_out/qa-v23-settings.png`（设置弹窗，可见 F1 被占用的真实冲突态）、`qa-v23-settings-zoom.png`（屏幕缩放分区）、`qa-v23-settings-zoom-hotkey.png`（仅热键模式置灰态）、`qa-v23-zoom-statusbar.png`（缩放状态条 2.5x·已暂停）、`qa-v23-main.png`（主界面）

## 三、已知限制（如实告知）

1. **本机 F1 主热键注册失败**（`ok=false`）：你 03:09 启动的旧版「朗读女」正占用 F1。退出旧版后 F1 即可用；或设置里换 `Ctrl+Alt+F1` 保存即生效。缩放三热键（Ctrl+Alt 组合）无冲突。
2. **滚轮触发路径本机不可用**：koffi/uiohook 原生模块不存在（环境禁装），当前唯一触发是热键模式；代码保留了两条滚轮路径，用户本机若自行 `npm install koffi` 放入 node_modules 即可切换为「修饰键+滚轮」。设置界面会显示当前实际触发模式。
3. **多显示器跟随未实测**：本机单屏，跨屏逻辑已实现但需多屏环境回归。
4. **菜单外点击不关闭右键菜单**：球窗口 focusable:false 不抢焦点（保护朗读时的前台程序焦点），窗口外点击达不到页面；菜单内点击 / Esc / blur 可关。属权衡后的取舍。

## 四、需要你处理的一件事：.md 交接文档未能下载

项目资产里那批文档——`交接文档-内嵌到朗读女Neo.md`（15.6KB）、`接口与数据结构说明.md`（6.7KB）、`README-先看这里.md`（3.1KB）、`调研参考/ScreenZoom-调研与Pro-Prompt.md`（24.3KB）——**下载通道被网盘签名服务挡住**（COS 对 .md 的预签名 URL 一律返回 InvalidRequest；.zip/.js/.html 均可正常下载，已实测）。

本次集成依据的是 5 个代码文件（zoomController / zoomPreload / zoom-overlay / ZoomSettings / preload-additions）+ 接口契约，契约完整、功能已闭环。**若那 4 份文档里有代码之外的额外需求（ especially 24KB 的调研文档），请把内容直接贴到对话里，或改个后缀名（如 .txt）重新上传**，我按文档补齐。

## 五、下一阶段计划（v2.4，待你确认后排期）

1. **延迟优化**（你反馈「按热键后朗读延迟太高」）：划词抓取合并为单次 PowerShell（省一次进程启动 ~200ms）+ Edge 连接预热 + 首句优先合成；目标把 F1→出声压到 1 秒内。
2. **本地引擎注册引导**（你指的路：「注册本地 NVSA 就快」）：启动检测 → 未注册则弹一键注册引导；不注册走在线入口。注册后晓晓/云希本地合成（百毫秒级）；不注册用在线 Edge，**在线音色扩展到 10 个（5 男 5 女）任选**。
3. **UI 重新设计**（你要求「集成以后 UI 也得重新设计」）：主界面与设置体系重构。
4. **GitHub 开源**（一开始的要求，一直没做）：按 `05-开源发布任务书.md`——`zjh1934/langdu-nv` 公开仓库、MIT、中文 README（双下载入口 + 徽章）、自检脚本、Releases。**需要你提供可用的 GitHub PAT**（历史对话里那个已泄露，发布后需轮换）。
5. 安装包图标 / 任务栏图标设计（你提过没设计）。

## 六、交付物（`_out/`）

| 文件 | 大小 |
|---|---|
| 朗读女Neo-2.3.0-安装包.exe | ~81MB |
| 朗读女Neo-2.3.0-免安装.zip | ~111MB |
| 朗读女Neo-2.3.0-源码.zip | ~215KB |
| 朗读女Neo-2.3.0-交付说明.md | 本文档 |
| qa-v23-*.png（5 张 QA 截图） | — |

> 按项目盘规则，以上文件**尚未上传**到项目资产——确认后我再传。
