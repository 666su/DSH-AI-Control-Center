@echo off
REM Start everything for the DSH Control Center (foreground testing)
REM  1. Control Center backend (serves web UI + API on :3081)
REM  2. Recovery daemon (monitors DSH every 30s, auto-restart)
REM  DSH itself is started separately if not already running.
cd /d "%~dp0.."

echo [1/2] Starting Control Center backend...
start "CC-Backend" cmd /c "cd /d %~dp0..\backend && node server.js"

echo [2/2] Starting recovery daemon (monitor.js)...
start "CC-Monitor" cmd /c "cd /d %~dp0.. && node monitor.js"

echo.
echo Control Center: http://127.0.0.1:3081
echo (if DSH is not running, start it with: npx --yes @deepseek-ai/dsh web --no-open)
