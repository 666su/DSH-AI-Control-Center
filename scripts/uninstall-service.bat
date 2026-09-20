@echo off
REM Stop and remove the DSH Control Center services (NSSM)
setlocal
where nssm >nul 2>nul
if %errorlevel%==0 (set NSSM=nssm) else if exist "%~dp0nssm.exe" (set NSSM=%~dp0nssm.exe) else (
  echo [ERROR] nssm.exe not found. Download from https://nssm.cc
  pause & exit /b 1
)

%NSSM% stop DSHControlCenter
%NSSM% remove DSHControlCenter confirm
%NSSM% stop DSHControlMonitor
%NSSM% remove DSHControlMonitor confirm
echo Done.
pause
