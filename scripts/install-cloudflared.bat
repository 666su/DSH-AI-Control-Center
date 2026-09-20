@echo off
REM =====================================================
REM  cloudflared 隧道脚本（配合 Cloudflare Zero Trust）
REM
REM  用法：
REM    %~f0 tunnel         以临时快速隧道运行（trycloudflare.com，免账号）
REM    %~f0 run            用下方 TOKEN 前台运行命名隧道
REM    %~f0 install        用下方 TOKEN 安装 cloudflared 为 Windows 服务（推荐，开机自启）
REM    %~f0 uninstall      卸载 cloudflared 服务
REM    %~f0 update         更新 cloudflared.exe 到最新版
REM =====================================================
setlocal
set ROOT=%~dp0..
set CF=%~dp0cloudflared.exe

REM >>>>>>>>>> 在这里填入你的命名隧道 Token <<<<<<<<<<
REM 获取方式：Cloudflare Dashboard -> Zero Trust -> Networks -> Tunnels
REM           -> 创建隧道(Cloudflared) -> 复制 "Token" 一栏
set TOKEN=REPLACE_WITH_YOUR_TUNNEL_TOKEN

if not exist "%CF%" (
  echo [下载] cloudflared...
  powershell -Command "Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile %CF%"
)

if "%1"=="tunnel" (
  "%CF%" tunnel --url http://127.0.0.1:3081
  goto :eof
)

if "%1"=="run" (
  if "%TOKEN%"=="REPLACE_WITH_YOUR_TUNNEL_TOKEN" (
    echo [错误] 请先编辑本脚本，把 TOKEN 改成你隧道实际的 token。
    pause & exit /b 1
  )
  "%CF%" tunnel run --token %TOKEN%
  goto :eof
)

if "%1"=="install" (
  if "%TOKEN%"=="REPLACE_WITH_YOUR_TUNNEL_TOKEN" (
    echo [错误] 请先编辑本脚本，把 TOKEN 改成你隧道实际的 token。
    pause & exit /b 1
  )
  echo [安装] cloudflared 为 Windows 服务（Cloudflared）...
  "%CF%" service install %TOKEN%
  echo 服务已安装并设为开机自启。查看状态: sc query Cloudflared
  pause
  goto :eof
)

if "%1"=="uninstall" (
  "%CF%" service uninstall
  echo 已卸载 cloudflared 服务。
  pause
  goto :eof
)

if "%1"=="update" (
  powershell -Command "Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile %CF%"
  echo cloudflared 已更新。
  pause
  goto :eof
)

echo 用法: %~f0 tunnel ^| run ^| install ^| uninstall ^| update
