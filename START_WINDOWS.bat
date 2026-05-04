@echo off
setlocal EnableDelayedExpansion
title NEXUS v2 — Setup & Launch
color 0A

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║          NEXUS v2 — Device Ecosystem         ║
echo  ║        Auto-Setup ^& Launcher (Windows)       ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: ── Check if already running ─────────────────────────────────────────────────
netstat -ano 2>nul | find "7523" | find "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo  [OK] NEXUS is already running on port 7523
  echo  [>>] Opening browser...
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:7523"
  echo.
  echo  Press any key to exit...
  pause >nul
  exit /b 0
)

:: ── Check Node.js ─────────────────────────────────────────────────────────────
echo  [1/4] Checking Node.js...
where node >nul 2>&1
if %errorlevel%==0 (
  for /f "tokens=*" %%v in ('node --version 2^>nul') do set NODE_VER=%%v
  echo  [OK] Node.js found: !NODE_VER!
  goto :check_deps
)

:: Node not found — download and install silently
echo  [..] Node.js not found. Downloading automatically...
echo  [..] This may take 1-2 minutes on first run. Please wait.
echo.

:: Create temp directory
set TMPDIR=%TEMP%\nexus_setup
if not exist "%TMPDIR%" mkdir "%TMPDIR%"

:: Detect architecture
reg Query "HKLM\Hardware\Description\System\CentralProcessor\0" /v "Identifier" 2>nul | find /i "x86" >nul
if errorlevel 1 (
  set NODE_URL=https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
  set NODE_FILE=%TMPDIR%\node-x64.msi
) else (
  set NODE_URL=https://nodejs.org/dist/v20.11.0/node-v20.11.0-x86.msi
  set NODE_FILE=%TMPDIR%\node-x86.msi
)

:: Download Node.js
echo  [..] Downloading Node.js v20 LTS...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%NODE_URL%', '%NODE_FILE%')" 2>nul

if not exist "%NODE_FILE%" (
  echo.
  echo  [ERROR] Failed to download Node.js. Please check your internet connection.
  echo  [INFO]  Download manually from: https://nodejs.org
  echo  [INFO]  Install Node.js LTS, then re-run this script.
  pause
  exit /b 1
)

echo  [..] Installing Node.js silently...
msiexec /i "%NODE_FILE%" /qn /norestart ADDLOCAL=ALL 2>nul

:: Refresh PATH
call :refresh_path

:: Verify install
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  [WARN] Node.js install completed. Please restart this script.
  echo  [INFO] If this keeps failing, restart your computer first.
  pause
  exit /b 1
)
echo  [OK] Node.js installed successfully!

:check_deps
echo.
echo  [2/4] Checking dependencies...

:: Get script directory
set NEXUS_DIR=%~dp0
:: Remove trailing backslash
if "%NEXUS_DIR:~-1%"=="\" set NEXUS_DIR=%NEXUS_DIR:~0,-1%

if not exist "%NEXUS_DIR%\package.json" (
  echo  [ERROR] package.json not found in: %NEXUS_DIR%
  echo  [INFO]  Make sure you run this from the NEXUS folder.
  pause
  exit /b 1
)

if not exist "%NEXUS_DIR%\node_modules" (
  echo  [..] Installing packages (first run only)...
  cd /d "%NEXUS_DIR%"
  call npm install --loglevel=error 2>nul
  if %errorlevel% neq 0 (
    echo  [..] Retrying with verbose output...
    call npm install
  )
  echo  [OK] Packages installed!
) else (
  echo  [OK] Dependencies already installed.
)

:setup_firewall
echo.
echo  [3/4] Configuring firewall for local network...
netsh advfirewall firewall show rule name="NEXUS-7523" >nul 2>&1
if %errorlevel% neq 0 (
  netsh advfirewall firewall add rule name="NEXUS-7523" dir=in action=allow protocol=TCP localport=7523 >nul 2>&1
  netsh advfirewall firewall add rule name="NEXUS-7524-UDP" dir=in action=allow protocol=UDP localport=7524 >nul 2>&1
  echo  [OK] Firewall rules added (TCP 7523 + UDP 7524)
) else (
  echo  [OK] Firewall already configured.
)

:start_server
echo.
echo  [4/4] Starting NEXUS server...
cd /d "%NEXUS_DIR%"

:: Get local IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
  set LOCAL_IP=%%a
  set LOCAL_IP=!LOCAL_IP: =!
  goto :got_ip
)
:got_ip

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║             NEXUS IS STARTING                ║
echo  ╠══════════════════════════════════════════════╣
echo  ║  This PC : http://localhost:7523             ║
if defined LOCAL_IP (
  echo  ║  Network : http://!LOCAL_IP!:7523          ║
)
echo  ╠══════════════════════════════════════════════╣
echo  ║  Android: open Chrome, go to the URL above  ║
echo  ║  Or scan the QR code from the app           ║
echo  ╠══════════════════════════════════════════════╣
echo  ║  Close this window to stop the server       ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Open browser after 2 seconds
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start """" http://localhost:7523"

:: Start server (keeps window open)
node server/index.js

echo.
echo  Server stopped. Press any key to exit...
pause >nul
goto :eof

:refresh_path
:: Refresh environment variables to pick up newly installed Node
for /f "skip=2 tokens=3*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%a %%b"
for /f "skip=2 tokens=3*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USR_PATH=%%a %%b"
if defined SYS_PATH set "PATH=%SYS_PATH%;%USR_PATH%;%PATH%"
goto :eof
