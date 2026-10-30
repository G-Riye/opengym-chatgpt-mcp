@echo off
setlocal
cd /d "%~dp0"
title openGym - write confirmation mode
if "%~1"=="" goto show
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-write-mode.ps1" -Mode %~1
goto end
:show
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\set-write-mode.ps1" -Mode show
:end
echo.
pause
