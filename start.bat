@echo off
chcp 65001 >nul
echo.
echo  念 · 启动中...
echo.
cd /d "%~dp0backend"

where node >nul 2>&1
if errorlevel 1 (
  echo  [错误] 没找到 Node.js。请先安装 LTS：https://nodejs.org/
  echo  安装后重新打开本窗口再双击 start.bat
  pause
  exit /b 1
)

if not exist node_modules (
  echo  首次启动：正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo  [错误] npm install 失败，请把上方报错发出来
    pause
    exit /b 1
  )
)

REM 若 3000 已被占用（比如你的私密版念已在跑），自动改用 3001
set PORT=3000
powershell -NoProfile -Command "try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3000); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo  [提示] 3000 端口已被占用（多半是另一份念正在运行）
  echo  本次公开版改用 http://localhost:3001
  set PORT=3001
)

echo  后端启动: http://localhost:%PORT%
start "" "http://localhost:%PORT%"
node server.js
echo.
echo  服务已退出。若刚闪退，请看上方是否有报错。
pause
