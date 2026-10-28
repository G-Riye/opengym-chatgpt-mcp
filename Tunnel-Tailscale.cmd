@echo off
setlocal
cd /d "%~dp0"
title openGym - Tailscale Funnel

echo.
echo  Starting Tailscale Funnel for the ChatGPT connector.
echo    - If Tailscale is logged out, a browser login page opens and this window WAITS
echo      for you (up to 5 minutes), then continues on its own. You do not need to rerun.
echo    - If Funnel is not enabled on your tailnet, the enable page opens; click Enable
echo      and this window retries by itself.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\tunnel.ps1" -Mode tailscale

echo.
echo  ================= current state =================
"C:\Program Files\Tailscale\tailscale.exe" status 2>&1
echo.
"C:\Program Files\Tailscale\tailscale.exe" funnel status 2>&1
echo.
if exist "%~dp0store\public-url.txt" (
  echo  ChatGPT connector base:
  type "%~dp0store\public-url.txt"
  echo.
  echo  Run Show-Connection.cmd for the full URL including the token.
)
echo  =================================================
echo.
pause
