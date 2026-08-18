@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title MT EPS Question Factory Launcher

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [FIRST RUN] Installing app dependencies automatically...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if not exist .env if exist .env.example copy /y .env.example .env >nul

rem First run convenience: Gemini can be entered here once. GLM and Cloudflare can be added later inside 05 API & Tools.
findstr /B /C:"AI_PROVIDER=mock" .env >nul 2>nul
if not errorlevel 1 (
  echo.
  echo ================================================
  echo  MT EPS Question Factory - First Run
  echo ================================================
  echo Paste your Google AI Studio Gemini API key below.
  echo Press ENTER with nothing to skip and configure APIs inside the app.
  set /p "MT_GEMINI_KEY=Gemini API key: "
  if defined MT_GEMINI_KEY (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='.env'; $c=Get-Content $p -Raw; $c=$c -replace '(?m)^AI_PROVIDER=.*$','AI_PROVIDER=gemini'; $c=$c -replace '(?m)^GEMINI_API_KEY=.*$',('GEMINI_API_KEY=' + $env:MT_GEMINI_KEY); Set-Content -Path $p -Value $c -Encoding UTF8"
    if errorlevel 1 goto :fail
    echo [OK] Gemini configured locally.
  )
)

echo [START] Starting local server...
start "MT EPS Question Factory Server" /min cmd /k "cd /d "%~dp0" && npm run dev"

for /L %%I in (1,1,45) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/health' -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 1 /nobreak >nul
)

echo [ERROR] The local server did not become ready within 45 seconds.
echo Check the minimized server window for the error message.
pause
exit /b 1

:ready
echo [OK] Server ready. Opening the app...
start "" http://127.0.0.1:8787
exit /b 0

:fail
echo.
echo [ERROR] Setup failed. Check the message above.
pause
exit /b 1
