@echo off
chcp 65001 >nul
setlocal

rem 启用本仓库的提交检查钩子（双击运行即可，每个 clone 各跑一次）
cd /d "%~dp0.."

set "GIT=git"
where git >nul 2>&1
if errorlevel 1 (
  rem 没装 Git for Windows 时，退回 GitHub Desktop 自带的 git
  for /d %%D in ("%LOCALAPPDATA%\GitHubDesktop\app-*") do (
    if exist "%%D\resources\app\git\cmd\git.exe" set "GIT=%%D\resources\app\git\cmd\git.exe"
  )
)

"%GIT%" rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [失败] 当前目录不是 git 仓库，或找不到 git 命令。
  echo         请确认本文件位于仓库内的 scripts 目录下。
  echo.
  pause
  exit /b 1
)

"%GIT%" config core.hooksPath scripts/git-hooks
if errorlevel 1 (
  echo.
  echo  [失败] 写入 git 配置失败。
  echo.
  pause
  exit /b 1
)

echo.
echo  已启用提交检查（core.hooksPath = scripts/git-hooks）
echo.
echo    - 提交时暂存了 data/ 下的数据文件   → 拒绝
echo    - 提交或推送时本地落后 origin/main  → 拒绝，提示先 pull --rebase
echo.
echo  以后每次提交/推送都会自动检查，不需要再运行本文件。
echo.
pause
