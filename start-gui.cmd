@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js ^(22.18 or newer^) is required.
  echo   Download it from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(one time^)...
  call npm install --no-audit --no-fund || goto :fail
)

echo Starting EZ Scanner...
node src\cli\main.ts gui
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo   EZ Scanner stopped with an error. The messages above explain what happened.
pause
exit /b 1
