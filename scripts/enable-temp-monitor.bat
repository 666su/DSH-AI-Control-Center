@echo off
REM Thin launcher: all logic lives in enable-temp-monitor.ps1,
REM which self-elevates. Just double-click this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-temp-monitor.ps1"
if errorlevel 1 pause