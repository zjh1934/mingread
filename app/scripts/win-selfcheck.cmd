@echo off
chcp 65001 >nul
setlocal EnableExtensions

rem =====================================================================
rem  朗读女 Neo · Windows 一键自检（NVSA 本地离线语音引擎 · v2.3.0）
rem
rem  用法：双击本文件，就这一下，其余全自动。
rem
rem  会发生什么：
rem    1. 如果还不是管理员、且本地语音引擎（NVSA）还没注册，本文件会
rem       自动以管理员身份重启自己，完成一次性的引擎注册（regsvr32）。
rem       你只需要在"用户账户控制"弹窗上点一次【是】。
rem       已经注册过则不会弹任何窗口。
rem    2. 然后运行 win-selfcheck.ps1，依次执行全部 7 个自检步骤，
rem       报告写入: app\results\win-selfcheck-<时间戳>.txt
rem    3. 全部跑完后，结果文件夹会自动打开 —— 把报告文件发回给编排者即可。
rem
rem  退出码：0 = 全部通过 | 1 = 通过但有警告 | 2 = 未通过 | 900 = 找不到 ps1
rem  卸载语音包：register-nvsa.cmd -Unregister（需管理员）
rem =====================================================================

set "PS1=%~dp0win-selfcheck.ps1"
if not exist "%PS1%" (
  echo [错误] 找不到 win-selfcheck.ps1，它应该和本文件在同一个文件夹里。
  echo         期望位置: "%PS1%"
  pause
  exit /b 900
)

rem ---- 1) 当前是否已是管理员？（退出码 0 = 是，1 = 否）----
powershell -NoProfile -Command "exit ([int](-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)))"
if errorlevel 1 goto :not_admin
goto :run

:not_admin
rem ---- 2) NVSA 是否已完整注册？已注册则无需提权 ----
rem     PreCheck 退出码 0 = 已注册，非 0 = 需要注册
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PS1%" -PreCheck
if errorlevel 1 goto :elevate
goto :run

:elevate
rem ---- 3) 一次性提权：以管理员身份重启本文件 ----
echo [自检] 需要一次管理员授权来注册本地离线语音引擎（NVSA）。
echo        请在弹出的"用户账户控制"窗口上点【是】—— 整个流程只需要这一次。
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -WorkingDirectory '%~dp0' } catch { exit 7 }"
if errorlevel 1 (
  echo [自检] 管理员授权被取消或失败。
  echo        自检将以标准权限继续，注册步骤会在报告中标记为失败。
  goto :run
)
echo [自检] 已申请提权。新的管理员窗口将运行完整自检，可以关闭本窗口。
exit /b 0

:run
rem ---- 4) 执行自检（中文输出全部来自这里）----
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (
  echo [自检] 全部通过。报告已写入结果文件夹（刚刚已自动打开）。
) else if "%CODE%"=="1" (
  echo [自检] 通过，但有警告。请查看结果文件夹里的报告。
) else if "%CODE%"=="2" (
  echo [自检] 未通过。请查看结果文件夹里的报告，并把它发回给编排者。
) else (
  echo [自检] 已结束（退出码 %CODE%）。请查看结果文件夹里的报告。
)
echo.
pause
exit /b %CODE%
