@echo off
setlocal
cd /d "%~dp0"
title MT EPS Question Factory

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [SETUP] Installing app dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if not exist .env if exist .env.example copy /y .env.example .env >nul

start "" http://127.0.0.1:8787
call npm run dev
exit /b %errorlevel%

:fail
echo.
echo [ERROR] Setup failed. Check the message above.
pause
exit /b 1
