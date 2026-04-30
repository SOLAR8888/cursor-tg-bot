@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ===== cursor-tg-bot launcher =====
echo.

echo [1/3] Stopping previous bot instances...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-bot.ps1"

echo.
echo [2/3] Waiting for shutdown...
ping 127.0.0.1 -n 3 >nul

echo.
echo [3/3] Starting bot (npm run serve)...
echo.

call npm run serve

echo.
echo ===== bot stopped =====
pause
