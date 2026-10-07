@echo off
echo.
echo  ✨ 念 · 启动中...
echo.
cd /d %~dp0backend
if not exist node_modules (
  echo  安装依赖中，首次启动请稍候...
  npm install
)
echo  后端服务启动: http://localhost:3000
start "" "http://localhost:3000"
node server.js
pause
