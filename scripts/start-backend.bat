@echo off
REM Start the DSH Control Center backend (foreground, for testing)
cd /d "%~dp0..\backend"
echo Starting DSH Control Center backend on http://127.0.0.1:3081
node server.js
