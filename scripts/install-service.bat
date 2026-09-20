@echo off
REM =====================================================
REM  Install DSH Control Center as Windows services (NSSM)
REM  Requires NSSM: https://nssm.cc (put nssm.exe in PATH or scripts/nssm.exe)
REM
REM  Services installed:
REM   DSHControlCenter  -> backend (API + web UI)
REM   DSHControlMonitor -> recovery daemon (auto-restart DSH)
REM
REM  Run as Administrator:  right-click -> Run as administrator
REM =====================================================
setlocal
set ROOT=%~dp0..

REM ---- 自动定位 node.exe（请确保 Node.js 已加入 PATH）----
set "NODE=node.exe"
where node.exe >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where node.exe') do set "NODE=%%i"
)
echo Using Node.js: %NODE%

where nssm >nul 2>nul
if %errorlevel%==0 goto :nssm_found
if exist "%~dp0nssm.exe" (
  set NSSM=%~dp0nssm.exe
) else (
  echo [ERROR] nssm.exe not found in PATH or %~dp0
  echo Download from https://nssm.cc and place nssm.exe next to this script, or add to PATH.
  pause
  exit /b 1
)

:nssm_found
if "%NSSM%"=="" set NSSM=nssm

echo Installing DSHControlCenter service...
%NSSM% install DSHControlCenter "%NODE%" "%ROOT%\backend\server.js"
%NSSM% set DSHControlCenter AppDirectory "%ROOT%\backend"
%NSSM% set DSHControlCenter DisplayName "DSH Control Center Backend"
%NSSM% set DSHControlCenter Description "DSH AI Control Center - API + Web UI (port 3081)"
%NSSM% set DSHControlCenter Start SERVICE_AUTO_START
%NSSM% set DSHControlCenter AppStdout "%ROOT%\logs\backend-service.log"
%NSSM% set DSHControlCenter AppStderr "%ROOT%\logs\backend-service.err.log"
%NSSM% set DSHControlCenter AppRotateFiles 1
%NSSM% set DSHControlCenter AppRotateBytes 10485760

echo Installing DSHControlMonitor service...
%NSSM% install DSHControlMonitor "%NODE%" "%ROOT%\monitor.js"
%NSSM% set DSHControlMonitor AppDirectory "%ROOT%"
%NSSM% set DSHControlMonitor DisplayName "DSH Control Center Recovery Monitor"
%NSSM% set DSHControlMonitor Description "Checks DSH every 30s and auto-restarts it when down (logs/recovery.log)"
%NSSM% set DSHControlMonitor Start SERVICE_AUTO_START
%NSSM% set DSHControlMonitor AppStdout "%ROOT%\logs\monitor-service.log"
%NSSM% set DSHControlMonitor AppStderr "%ROOT%\logs\monitor-service.err.log"
%NSSM% set DSHControlMonitor AppRotateFiles 1
%NSSM% set DSHControlMonitor AppRotateBytes 10485760

echo.
echo Starting services...
%NSSM% start DSHControlCenter
%NSSM% start DSHControlMonitor

echo.
echo Done. Services: DSHControlCenter (port 3081), DSHControlMonitor
echo Verify: sc query DSHControlCenter & sc query DSHControlMonitor
pause
