@echo off
setlocal
cd /d "%~dp0"
title openGym connector - release
echo.
echo  Usage:  Release.cmd 1.2.0 "what changed"
echo.
if "%~1"=="" (
  echo  Give a version number, e.g.  Release.cmd 1.2.0 "pyramid fixes"
  echo.
  pause
  exit /b 1
)
set MSG=%~2
if "%MSG%"=="" set MSG=Release %~1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1" -Version %~1 -Message "%MSG%"
echo.
pause
