@echo off
setlocal
cd /d "%~dp0"
title openGym - restart tunnel
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-tunnel.ps1"
set CODE=%ERRORLEVEL%
echo.
if not "%CODE%"=="0" echo  Exit code: %CODE%
pause
