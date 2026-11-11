@echo off
rem melonDS Web - run on this computer only (http://localhost:8080)
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
node server\server.js --port 8080 --open %*
goto end

:nonode
echo Node.js was not found. Trying Python instead (browser mode only, no server emulation).
where python >nul 2>nul
if errorlevel 1 goto nopython
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1 --directory public
goto end

:nopython
echo.
echo Please install Node.js (https://nodejs.org) and run this file again.
echo.

:end
pause
