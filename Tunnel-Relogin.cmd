@echo off
setlocal
cd /d "%~dp0"
title openGym - Tailscale re-login
echo.
echo  Force a fresh Tailscale login (use this if the node shows Logged out / NoState,
echo  or if you logged in but the state never became Running).
echo.
echo  A browser page will open. Sign in, then leave this window alone - it continues
echo  by itself and starts Tailscale Funnel afterwards.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\tunnel.ps1" -Mode tailscale -Reauth
echo.
echo  --- current state ---
"C:\Program Files\Tailscale\tailscale.exe" status 2>&1
echo.
echo  --- funnel ---
"C:\Program Files\Tailscale\tailscale.exe" funnel status 2>&1
echo.
pause
