@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "INSTALL_DIR=%LOCALAPPDATA%\ChatGPTFolderBridge"
set "HOST_BAT=%INSTALL_DIR%\host.bat"
set "HOST_MANIFEST=%INSTALL_DIR%\com.local.chatgpt_folder_bridge.json"
set "TEST_OUT=%TEMP%\bridge-native-test.bin"
set "TEST_ERR=%TEMP%\bridge-native-test.err"

echo ChatGPT Folder Bridge helper check
echo.

if not exist "%HOST_BAT%" (
  echo ERROR: Installed launcher not found:
  echo   "%HOST_BAT%"
  exit /b 1
)

if not exist "%HOST_MANIFEST%" (
  echo ERROR: Native host manifest not found:
  echo   "%HOST_MANIFEST%"
  exit /b 2
)

echo Launcher:
type "%HOST_BAT%"
echo.
echo Manifest:
type "%HOST_MANIFEST%"
echo.

del /q "%TEST_OUT%" "%TEST_ERR%" >nul 2>&1
call "%HOST_BAT%" <nul >"%TEST_OUT%" 2>"%TEST_ERR%"
set "RESULT=%ERRORLEVEL%"

for %%I in ("%TEST_OUT%") do set "OUTPUT_BYTES=%%~zI"
if not defined OUTPUT_BYTES set "OUTPUT_BYTES=0"

echo Test exit code: %RESULT%
echo Native output bytes: %OUTPUT_BYTES%

for %%I in ("%TEST_ERR%") do set "ERROR_BYTES=%%~zI"
if not defined ERROR_BYTES set "ERROR_BYTES=0"

if not "%ERROR_BYTES%"=="0" (
  echo.
  echo Error output:
  type "%TEST_ERR%"
)

echo.
if "%RESULT%"=="0" if not "%OUTPUT_BYTES%"=="0" (
  echo Helper startup test passed.
  exit /b 0
)

echo Helper startup test failed.
exit /b %RESULT%
