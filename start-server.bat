@echo off
rem melonDS Web - host for other devices (phones, Chromebooks) on your network or the internet.
rem Optional:  start-server.bat --password 1234 --port 8080 --max-sessions 4
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node server\server.js --public --port 8080 %*
goto end

:nonode
echo.
echo Node.js is required for server mode. Install it from https://nodejs.org and run this file again.
echo.

:end
pause
