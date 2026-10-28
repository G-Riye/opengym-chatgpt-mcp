@echo off
setlocal
cd /d "%~dp0"
"%~dp0..\windows\runtime\node.exe" "%~dp0src\main.mjs" token
pause
