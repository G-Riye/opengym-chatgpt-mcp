@echo off
setlocal
cd /d "%~dp0"
title openGym - phone QR
echo.
echo  Building a QR code for the public openGym URL (includes the access token).
echo.
"%~dp0..\windows\runtime\node.exe" "%~dp0scripts\make-app-qr.mjs"
if errorlevel 1 (
  echo.
  echo  Could not build it. Usually because the public URL is not on yet:
  echo    run Tunnel-Tailscale.cmd first, then this file again.
  echo.
  pause
  exit /b 1
)
start "" "%~dp0store\app-qr.png"
echo.
echo  Scan the image with the iPhone camera. First open sets a cookie, after that
echo  "Add to Home Screen" gives you a normal openGym icon that works on 5G.
echo.
pause
