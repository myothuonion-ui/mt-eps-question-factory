@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title MT EPS Question Factory Launcher v0.3.1

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

rem Stop a stale local Question Factory server so an older extracted copy cannot keep serving port 8787.
echo [CHECK] Checking port 8787 for an older Question Factory process...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  echo [STOP] Closing old local server PID %%P...
  taskkill /PID %%P /F >nul 2>nul
)
timeout /t 1 /nobreak >nul

if not exist node_modules (
  echo [FIRST RUN] Installing app dependencies automatically...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if not exist .env if exist .env.example copy /y .env.example .env >nul

rem API keys are configured inside the app UI. Do not ask for keys in this terminal.
echo [START] Starting current folder version...
start "MT EPS Question Factory Server" /min cmd /k "cd /d "%~dp0" && npm run dev"

for /L %%I in (1,1,60) do (
  powershell -NoProfile -Command "try { $r=Invoke-RestMethod 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.ok -eq $true) { Write-Output $r.version; exit 0 } } catch {}; exit 1" > "%TEMP%\mt_eps_factory_version.txt" 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 1 /nobreak >nul
)

echo [ERROR] The local server did not become ready within 60 seconds.
echo Check the minimized server window for the error message.
pause
exit /b 1

:ready
set /p MT_FACTORY_VERSION=<"%TEMP%\mt_eps_factory_version.txt"
echo [OK] Server ready. Runtime version: %MT_FACTORY_VERSION%
echo [OPEN] Opening a fresh browser URL so cached UI is bypassed...
start "" "http://127.0.0.1:8787/?v=%MT_FACTORY_VERSION%&fresh=%RANDOM%%RANDOM%"
exit /b 0

:fail
echo.
echo [ERROR] Setup failed. Check the message above.
pause
exit /b 1
