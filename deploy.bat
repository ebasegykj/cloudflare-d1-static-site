@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ============================================================
rem  deploy.bat -- double-click to check & bring up Pages deploy
rem  args also accepted: --check / --force  (passed to deploy.sh)
rem  real logic lives in deploy.sh  (bash deploy.sh in terminal)
rem ============================================================

rem ---- 1. 找 Git Bash（按常见安装位置依次尝试，兼容装在 D 盘的情况）----
set "BASH="
for %%d in (
  "%ProgramFiles%\Git"
  "%ProgramFiles(x86)%\Git"
  "%LOCALAPPDATA%\Programs\Git"
  "D:\Program Files\Git"
  "D:\Git"
  "E:\Program Files\Git"
) do (
  if not defined BASH if exist "%%~d\bin\bash.exe" set "BASH=%%~d\bin\bash.exe"
)
rem 兜底：从 PATH 里找，排除 Windows 自带的 WSL bash（System32）
if not defined BASH (
  for /f "delims=" %%i in ('where bash 2^>nul ^| findstr /v /i "System32"') do (
    if not defined BASH set "BASH=%%i"
  )
)

if not defined BASH (
  echo.
  echo [X] 没找到 Git Bash。
  echo     请先安装 Git for Windows：https://git-scm.com/download/win
  echo     装完重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

rem ---- 2. 跑 deploy.sh（参数原样透传）----
"%BASH%" "%~dp0deploy.sh" %*
set "CODE=%ERRORLEVEL%"

rem ---- 3. 双击运行时留住窗口；带参数调用（自动化）不阻塞 ----
if "%~1"=="" (
  echo.
  if not "%CODE%"=="0" echo [退出码 %CODE%] 上面有失败原因。
  pause
)
exit /b %CODE%
