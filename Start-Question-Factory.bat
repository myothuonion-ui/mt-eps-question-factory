@echo off
setlocal EnableExtensions
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
  echo [FIRST RUN] Installing app dependencies automatically...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :fail
)

if not exist .env if exist .env.example copy /y .env.example .env >nul

rem First run only: if still in mock mode, let the teacher paste a Gemini key once.
findstr /B /C:"AI_PROVIDER=mock" .env >nul 2>nul
if not errorlevel 1 (
  echo.
  echo ================================================
  echo  MT EPS Question Factory - First Run
  echo ================================================
  echo Paste your Google AI Studio Gemini API key below.
  echo Press ENTER with nothing to keep mock mode.
  set /p "MT_GEMINI_KEY=Gemini API key: "
  if defined MT_GEMINI_KEY (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='.env'; $c=Get-Content $p -Raw; $c=$c -replace '(?m)^AI_PROVIDER=.*$','AI_PROVIDER=gemini'; $c=$c -replace '(?m)^GEMINI_API_KEY=.*$',('GEMINI_API_KEY=' + $env:MT_GEMINI_KEY); Set-Content -Path $p -Value $c -Encoding UTF8"
    if errorlevel 1 goto :fail
    echo [OK] Gemini configured locally. You will not need to enter it again.
  )
)

echo [START] Launching local server...
rem Open the browser only after /api/health is reachable, avoiding ERR_CONNECTION_REFUSED on first start.
start "MT EPS Browser Wait" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "$u='http://127.0.0.1:8787/api/health'; for($i=0;$i -lt 120;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if($r.StatusCode -eq 200){ Start-Process 'http://127.0.0.1:8787'; exit 0 } } catch {}; Start-Sleep -Milliseconds 500 }; exit 1"
call npm run dev
exit /b %errorlevel%

:fail
echo.
echo [ERROR] Setup failed. Check the message above.
pause
exit /b 1
