@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-Gym-AI.ps1"
if errorlevel 1 pause
for /f "delims=" %%t in ('type "%~dp0secrets\mcp-token" 2^>nul') do set "TOKEN=%%t"
if defined TOKEN start "" "http://127.0.0.1:8787/?token=%TOKEN%"
