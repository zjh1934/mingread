# 一键注册本地离线语音（NaturalVoiceSAPIAdapter + 晓晓 / 云希）
#
# 做什么：
#   1. 运行时下载 NVSA（MIT，约 23MB）与两个微软 Narrator 语音 MSIX（不随安装包分发，只落到本机）
#   2. 解压到 $DestDir（默认 %LOCALAPPDATA%\langdu-nv\voice-pack，纯 ASCII 路径）
#   3. regsvr32 注册 x64\NaturalVoiceSAPIAdapter.dll —— 这里需要一次 UAC（脚本自动申请，用户只需点“是”）
#   4. 写 HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator（免管理员，保持纯离线）：
#        NarratorVoicePath = < voices 目录 >
#        NoEdgeVoices      = 1
#        NoAzureVoices     = 1
#   5. 新开一个 PowerShell 进程枚举系统语音，验证晓晓 / 云希 是否已就位
#
# 幂等：已下载/已解压/已注册/已配置的步骤都会跳过；只有缺什么才补什么。
# 卸载：scripts\register-nvsa.ps1 -Unregister（一次 UAC 注销 + 删除目录与 HKCU 配置）
#
# 退出码：0 成功 | 2 下载失败 | 3 管理员授权失败 | 4 解压/注册/写配置失败 | 5 验证未通过
#
# 用法（双击 register-nvsa.cmd 即可，或用管理员 PowerShell 运行）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\register-nvsa.ps1
[CmdletBinding()]
param(
  # 语音组件落地目录（必须是纯 ASCII 路径，NVSA 对非 ASCII 路径不友好）
  [string]$DestDir = (Join-Path $env:LOCALAPPDATA 'langdu-nv\voice-pack'),
  # 内部开关：本进程已在管理员权限下，只执行 regsvr32 注册
  [switch]$ElevatedRegister,
  # 卸载：注销 DLL + 删除 HKCU 配置 + 删除目录
  [switch]$Unregister,
  # 跳过最后的语音枚举验证
  [switch]$NoVerify,
  # 忽略幂等判断，强制重做（重下 / 重解压 / 重注册）
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- 资源直链（与 src 侧 voicePackSources 保持一致；pin 到实测可用的「最后可用版本」）----
$NVSA_ZIP_URL = 'https://github.com/gexgd0419/NaturalVoiceSAPIAdapter/releases/download/v0.2.10/NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip'
$NVSA_ZIP_NAME = 'NaturalVoiceSAPIAdapter_v0.2.10_x86_x64.zip'
$NVSA_ZIP_BYTES = 22999239
$NVSA_DLL_REL = 'x64\NaturalVoiceSAPIAdapter.dll'

$VoicePacks = @(
  @{
    Name = '晓晓'
    Url  = 'https://dl.nvdacn.com/NVDA-Addons/TTS/NaturalVoices/MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix'
    File = 'MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix'
    Bytes = 56815288
    Match = 'Xiaoxiao'
  },
  @{
    Name = '云希'
    Url  = 'https://dl.nvdacn.com/NVDA-Addons/TTS/NaturalVoices/MicrosoftWindows.Voice.zh-CN.Yunxi.1_1.0.4.0_x64__cw5n1h2txyewy.Msix'
    File = 'MicrosoftWindows.Voice.zh-CN.Yunxi.1_1.0.4.0_x64__cw5n1h2txyewy.Msix'
    Bytes = 63335105
    Match = 'Yunxi'
  }
)

$RegKey = 'HKCU:\Software\NaturalVoiceSAPIAdapter\Enumerator'

function Write-Step([string]$msg) { Write-Host "[·] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg) { Write-Host "[√] $msg" -ForegroundColor Green }
function Write-WarnMsg([string]$msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-ErrMsg([string]$msg) { Write-Host "[×] $msg" -ForegroundColor Red }

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NvsaConfig {
  try {
    $v = Get-ItemProperty -Path $RegKey -ErrorAction Stop
    return $v
  } catch {
    return $null
  }
}

function Test-Registered {
  $marker = Join-Path $EngineDir '.registered'
  if (-not (Test-Path -LiteralPath $marker)) { return $false }
  $cfg = Get-NvsaConfig
  if (-not $cfg) { return $false }
  return [bool]$cfg.NarratorVoicePath
}

function Get-File([string]$url, [string]$dest, [long]$expectBytes, [string]$label) {
  if ((Test-Path -LiteralPath $dest) -and -not $Force) {
    $len = (Get-Item -LiteralPath $dest).Length
    if ($expectBytes -le 0 -or $len -eq $expectBytes) {
      Write-Ok "$label 已存在（$len 字节），跳过下载"
      return
    }
    Write-WarnMsg "$label 已存在但大小不符（$len ≠ $expectBytes），重新下载"
    Remove-Item -LiteralPath $dest -Force
  }
  Write-Step "正在下载 $label（约 $([math]::Round($expectBytes / 1MB, 1)) MB）…"
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  } catch {
    Write-ErrMsg "下载 $label 失败：$($_.Exception.Message)"
    Write-Host "    直链：$url" -ForegroundColor DarkGray
    exit 2
  }
  $len = (Get-Item -LiteralPath $dest).Length
  if ($expectBytes -gt 0 -and $len -ne $expectBytes) {
    Write-ErrMsg "$label 大小不符：期望 $expectBytes，实际 $len"
    exit 2
  }
  Write-Ok "$label 下载完成（$len 字节）"
}

function Expand-Component([string]$archive, [string]$dest, [string]$label) {
  if ((Test-Path -LiteralPath $dest) -and -not $Force) {
    $count = @(Get-ChildItem -LiteralPath $dest -Recurse -File -ErrorAction SilentlyContinue).Count
    if ($count -gt 0) { Write-Ok "$label 已解压（$count 个文件），跳过"; return }
  }
  Write-Step "正在解压 $label …"
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $archive -DestinationPath $dest -Force
  } catch {
    Write-ErrMsg "解压 $label 失败：$($_.Exception.Message)"
    exit 4
  }
  Write-Ok "$label 解压完成"
}

# ---- 注册 / 注销（需要管理员，一次 UAC）----
function Invoke-RegisterDll {
  param([switch]$Uninstall)
  $dll = Join-Path $EngineDir $NVSA_DLL_REL
  if (-not (Test-Path -LiteralPath $dll)) {
    Write-ErrMsg "未找到引擎 DLL：$dll"
    exit 4
  }
  $argList = @('/s')
  $action = '注册'
  if ($Uninstall) { $argList = @('/u', '/s'); $action = '注销' }
  Write-Step "正在$( $action )语音引擎（需要一次管理员授权）…"
  $p = Start-Process -FilePath 'regsvr32.exe' -ArgumentList ($argList + @("`"$dll`"")) -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0) {
    Write-ErrMsg "regsvr32 失败（退出码 $($p.ExitCode)）"
    exit 4
  }
  Write-Ok '语音引擎注册完成'
}

function Invoke-Elevated {
  param([switch]$Uninstall)
  # 自举：以管理员身份重开一个自己（-ElevatedRegister），只为 regsvr32 弹一次 UAC
  $args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-DestDir', "`"$DestDir`"")
  $action = '注册'
  if ($Uninstall) { $args += '-Unregister'; $action = '注销' } else { $args += '-ElevatedRegister' }
  Write-Step "正在申请管理员授权（$( $action )语音引擎）…"
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -Verb RunAs -Wait -PassThru
  } catch {
    Write-ErrMsg "管理员授权被取消或失败：$($_.Exception.Message)"
    Write-Host '    你可以稍后重新运行本脚本，届时会再次询问。' -ForegroundColor DarkGray
    exit 3
  }
  if ($p.ExitCode -ne 0) {
    Write-ErrMsg "管理员授权步骤失败（退出码 $($p.ExitCode)）"
    exit 3
  }
}

function Write-NvsaConfig {
  Write-Step '正在写入语音配置（HKCU，免管理员）…'
  if (-not (Test-Path -LiteralPath 'HKCU:\Software\NaturalVoiceSAPIAdapter')) {
    New-Item -Path 'HKCU:\Software\NaturalVoiceSAPIAdapter' -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $RegKey)) {
    New-Item -Path $RegKey -Force | Out-Null
  }
  try {
    New-ItemProperty -Path $RegKey -Name 'NarratorVoicePath' -PropertyType String -Value $VoicesDir -Force | Out-Null
    New-ItemProperty -Path $RegKey -Name 'NoEdgeVoices' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $RegKey -Name 'NoAzureVoices' -PropertyType DWord -Value 1 -Force | Out-Null
  } catch {
    Write-ErrMsg "写入注册表配置失败：$($_.Exception.Message)"
    exit 4
  }
  Write-Ok "语音配置已写入（NarratorVoicePath = $VoicesDir；已关闭 Edge/Azure 在线语音，保持纯离线）"
}

function Test-VoicesPresent {
  # 新开进程枚举（regsvr32 之后 SAPI 的语音列表需要新进程才能刷新）
  $script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'
  try {
    $names = & powershell.exe -NoProfile -NonInteractive -Command $script 2>$null
  } catch {
    $names = @()
  }
  $result = @{}
  foreach ($p in $VoicePacks) {
    $hit = @($names | Where-Object { $_ -match $p.Match })
    $result[$p.Name] = ($hit.Count -gt 0)
    if ($hit.Count -gt 0) { Write-Ok "已检测到语音：$($p.Name) → $($hit[0])" }
    else { Write-WarnMsg "未检测到语音：$($p.Name)" }
  }
  return $result
}

# ============ 主流程 ============
$EngineDir = Join-Path $DestDir 'engine'
$VoicesDir = Join-Path $DestDir 'voices'

Write-Host ''
Write-Host '朗读女 Neo · 本地离线语音注册（NVSA + 晓晓 / 云希）' -ForegroundColor White
Write-Host "目标目录：$DestDir" -ForegroundColor DarkGray
Write-Host ''

if ($DestDir -match '[^\x20-\x7E]') {
  Write-WarnMsg '目标路径包含非 ASCII 字符，NVSA 可能无法加载语音，建议改用 -DestDir 指定纯英文路径。'
}

# --- 管理员分支：只做 regsvr32 ---
if ($ElevatedRegister) {
  Invoke-RegisterDll
  Set-Content -LiteralPath (Join-Path $EngineDir '.registered') -Value (Get-Date -Format 'o') -Encoding ASCII
  exit 0
}

# --- 卸载分支 ---
if ($Unregister) {
  Write-Step '正在卸载本地离线语音…'
  if (Test-Path -LiteralPath (Join-Path $EngineDir $NVSA_DLL_REL)) {
    if (-not (Test-IsAdmin)) { Invoke-Elevated -Uninstall }
    else { Invoke-RegisterDll -Uninstall }
  } else {
    Write-WarnMsg '未找到引擎 DLL，跳过注销（仅清理配置与目录）'
  }
  try { Remove-Item -Path 'HKCU:\Software\NaturalVoiceSAPIAdapter' -Recurse -Force -ErrorAction Stop } catch { }
  if (Test-Path -LiteralPath $DestDir) { Remove-Item -LiteralPath $DestDir -Recurse -Force }
  Write-Ok '本地离线语音已卸载（如朗读女正在运行，请重启应用）'
  exit 0
}

# --- 幂等检查 ---
if (-not $Force) {
  $voicesOk = $true
  foreach ($p in $VoicePacks) {
    $d = Join-Path $VoicesDir ($p.File -replace '\.msix$', '')
    if (-not ((Test-Path -LiteralPath $d) -and (@(Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue).Count -gt 0))) { $voicesOk = $false }
  }
  if ((Test-Registered) -and $voicesOk) {
    Write-Ok '本地离线语音已注册且语音包就位，无需重复操作。（如需重做：加 -Force）'
    if (-not $NoVerify) { $null = Test-VoicesPresent }
    Write-Host ''
    Write-Host '下一步：重启朗读女 Neo，主进程会自动切换到本地离线语音。' -ForegroundColor White
    exit 0
  }
}

New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
New-Item -ItemType Directory -Path $VoicesDir -Force | Out-Null

# 1) 下载
Get-File -url $NVSA_ZIP_URL -dest (Join-Path $DestDir $NVSA_ZIP_NAME) -expectBytes $NVSA_ZIP_BYTES -label 'NaturalVoiceSAPIAdapter（MIT）'
foreach ($p in $VoicePacks) {
  Get-File -url $p.Url -dest (Join-Path $DestDir $p.File) -expectBytes $p.Bytes -label "语音包 $($p.Name)"
}

# 2) 解压
Expand-Component -archive (Join-Path $DestDir $NVSA_ZIP_NAME) -dest $EngineDir -label 'NaturalVoiceSAPIAdapter'
foreach ($p in $VoicePacks) {
  $dir = Join-Path $VoicesDir ($p.File -replace '\.msix$', '')
  Expand-Component -archive (Join-Path $DestDir $p.File) -dest $dir -label "语音包 $($p.Name)"
}

# 3) 注册（一次 UAC）
if ((Test-Registered) -and -not $Force) {
  Write-Ok '引擎已注册过，跳过 regsvr32（不会再弹 UAC）'
} else {
  if (Test-IsAdmin) {
    Invoke-RegisterDll
    Set-Content -LiteralPath (Join-Path $EngineDir '.registered') -Value (Get-Date -Format 'o') -Encoding ASCII
  } else {
    Invoke-Elevated
  }
  if (-not (Test-Path -LiteralPath (Join-Path $EngineDir '.registered'))) {
    Set-Content -LiteralPath (Join-Path $EngineDir '.registered') -Value (Get-Date -Format 'o') -Encoding ASCII
  }
}

# 4) HKCU 配置
Write-NvsaConfig

# 5) 验证
if (-not $NoVerify) {
  Write-Step '正在验证语音可用性…'
  $r = Test-VoicesPresent
  $missing = @($VoicePacks | Where-Object { -not $r[$_.Name] } | ForEach-Object { $_.Name })
  if ($missing.Count -gt 0) {
    Write-ErrMsg "注册完成但未能检测到：$($missing -join '、')"
    Write-Host '    可能原因：安全软件拦截了 DLL 注册，或系统缺少对应的语音运行库。' -ForegroundColor DarkGray
    Write-Host '    建议：重启电脑后重新运行本脚本（-Force）；仍失败请查看 %LOCALAPPDATA%\langdu-nv\voice-pack 目录内容。' -ForegroundColor DarkGray
    exit 5
  }
}

Write-Host ''
Write-Ok '本地离线语音注册完成：晓晓 / 云希 已可用（纯离线，无需网络）。'
Write-Host '下一步：重启朗读女 Neo —— 主进程会优先使用本地语音，网络不可用时自动降级到在线语音。' -ForegroundColor White
Write-Host ''
exit 0
