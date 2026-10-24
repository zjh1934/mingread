# ============================================================================
#  朗读女 Neo · Windows 一键自检（NVSA 本地离线语音引擎）
#
#  本脚本由 app\scripts\win-selfcheck.cmd 双击启动（推荐入口），也可在
#  PowerShell 里手动执行：
#      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\win-selfcheck.ps1
#
#  流程（与交接包 v2.3.0 的自检步骤一一对应）：
#    1. 环境信息（Windows / PowerShell / Node / NVSA 注册痕迹）
#    2. 幂等注册（调用 register-nvsa.ps1；已注册则跳过，不重复弹 UAC）
#    3. 注册核对（reg query 三项值 + 系统 SAPI 中文语音枚举）
#    4. 引擎探测（node scripts\probe-engine.js status）
#    5. 延迟实测（本地连续 5 次 synth，取第 2 次起；附在线 Edge 对照）
#    6. 断网复测（用户手动断网后按回车，确认纯离线可用）
#    7. 汇总写入 results\win-selfcheck-<时间戳>.txt 并自动打开所在文件夹
#
#  退出码：0 = PASS | 1 = PASS 但有警告 | 2 = FAIL | 10 = 预检：需要注册
#
#  说明：本文件面向 Windows PowerShell 5.1 编写，未使用 PS7 专有语法。
#        注册表三项值以注册表提供程序读取为准（reg query 原始输出可能因
#        控制台编码显示乱码，已在报告中注明）。
# ============================================================================

[CmdletBinding()]
param(
  # 预检模式：只判断 NVSA 是否已完整注册（供 .cmd 决定是否提权），不跑自检
  [switch]$PreCheck,
  # 应用根目录（默认取本脚本所在目录的上一级，即 app\）
  [string]$AppDir,
  # 本地延迟实测次数（第 1 次为预热不计入统计）
  [int]$Runs = 5
)

$ErrorActionPreference = 'Continue'   # 自检不因单步失败而中断，尽量跑完全部步骤

# 控制台输出编码设为 UTF-8：既保证中文不乱码，也让后续启动的子进程
# （powershell.exe 子通道）向管道输出 UTF-8，从而被正确捕获进报告。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------- 路径 ----------------
if (-not $AppDir) { $AppDir = Split-Path -Parent $PSScriptRoot }
if (-not $AppDir) { $AppDir = (Get-Location).Path }
$ResultsDir = Join-Path $AppDir 'results'
$RegisterScript = Join-Path $AppDir 'scripts\register-nvsa.ps1'
$ProbeScript = Join-Path $AppDir 'scripts\probe-engine.js'
$script:TempDir = $env:TEMP
if (-not $script:TempDir) { $script:TempDir = $env:TMP }
if (-not $script:TempDir) { try { $script:TempDir = [System.IO.Path]::GetTempPath() } catch { } }
if (-not $script:TempDir) { $script:TempDir = $AppDir }
$DestDir = $env:LOCALAPPDATA
if (-not $DestDir) { $DestDir = $script:TempDir }
$DestDir = Join-Path $DestDir 'langdu-nv\voice-pack'

if ($Runs -lt 2) { $Runs = 5 }

# ---------------- 报告累积器 ----------------
$script:Report = New-Object System.Collections.Generic.List[string]
$script:StepResults = New-Object System.Collections.Generic.List[object]
$script:Node = $null

function Add-Line([string]$text) {
  if ($null -eq $text) { $text = '' }
  $script:Report.Add($text)
}

function Add-Raw([string[]]$lines) {
  foreach ($l in $lines) { Add-Line $l }
}

function Write-StepHeader([int]$n, [string]$title) {
  Add-Line ''
  Add-Line ('=' * 72)
  Add-Line ("[步骤 $n] $title")
  Add-Line ('=' * 72)
  Write-Host ''
  Write-Host ("===== [步骤 $n] $title =====") -ForegroundColor Cyan
}

function Set-StepVerdict([int]$n, [string]$title, [string]$verdict, [string]$summary) {
  # verdict: PASS / WARN / FAIL
  $script:StepResults.Add([pscustomobject]@{
    Step = $n; Title = $title; Verdict = $verdict; Summary = $summary
  })
  $color = 'Green'
  if ($verdict -eq 'WARN') { $color = 'Yellow' }
  if ($verdict -eq 'FAIL') { $color = 'Red' }
  Add-Line ''
  Add-Line ("  >> 步骤 $n 结论: $verdict - $summary")
  Write-Host ("  >> 步骤 $n 结论: $verdict - $summary") -ForegroundColor $color
}

# ---------------- 工具函数 ----------------

# 解析 Node 命令：优先 PATH 中的 node；否则用随包 Electron 内置的 Node。
function Resolve-NodeCommand {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { $cmd = Get-Command node -ErrorAction SilentlyContinue }
  if ($cmd) {
    $v = '未知'
    try { $v = ( & $cmd.Source '--version' 2>$null | Select-Object -First 1 ) } catch { }
    return [pscustomobject]@{
      Source = $cmd.Source
      Version = [string]$v
      Label = 'PATH 中的 node'
      Env = $null
    }
  }
  $electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
  if (Test-Path -LiteralPath $electron) {
    return [pscustomobject]@{
      Source = $electron
      Version = 'Electron 内置'
      Label = '随包 Electron 内置 Node'
      Env = @{ ELECTRON_RUN_AS_NODE = '1' }
    }
  }
  return $null
}

# 调用 probe-engine.js（带超时 / 环境变量 / 输出捕获 / JSON 解析）。
# 返回: Ok, ExitCode, Output(合并 stdout+stderr), Json(PSObject 或 $null)
function Invoke-Probe {
  param(
    [Parameter(Mandatory)][string[]]$ProbeArgs,
    [hashtable]$ExtraEnv = @{},
    [int]$TimeoutMs = 180000
  )
  $result = [pscustomobject]@{ Ok = $false; ExitCode = -1; Output = ''; Json = $null }
  if (-not $script:Node) {
    $result.Output = '未找到 Node.js，无法调用 probe-engine.js'
    return $result
  }
  # 合并环境变量：Node 自身需要的（如 ELECTRON_RUN_AS_NODE）+ 本次调用的
  $envMap = @{}
  if ($script:Node.Env) {
    foreach ($kv in $script:Node.Env.GetEnumerator()) { $envMap[$kv.Key] = $kv.Value }
  }
  foreach ($k in $ExtraEnv.Keys) { $envMap[$k] = [string]$ExtraEnv[$k] }
  $saved = @{}
  foreach ($k in $envMap.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }

  $tag = [GUID]::NewGuid().ToString('N')
  $outFile = Join-Path $script:TempDir "ldn-selfcheck-$tag.out"
  $errFile = Join-Path $script:TempDir "ldn-selfcheck-$tag.err"
  # Start-Process -ArgumentList 传入数组时不会自动加引号（PS 5.1 行为），手动补
  $argLine = ($ProbeArgs | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
  try {
    foreach ($k in $envMap.Keys) { [Environment]::SetEnvironmentVariable($k, [string]$envMap[$k]) }
    $proc = $null
    try {
      $proc = Start-Process -FilePath $script:Node.Source -ArgumentList $argLine -WorkingDirectory $AppDir -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -PassThru
    } catch {
      $result.Output = "启动 node 失败: $($_.Exception.Message)"
      return $result
    }
    $exited = $false
    try { $exited = $proc.WaitForExit($TimeoutMs) } catch { $exited = $true }
    if (-not $exited) {
      try { $proc.Kill() } catch { }
      $result.Output = "调用超时（> ${TimeoutMs}ms）: node $($ProbeArgs -join ' ')"
      return $result
    }
    try { $null = $proc.WaitForExit() } catch { }
    try { $result.ExitCode = $proc.ExitCode } catch { $result.ExitCode = -1 }
  } finally {
    foreach ($k in $envMap.Keys) {
      try { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } catch { }
    }
  }
  $outText = ''
  $errText = ''
  try { $outText = Get-Content -LiteralPath $outFile -Raw -Encoding UTF8 } catch { }
  try { $errText = Get-Content -LiteralPath $errFile -Raw -Encoding UTF8 } catch { }
  Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  $combined = ($outText + "`n" + $errText)
  $result.Output = $combined.Trim()
  $result.Ok = ($result.ExitCode -eq 0)
  # 提取第一个 { 到最后一个 } 之间的 JSON（probe-engine 失败时 JSON 走 stderr）
  $start = $combined.IndexOf('{')
  $end = $combined.LastIndexOf('}')
  if ($start -ge 0 -and $end -gt $start) {
    try { $result.Json = $combined.Substring($start, $end - $start + 1) | ConvertFrom-Json } catch { $result.Json = $null }
  }
  return $result
}

# 与 register-nvsa.ps1 的幂等判断保持一致：
#   .registered 标记 + HKCU 配置非空 + 两个语音包目录均非空
function Test-NvsaFullyRegistered {
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $DestDir 'engine\.registered'))) { return $false }
    $cfg = $null
    try { $cfg = Get-ItemProperty -Path 'HKCU:\Software\NaturalVoiceSAPIAdapter\Enumerator' -ErrorAction Stop } catch { $cfg = $null }
    if (-not $cfg) { return $false }
    if (-not $cfg.NarratorVoicePath) { return $false }
    $voicesDir = Join-Path $DestDir 'voices'
    $packs = @(
      'MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy',
      'MicrosoftWindows.Voice.zh-CN.Yunxi.1_1.0.4.0_x64__cw5n1h2txyewy'
    )
    foreach ($p in $packs) {
      $d = Join-Path $voicesDir $p
      if (-not (Test-Path -LiteralPath $d)) { return $false }
      if (@(Get-ChildItem -LiteralPath $d -Recurse -File -ErrorAction SilentlyContinue).Count -eq 0) { return $false }
    }
    return $true
  } catch {
    return $false
  }
}

# ---------------- 预检模式（供 .cmd 决定是否提权）----------------
if ($PreCheck) {
  if (Test-NvsaFullyRegistered) { exit 0 }
  exit 10
}

# ---------------- 主流程 ----------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ResultFile = Join-Path $ResultsDir "win-selfcheck-$stamp.txt"
$script:Overall = 'FAIL'
try { New-Item -ItemType Directory -Path $ResultsDir -Force | Out-Null } catch { }

$script:Node = Resolve-NodeCommand

try {

  # ============ 步骤 1：环境信息 ============
  Write-StepHeader 1 '环境信息'
  $s1 = 'PASS'; $s1note = '环境读取完成'

  $cv = $null
  try { $cv = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop } catch { $cv = $null }
  if ($cv) {
    $name = [string]$cv.ProductName
    $build = "$($cv.CurrentBuild).$($cv.UBR)"
    if ($cv.DisplayVersion) { $winStr = "$name $($cv.DisplayVersion) (Build $build)" } else { $winStr = "$name (Build $build)" }
    if ([int]$cv.CurrentBuild -ge 22000) { $winStr = "$winStr  [注: Build>=22000 实为 Windows 11]" }
  } else {
    $winStr = "Windows（版本信息读取失败，OSVersion=$([System.Environment]::OSVersion.Version)）"
  }
  $arch = 'x86'
  try { if ([Environment]::Is64BitOperatingSystem) { $arch = 'x64' } } catch { }
  Add-Line "  Windows    : $winStr $arch"

  $psVer = $PSVersionTable.PSVersion.ToString()
  $psEd = 'Desktop'
  if ($PSVersionTable.PSEdition) { $psEd = $PSVersionTable.PSEdition }
  Add-Line "  PowerShell : $psVer ($psEd)"

  if ($script:Node) {
    Add-Line "  Node       : $($script:Node.Version) ($($script:Node.Label))"
    Add-Line "  可执行文件  : $($script:Node.Source)"
  } else {
    Add-Line '  Node       : 未找到（PATH 中没有 node，app\node_modules\electron 也不存在）'
    $s1 = 'FAIL'; $s1note = '缺少 Node.js，后续探测步骤无法执行'
  }

  $marker = Join-Path $DestDir 'engine\.registered'
  $regCfgOk = $false
  try {
    $c = Get-ItemProperty -Path 'HKCU:\Software\NaturalVoiceSAPIAdapter\Enumerator' -ErrorAction Stop
    if ($c.NarratorVoicePath) { $regCfgOk = $true }
  } catch { }
  $markerTxt = '无'; if (Test-Path -LiteralPath $marker) { $markerTxt = '有' }
  $regTxt = '无'; if ($regCfgOk) { $regTxt = '有' }
  $dirTxt = '无'; if (Test-Path -LiteralPath $DestDir) { $dirTxt = '有' }
  Add-Line "  NVSA 痕迹  : 注册标记=$markerTxt  HKCU配置=$regTxt  语音包目录=$dirTxt"
  Add-Line "  语音包目录 : $DestDir"
  Add-Line "  应用目录   : $AppDir"
  Add-Line "  注册脚本   : $RegisterScript$(if (Test-Path -LiteralPath $RegisterScript) { '' } else { '  [缺失]' })"
  Set-StepVerdict 1 '环境信息' $s1 $s1note

  # ============ 步骤 2：幂等注册 ============
  Write-StepHeader 2 '幂等注册（调用 register-nvsa.ps1）'
  if (-not (Test-Path -LiteralPath $RegisterScript)) {
    Add-Line "  [x] 未找到注册脚本: $RegisterScript"
    Set-StepVerdict 2 '幂等注册' 'FAIL' 'register-nvsa.ps1 缺失'
  } else {
    Add-Line '  正在调用 register-nvsa.ps1（幂等：已注册则直接跳过，不会重复弹 UAC）...'
    Add-Line '  首次运行会下载 NVSA 与两个微软 Narrator 语音包（约 140MB），请耐心等待。'
    $regTee = $null
    $global:LASTEXITCODE = $null
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $RegisterScript 2>&1 | Tee-Object -Variable regTee | Out-Host
    $regCode = $LASTEXITCODE
    if ($null -eq $regCode) { $regCode = -1 }
    $regText = ($regTee | Out-String)
    Add-Line "  register-nvsa.ps1 退出码: $regCode (0=成功 2=下载失败 3=授权失败 4=解压/注册失败 5=验证未通过)"
    Add-Line '  ---- register-nvsa.ps1 输出 ----'
    Add-Raw (($regText.Trim() -split "`r?`n"))
    Add-Line '  --------------------------------'
    if ($regCode -eq 0) {
      Set-StepVerdict 2 '幂等注册' 'PASS' '注册完成或已注册（跳过，未重复授权）'
    } elseif ($regCode -eq -1) {
      Set-StepVerdict 2 '幂等注册' 'FAIL' '无法启动 powershell.exe 执行注册脚本'
    } elseif ($regCode -eq 5) {
      Set-StepVerdict 2 '幂等注册' 'WARN' '注册流程走完，但语音枚举验证未通过（退出码 5）'
    } elseif ($regCode -eq 3) {
      Set-StepVerdict 2 '幂等注册' 'FAIL' '管理员授权被取消或失败（退出码 3）'
    } elseif ($regCode -eq 2) {
      Set-StepVerdict 2 '幂等注册' 'FAIL' '组件下载失败（退出码 2，检查网络/防火墙）'
    } else {
      Set-StepVerdict 2 '幂等注册' 'FAIL' "注册失败（退出码 $regCode）"
    }
  }

  # ============ 步骤 3：注册核对 ============
  Write-StepHeader 3 '注册核对（注册表 + 系统 SAPI 语音）'
  $regKey = 'HKCU\Software\NaturalVoiceSAPIAdapter\Enumerator'
  $regDumpOk = $false
  $regDump = ''
  $global:LASTEXITCODE = $null
  try {
    $regDump = & reg.exe query $regKey 2>&1 | Out-String
    if ($LASTEXITCODE -eq 0 -and $regDump -and $regDump.Trim()) { $regDumpOk = $true }
  } catch { $regDump = '' }
  if ($regDumpOk) {
    Add-Line "  reg query $regKey 原始输出"
    Add-Line '  （控制台编码所限，非 ASCII 路径在此可能显示为乱码，以下方解析值为准）:'
    Add-Raw (($regDump.TrimEnd() -split "`r?`n"))
  } else {
    Add-Line "  reg query $regKey => 失败（键不存在或无法读取）"
  }
  Add-Line ''

  # 三项值：以注册表提供程序读取（Unicode 安全），与 reg query 互为印证
  $nvp = $null; $noEdge = $null; $noAzure = $null
  try {
    $cfg = Get-ItemProperty -Path "HKCU:\Software\NaturalVoiceSAPIAdapter\Enumerator" -ErrorAction Stop
    $nvp = [string]$cfg.NarratorVoicePath
    $noEdge = $cfg.NoEdgeVoices
    $noAzure = $cfg.NoAzureVoices
  } catch { }
  Add-Line "  NarratorVoicePath = $(if ($nvp) { $nvp } else { '<未设置>' })"
  if ($nvp) {
    $pExists = '否'; if (Test-Path -LiteralPath $nvp) { $pExists = '是' }
    Add-Line "    该目录存在: $pExists"
  }
  Add-Line "  NoEdgeVoices      = $(if ($null -ne $noEdge) { $noEdge } else { '<未设置>' })   (期望 1 = 不暴露在线 Edge 语音)"
  Add-Line "  NoAzureVoices     = $(if ($null -ne $noAzure) { $noAzure } else { '<未设置>' })   (期望 1 = 不暴露 Azure 语音)"
  Add-Line ''

  # 系统 SAPI 中文语音枚举（与 register-nvsa.ps1 相同的已验证方式：新进程 + System.Speech）
  Add-Line '  系统 SAPI 语音（System.Speech 新进程枚举）:'
  $enumScript = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'
  $voiceNames = @()
  try { $voiceNames = @(& powershell.exe -NoProfile -NonInteractive -Command $enumScript 2>$null) } catch { $voiceNames = @() }
  if ($voiceNames.Count -eq 0) {
    Add-Line '    <枚举失败，或系统没有任何 SAPI 语音>'
  } else {
    Add-Line "    共 $($voiceNames.Count) 个:"
    foreach ($n in $voiceNames) { Add-Line "      - $n" }
  }
  $zhHits = @($voiceNames | Where-Object { $_ -match 'Xiaoxiao|Yunxi|晓晓|云希' })
  Add-Line "    命中晓晓/云希: $($zhHits.Count) 个"
  Add-Line ''

  Add-Line '  HKLM Speech\Voices 令牌（辅助参考）:'
  try {
    $tokens = @(Get-ChildItem -Path 'HKLM:\SOFTWARE\Microsoft\Speech\Voices' -ErrorAction Stop)
    if ($tokens.Count -eq 0) { Add-Line '    <无>' }
    foreach ($t in $tokens) {
      $disp = ''
      try { $disp = (Get-Item -LiteralPath $t.PSPath).GetValue('') } catch { }
      if ($disp) { Add-Line "    - $($t.PSChildName)  =>  $disp" } else { Add-Line "    - $($t.PSChildName)" }
    }
  } catch {
    Add-Line '    <读取失败（不影响判定，以 System.Speech 枚举为准）>'
  }

  # 判定
  $s3 = 'PASS'; $s3note = '三项配置正确且中文神经语音已注册'
  $problems = @()
  if (-not $nvp) { $problems += 'NarratorVoicePath 未设置'; $s3 = 'FAIL' }
  elseif (-not (Test-Path -LiteralPath $nvp)) { $problems += 'NarratorVoicePath 指向的目录不存在'; $s3 = 'FAIL' }
  if ($noEdge -ne 1) { $problems += "NoEdgeVoices=$noEdge（期望 1）"; if ($s3 -ne 'FAIL') { $s3 = 'WARN' } }
  if ($noAzure -ne 1) { $problems += "NoAzureVoices=$noAzure（期望 1）"; if ($s3 -ne 'FAIL') { $s3 = 'WARN' } }
  if ($zhHits.Count -eq 0) { $problems += 'SAPI 中未枚举到晓晓/云希'; $s3 = 'FAIL' }
  if ($problems.Count -gt 0) { $s3note = ($problems -join '；') }
  Set-StepVerdict 3 '注册核对' $s3 $s3note

  # ============ 步骤 4：引擎探测 ============
  Write-StepHeader 4 '引擎探测（probe-engine.js status）'
  if (-not $script:Node) {
    Add-Line '  [x] 跳过：未找到 Node.js'
    Set-StepVerdict 4 '引擎探测' 'FAIL' '无 Node.js，无法运行 probe-engine.js'
  } else {
    $r = Invoke-Probe -ProbeArgs @($ProbeScript, 'status')
    $j = $r.Json
    if (-not $j) {
      Add-Line "  [x] 无法解析 probe-engine.js status 输出（退出码 $($r.ExitCode)）"
      Add-Raw (($r.Output -split "`r?`n"))
      Set-StepVerdict 4 '引擎探测' 'FAIL' 'status 输出无法解析'
    } else {
      $eng = $j.engine
      Add-Line "  当前引擎 active        : $($eng.active)  <- $($eng.activeLabel)"
      Add-Line "  引擎链路 chain         : $(($eng.chain) -join ' -> ')"
      Add-Line "  本地 NVSA (sapi)       : available=$($eng.local.available)"
      if (-not $eng.local.available) {
        Add-Line "    不可用原因 reason    : $($eng.local.reason)"
        Add-Line "    说明 message        : $($eng.local.message)"
      } else {
        $vnames = @()
        foreach ($v in $eng.local.voices) { $vnames += [string]$v.name }
        Add-Line "    本地可用音色         : $($vnames -join ' / ')"
        Add-Line "    系统已注册语音数     : $($eng.local.installedCount)"
      }
      Add-Line "  在线 Edge (edge)       : available=$($eng.online.available)"
      Add-Line "  是否降级 degraded      : $($eng.degraded)"
      if ($eng.fallback) {
        Add-Line "    降级原因            : $($eng.fallback.reason) - $($eng.fallback.message)"
      }
      Add-Line '  ---- probe-engine.js status 原始输出 ----'
      Add-Raw (($r.Output -split "`r?`n"))
      Add-Line '  ------------------------------------------'
      if ($eng.active -eq 'sapi' -and $eng.local.available) {
        Set-StepVerdict 4 '引擎探测' 'PASS' '当前使用本地离线语音（NVSA），无降级'
      } elseif ($eng.active -eq 'edge') {
        $why = [string]$eng.local.reason
        if (-not $why) { $why = '未知' }
        Set-StepVerdict 4 '引擎探测' 'WARN' "当前走在线 Edge 兜底（本地不可用: $why）"
      } elseif (-not $eng.active) {
        Set-StepVerdict 4 '引擎探测' 'FAIL' '没有任何可用引擎'
      } else {
        Set-StepVerdict 4 '引擎探测' 'WARN' "active=$($eng.active)（Windows 上应为 sapi）"
      }
    }
  }

  # ============ 步骤 5：延迟实测 ============
  Write-StepHeader 5 '延迟实测（本地 5 次 + 在线 Edge 对照）'
  if (-not $script:Node) {
    Add-Line '  [x] 跳过：未找到 Node.js'
    Set-StepVerdict 5 '延迟实测' 'FAIL' '无 Node.js，无法测量'
  } else {
    Add-Line "  本地合成：连续运行 $Runs 次 probe-engine.js synth（第 1 次含预热，不计入统计）"
    $runs = @()
    for ($i = 1; $i -le $Runs; $i++) {
      $rr = Invoke-Probe -ProbeArgs @($ProbeScript, 'synth')
      $jj = $rr.Json
      $ok = $false; $engName = ''; $local = $false; $elapsed = -1; $dur = -1; $deg = $false
      if ($jj) {
        $ok = ($jj.ok -eq $true)
        $engName = [string]$jj.engine
        $local = [bool]$jj.local
        if ($null -ne $jj.elapsedMs) { $elapsed = [int]$jj.elapsedMs }
        if ($null -ne $jj.durationMs) { $dur = [int]$jj.durationMs }
        $deg = [bool]$jj.degraded
      }
      $runs += [pscustomobject]@{
        Index = $i; Ok = $ok; Engine = $engName; Local = $local
        ElapsedMs = $elapsed; DurationMs = $dur; Degraded = $deg; ExitCode = $rr.ExitCode
      }
      $tag = ''
      if ($deg) { $tag = ' (发生降级)' }
      if ($i -eq 1) { $tag = ' (预热，不计)' }
      Add-Line ("    #{0}  退出码={1}  engine={2}  local={3}  elapsedMs={4}  durationMs={5}{6}" -f $i, $rr.ExitCode, $engName, $local, $elapsed, $dur, $tag)
      if (-not $ok -and $jj) { Add-Line "       错误: $($jj.message)" }
    }
    Add-Line ''
    $valid = @($runs | Where-Object { $_.Index -ge 2 -and $_.Ok -and $_.Engine -eq 'sapi' })
    $s5 = 'PASS'; $s5note = ''
    if ($valid.Count -eq 0) {
      $s5 = 'FAIL'
      $s5note = '第 2 次起的本地合成均未成功（本地引擎未生效或合成失败）'
      Add-Line "  [x] $s5note"
    } else {
      $avg = [math]::Round((($valid | Measure-Object -Property ElapsedMs -Average).Average), 0)
      $min = ($valid | Measure-Object -Property ElapsedMs -Minimum).Minimum
      $max = ($valid | Measure-Object -Property ElapsedMs -Maximum).Maximum
      Add-Line "  本地统计（第 2-$Runs 次，共 $($valid.Count) 次有效）: 平均 ${avg}ms / 最小 ${min}ms / 最大 ${max}ms"
      Add-Line '  判定标准: 平均 <=300ms 为 PASS；300-800ms 为 WARN；>800ms 为 FAIL'
      if ($avg -le 300) {
        $s5 = 'PASS'; $s5note = "本地平均 ${avg}ms，达到 <=300ms 延迟红线"
      } elseif ($avg -le 800) {
        $s5 = 'WARN'; $s5note = "本地平均 ${avg}ms，超过 300ms 期望值（可接受但偏高）"
      } else {
        $s5 = 'FAIL'; $s5note = "本地平均 ${avg}ms，远超预期"
      }
      $nonLocal = @($runs | Where-Object { $_.Index -ge 2 -and $_.Ok -and $_.Engine -ne 'sapi' })
      if ($nonLocal.Count -gt 0 -and $s5 -eq 'PASS') {
        $s5 = 'WARN'; $s5note = "$s5note；注意有运行落到了非本地引擎"
      }
    }
    Add-Line '  合成音频样本保存在: app\dist\probe\（可播放试听）'
    Add-Line ''
    # 在线 Edge 对照：通过测试钩子把 PowerShell 通道指向不存在的程序，强制走在线通路（不改任何代码）
    Add-Line '  在线 Edge 对照（测试钩子 LDN_SAPI_PS 指向不存在程序，强制走在线通路）:'
    $er = Invoke-Probe -ProbeArgs @($ProbeScript, 'synth') -ExtraEnv @{ LDN_SAPI_PS = 'ldn-selfcheck-no-such-powershell.exe' }
    $ej = $er.Json
    if ($ej -and $ej.ok -eq $true -and $ej.engine -eq 'edge') {
      Add-Line "    edge elapsedMs = $($ej.elapsedMs) ms  (degraded=$($ej.degraded))"
      Add-Line '    说明: 该数字仅作对照；在线数字受网络波动影响，不代表本地引擎水平。'
    } elseif ($ej -and $ej.ok -eq $true) {
      Add-Line "    意外结果: engine=$($ej.engine)（期望 edge），elapsedMs=$($ej.elapsedMs)"
    } else {
      Add-Line "    在线对照未能完成（不影响本地结论；可能是网络不通或缺少 node-edge-tts）。退出码=$($er.ExitCode)"
      Add-Raw ((($er.Output -split "`r?`n") | Select-Object -First 6))
    }
    Set-StepVerdict 5 '延迟实测' $s5 $s5note
  }

  # ============ 步骤 6：断网复测 ============
  Write-StepHeader 6 '断网复测（纯离线可用性）'
  if (-not $script:Node) {
    Add-Line '  [x] 跳过：未找到 Node.js'
    Set-StepVerdict 6 '断网复测' 'FAIL' '无 Node.js，无法测量'
  } else {
    Write-Host ''
    Write-Host '  ---- 需要你配合一步 ----' -ForegroundColor Yellow
    Write-Host '  请现在【拔掉网线】，或打开【飞行模式 / 关闭 Wi-Fi】。'
    Write-Host '  断网完成后，回到本窗口按【回车键】继续……'
    Write-Host ''
    $confirmed = $false
    try { $null = Read-Host '  准备好后按回车继续'; $confirmed = $true } catch { $confirmed = $false }
    if ($confirmed) {
      Add-Line '  用户操作: 已手动断网并按回车继续'
    } else {
      Add-Line '  用户操作: 无法等待键盘输入（非交互环境），按当前网络状态继续'
    }
    Add-Line ''
    $s6 = 'PASS'; $s6note = '断网后本地合成正常'
    # 6a. 探测状态
    $sr = Invoke-Probe -ProbeArgs @($ProbeScript, 'status')
    $sj = $sr.Json
    if ($sj -and $sj.engine) {
      Add-Line "  断网后 status: active=$($sj.engine.active)  local.available=$($sj.engine.local.available)  degraded=$($sj.engine.degraded)"
      if (-not $sj.engine.local.available) {
        Add-Line "    本地不可用原因: $($sj.engine.local.reason) - $($sj.engine.local.message)"
      }
    } else {
      Add-Line "  断网后 status 无法解析（退出码 $($sr.ExitCode)）"
    }
    # 6b. 本地合成
    $lr = Invoke-Probe -ProbeArgs @($ProbeScript, 'synth')
    $lj = $lr.Json
    if ($lj -and $lj.ok -eq $true -and $lj.engine -eq 'sapi') {
      Add-Line "  断网后本地 synth: ok  engine=$($lj.engine)  elapsedMs=$($lj.elapsedMs)  durationMs=$($lj.durationMs)"
    } elseif ($lj -and $lj.ok -eq $true) {
      Add-Line "  断网后 synth 落到了 $($lj.engine)（不是本地 sapi）elapsedMs=$($lj.elapsedMs)"
      $s6 = 'WARN'; $s6note = '断网后合成未走本地引擎'
    } else {
      Add-Line "  断网后本地 synth 失败（退出码 $($lr.ExitCode)）"
      Add-Raw ((($lr.Output -split "`r?`n") | Select-Object -First 8))
      $s6 = 'FAIL'; $s6note = '断网后本地合成失败'
    }
    # 6c. 验证网络确实已断开：强制走在线通路应当失败
    $nr = Invoke-Probe -ProbeArgs @($ProbeScript, 'synth') -ExtraEnv @{ LDN_SAPI_PS = 'ldn-selfcheck-no-such-powershell.exe' }
    $nj = $nr.Json
    if ($nj -and $nj.ok -eq $true) {
      Add-Line "  [！] 强制在线通路仍然成功（engine=$($nj.engine) elapsedMs=$($nj.elapsedMs)）：网络可能没有真正断开"
      if ($s6 -eq 'PASS') { $s6 = 'WARN'; $s6note = '本地合成正常，但网络似乎未真正断开（在线对照仍成功）' }
    } else {
      Add-Line '  [√] 强制在线通路失败（符合预期：网络已断开，纯离线路径可用）'
    }
    Set-StepVerdict 6 '断网复测' $s6 $s6note
  }

  # ============ 步骤 7：汇总 ============
  Write-StepHeader 7 '汇总'
  if ($script:StepResults.Count -eq 0) {
    $script:Overall = 'FAIL'
  } elseif ($script:StepResults | Where-Object { $_.Verdict -eq 'FAIL' }) {
    $script:Overall = 'FAIL'
  } elseif ($script:StepResults | Where-Object { $_.Verdict -eq 'WARN' }) {
    $script:Overall = 'WARN'
  } else {
    $script:Overall = 'PASS'
  }
  Add-Line ('  {0,-6} {1,-30} {2,-5} {3}' -f '步骤', '内容', '结论', '关键结论')
  foreach ($s in $script:StepResults) {
    Add-Line ('  {0,-6} {1,-30} {2,-5} {3}' -f $s.Step, $s.Title, $s.Verdict, $s.Summary)
  }
  Add-Line ''
  Add-Line "  总体结论: $script:Overall"
  Add-Line ''
  Add-Line '  说明: 本报告由双击 app\scripts\win-selfcheck.cmd 在 Windows 真机自动生成，'
  Add-Line '        所有数字均来自本次实跑；请将本文件发回给编排者。'

} catch {
  Add-Line ''
  Add-Line ('[x] 自检过程出现未预期的错误: ' + $_.Exception.Message)
  $stack = [string]$_.ScriptStackTrace
  if ($stack) { Add-Raw (($stack -split "`r?`n")) }
  $script:Overall = 'FAIL'
}

# ---------------- 写出报告并打开文件夹（即使中途出错也会执行）----------------
try {
  $header = New-Object System.Collections.Generic.List[string]
  $header.Add('=' * 72)
  $header.Add('朗读女 Neo · Windows 一键自检报告（NVSA 本地离线语音引擎 · v2.3.0）')
  $header.Add("生成时间 : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
  $header.Add("计算机   : $env:COMPUTERNAME    用户: $env:USERNAME")
  $nodeTxt = '未找到'
  if ($script:Node) { $nodeTxt = "$($script:Node.Version) ($($script:Node.Label))" }
  $header.Add("Node      : $nodeTxt")
  $header.Add('运行方式 : 双击 app\scripts\win-selfcheck.cmd（自动提权 -> 本报告）')
  $header.Add('=' * 72)
  $all = @($header) + @($script:Report)
  $all | Out-File -FilePath $ResultFile -Encoding utf8
} catch {
  Write-Host "  [x] 写报告失败: $($_.Exception.Message)" -ForegroundColor Red
}

$overallColor = 'Green'
$exitCode = 0
if ($script:Overall -eq 'WARN') { $overallColor = 'Yellow'; $exitCode = 1 }
if ($script:Overall -eq 'FAIL') { $overallColor = 'Red'; $exitCode = 2 }

Write-Host ''
Write-Host "自检完成：$script:Overall" -ForegroundColor $overallColor
Write-Host "结果文件：$ResultFile"
Write-Host '结果文件夹即将打开 —— 请把该 txt 文件（或整个 results 文件夹）发回给编排者。'

try { Start-Process -FilePath explorer.exe -ArgumentList "/select,`"$ResultFile`"" } catch {
  try { Invoke-Item -Path $ResultsDir } catch { }
}

exit $exitCode
