@echo off
chcp 65001 >nul
rem 双击即可运行：注册本地离线语音（NVSA + 晓晓 / 云希）
rem 脚本会在需要时自己申请一次管理员授权（UAC），你只需在弹出的窗口点“是”。
rem 卸载：在本文件上右键 → 以管理员身份运行，或命令行执行 register-nvsa.cmd -Unregister
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0register-nvsa.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo [退出码 %EXITCODE%] 2=下载失败 3=管理员授权失败 4=解压/注册失败 5=验证未通过
)
pause
exit /b %EXITCODE%
