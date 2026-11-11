@echo off
rem juhyeonDS - host so that devices on OTHER networks (mobile data, another Wi-Fi) can connect.
rem Uses a free Cloudflare quick tunnel. The first run downloads cloudflared (about 55 MB)
rem from Cloudflare's official GitHub releases into the "tools" folder.
rem Optional:  start-server-anywhere.bat --password 1234 --max-sessions 2
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node server\server.js --public --tunnel --port 8080 %*
goto end

:nonode
echo.
echo Node.js is required for server mode. Install it from https://nodejs.org and run this file again.
echo.

:end
pause
