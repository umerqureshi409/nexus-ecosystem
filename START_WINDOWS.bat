@echo off
setlocal EnableDelayedExpansion
title NEXUS — Starting...
mode con: cols=62 lines=36

set "NEXUS_DIR=%~dp0"
if "%NEXUS_DIR:~-1%"=="\" set "NEXUS_DIR=%NEXUS_DIR:~0,-1%"
set "PORT=7523"
set "LOGFILE=%NEXUS_DIR%\nexus-log.txt"
set "NODE_INSTALL_DIR=%APPDATA%\nexus-node"
set "NODE_EXE="

call :clear_screen
call :print_header

:: ── Already running? ──────────────────────────────────────────
call :step_msg "1" "5" "Checking if NEXUS is already running..."
netstat -ano 2>nul | find ":%PORT%" | find "LISTENING" >nul 2>&1
if !errorlevel!==0 (
  call :ok_msg "NEXUS is already running on port %PORT%"
  call :blank
  call :info_msg "Opening NEXUS in your browser..."
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:%PORT%"
  call :blank
  call :info_msg "NEXUS is running. Close its terminal window to stop."
  call :blank
  call :pause_exit
)

:: ── Find or install Node.js ───────────────────────────────────
call :blank
call :step_msg "2" "5" "Checking for Node.js..."

where node >nul 2>&1
if !errorlevel!==0 (
  for /f "tokens=*" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
  call :ok_msg "Node.js !NODE_VER! found"
  set "NODE_EXE=node"
  goto :check_deps
)

if exist "%NODE_INSTALL_DIR%\node.exe" (
  set "NODE_EXE=%NODE_INSTALL_DIR%\node.exe"
  set "PATH=%NODE_INSTALL_DIR%;%PATH%"
  for /f "tokens=*" %%v in ('"%NODE_EXE%" --version 2^>nul') do set "NODE_VER=%%v"
  call :ok_msg "Node.js !NODE_VER! found (NEXUS managed)"
  goto :check_deps
)

call :blank
call :warn_msg "Node.js not found  —  downloading automatically..."
call :info_msg "This is a one-time setup. Please wait ~1 minute."
call :blank

set "ARCH=x64"
reg Query "HKLM\Hardware\Description\System\CentralProcessor\0" /v "Identifier" 2>nul | find /i "ARM" >nul 2>&1
if !errorlevel!==0 set "ARCH=arm64"

set "NODE_URL=https://nodejs.org/dist/v20.11.0/node-v20.11.0-win-%ARCH%.zip"
set "NODE_ZIP=%TEMP%\nexus-node.zip"
set "NODE_EXTRACT=%TEMP%\nexus-node-extract"

call :info_msg "Downloading Node.js v20 LTS (%ARCH%)..."
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;(New-Object Net.WebClient).DownloadFile('%NODE_URL%','%NODE_ZIP%')" 2>nul

if not exist "%NODE_ZIP%" (
  call :error_msg "Download failed. Check your internet connection."
  call :blank
  call :info_msg "Install Node.js manually: https://nodejs.org"
  call :info_msg "Then re-run this script."
  call :pause_exit
)

call :info_msg "Extracting..."
if exist "%NODE_EXTRACT%" rmdir /s /q "%NODE_EXTRACT%" >nul 2>&1
mkdir "%NODE_EXTRACT%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%NODE_EXTRACT%' -Force" 2>nul

set "NODE_SRC="
for /d %%d in ("%NODE_EXTRACT%\node-*") do set "NODE_SRC=%%d"
if not defined NODE_SRC (
  call :error_msg "Extraction failed. Install Node.js manually: https://nodejs.org"
  call :pause_exit
)

if exist "%NODE_INSTALL_DIR%" rmdir /s /q "%NODE_INSTALL_DIR%" >nul 2>&1
xcopy /E /I /Q "%NODE_SRC%" "%NODE_INSTALL_DIR%" >nul 2>&1
del "%NODE_ZIP%" >nul 2>&1
rmdir /s /q "%NODE_EXTRACT%" >nul 2>&1

set "NODE_EXE=%NODE_INSTALL_DIR%\node.exe"
set "PATH=%NODE_INSTALL_DIR%;%PATH%"

if not exist "%NODE_EXE%" (
  call :error_msg "Setup failed. Install Node.js manually: https://nodejs.org"
  call :pause_exit
)
for /f "tokens=*" %%v in ('"%NODE_EXE%" --version 2^>nul') do set "NODE_VER=%%v"
call :ok_msg "Node.js !NODE_VER! installed!"

:check_deps
:: ── npm packages ──────────────────────────────────────────────
call :blank
call :step_msg "3" "5" "Checking packages..."

if not exist "%NEXUS_DIR%\package.json" (
  call :error_msg "package.json not found. Run this script from the NEXUS folder."
  call :pause_exit
)

if not exist "%NEXUS_DIR%\node_modules" (
  call :info_msg "Installing packages (first run only — ~30 seconds)..."

  set "NPM_CMD=npm"
  where npm >nul 2>&1
  if !errorlevel! neq 0 (
    if exist "%NODE_INSTALL_DIR%\node_modules\npm\bin\npm-cli.js" (
      set "NPM_CMD=\"%NODE_EXE%\" \"%NODE_INSTALL_DIR%\node_modules\npm\bin\npm-cli.js\""
    )
  )

  cd /d "%NEXUS_DIR%"
  !NPM_CMD! install --loglevel=error >"!LOGFILE!" 2>&1
  if !errorlevel! neq 0 (
    call :error_msg "Package install failed. See nexus-log.txt for details."
    call :pause_exit
  )
  call :ok_msg "Packages installed!"
) else (
  call :ok_msg "All packages present."
)

:: ── Firewall ──────────────────────────────────────────────────
call :blank
call :step_msg "4" "5" "Configuring Windows Firewall..."
netsh advfirewall firewall show rule name="NEXUS-7523-IN" >nul 2>&1
if !errorlevel! neq 0 (
  netsh advfirewall firewall add rule name="NEXUS-7523-IN"  dir=in  action=allow protocol=TCP localport=7523 profile=private >nul 2>&1
  netsh advfirewall firewall add rule name="NEXUS-7523-OUT" dir=out action=allow protocol=TCP localport=7523 profile=private >nul 2>&1
  netsh advfirewall firewall add rule name="NEXUS-7524-UDP" dir=in  action=allow protocol=UDP localport=7524 profile=private >nul 2>&1
  call :ok_msg "Firewall rules added (TCP 7523 + UDP 7524)"
) else (
  call :ok_msg "Firewall already configured."
)

:: ── Get local IP ──────────────────────────────────────────────
set "LOCAL_IP=your-local-ip"
for /f "tokens=2 delims=:" %%a in ('ipconfig 2^>nul ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
  set "RAW=%%a"
  set "LOCAL_IP=!RAW: =!"
  goto :got_ip
)
:got_ip

:: ── Launch ────────────────────────────────────────────────────
call :blank
call :step_msg "5" "5" "Starting NEXUS server..."
call :blank

call :clear_screen
call :print_running_header

echo.
echo    +--------------------------------------------------+
echo    ^|                                                  ^|
echo    ^|   This PC  :  http://localhost:%PORT%             ^|
echo    ^|   Network  :  http://!LOCAL_IP!:%PORT%       ^|
echo    ^|                                                  ^|
echo    +--------------------------------------------------+
echo    ^|   Open either URL in any browser on your        ^|
echo    ^|   Wi-Fi network. Scan the QR code in the app    ^|
echo    ^|   to connect your phone instantly.              ^|
echo    +--------------------------------------------------+
echo.
echo    >>>  Ctrl+C  or  close this window  to stop NEXUS
echo.
echo    ====================================================

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start \"\" \"http://localhost:%PORT%\""

cd /d "%NEXUS_DIR%"
if defined NODE_EXE (
  if not "%NODE_EXE%"=="node" (
    "%NODE_EXE%" server\index.js
    goto :stopped
  )
)
node server\index.js

:stopped
echo.
echo    ====================================================
echo     NEXUS has stopped.
echo    ====================================================
echo.
call :pause_exit
goto :eof

:clear_screen
cls
goto :eof

:blank
echo.
goto :eof

:print_header
echo.
echo    ##    ## ######## ##     ## ##     ##  ######
echo    ###   ## ##        ##   ##  ##     ## ##    ##
echo    ####  ## ##         ## ##   ##     ## ##
echo    ## ## ## ######      ###    ##     ##  ######
echo    ##  #### ##          ## ##  ##     ##       ##
echo    ##   ### ##          ##  ##  ##   ##  ##    ##
echo    ##    ## ########   ##    ##  #####    ######
echo.
echo    Local Device Ecosystem  ^|  v2.0  ^|  Windows
echo    ──────────────────────────────────────────────
echo.
goto :eof

:print_running_header
echo.
echo    ##    ## ######## ##     ## ##     ##  ######
echo    ###   ## ##        ##   ##  ##     ## ##    ##
echo    ####  ## ##         ## ##   ##     ## ##
echo    ## ## ## ######      ###    ##     ##  ######
echo    ##  #### ##          ## ##  ##     ##       ##
echo    ##   ### ##          ##  ##  ##   ##  ##    ##
echo    ##    ## ########   ##    ##  #####    ######
echo.
echo                     RUNNING
echo    ──────────────────────────────────────────────
goto :eof

:step_msg
echo    [%~1/%~2]  %~3
goto :eof

:ok_msg
echo    [ OK ]  %~1
goto :eof

:warn_msg
echo    [ !! ]  %~1
goto :eof

:info_msg
echo    [  >  ]  %~1
goto :eof

:error_msg
echo.
echo    [ERROR]  %~1
echo.
goto :eof

:pause_exit
echo.
echo    Press any key to close...
pause >nul
exit /b 0
