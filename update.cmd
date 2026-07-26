@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem ChatGPT Folder Bridge - Windows updater launcher
rem With no argument, the PowerShell updater locates the currently loaded
rem unpacked extension from Chrome profile data and the native-host extension ID.
rem An explicit extension folder can still be supplied as the first argument.
rem The PowerShell execution-policy bypass applies only to this process.

set "SCRIPT_DIR=%~dp0"
set "UPDATE_SCRIPT=%SCRIPT_DIR%update_windows.ps1"
set "TARGET_EXTENSION=%~1"
set "PAUSE_AT_END=0"
set "POWERSHELL_EXE="

if not exist "%UPDATE_SCRIPT%" (
  echo ERROR: Update script not found:
  echo   "%UPDATE_SCRIPT%"
  echo.
  echo Keep update.cmd beside update_windows.ps1 in the package root.
  exit /b 1
)

if not defined TARGET_EXTENSION set "PAUSE_AT_END=1"

if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)

if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)

for /f "delims=" %%P in ('where powershell.exe 2^>nul') do (
  if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
)
if defined POWERSHELL_EXE goto :powershell_found

for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do (
  if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
)
if defined POWERSHELL_EXE goto :powershell_found

if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" (
  set "POWERSHELL_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
  goto :powershell_found
)
if exist "%ProgramFiles(x86)%\PowerShell\7\pwsh.exe" (
  set "POWERSHELL_EXE=%ProgramFiles(x86)%\PowerShell\7\pwsh.exe"
  goto :powershell_found
)

echo.
echo ERROR: PowerShell could not be located automatically.
echo.
if defined TARGET_EXTENSION (
  echo Run manually with:
  echo   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_SCRIPT%" -ExtensionDirectory "%TARGET_EXTENSION%"
) else (
  echo Run manually with:
  echo   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_SCRIPT%"
)
if "%PAUSE_AT_END%"=="1" pause
exit /b 3

:powershell_found
echo ChatGPT Folder Bridge updater
echo.
echo Using PowerShell:
echo   "%POWERSHELL_EXE%"
echo.

if defined TARGET_EXTENSION (
  echo Updating explicitly selected extension folder:
  echo   "%TARGET_EXTENSION%"
  echo.
  "%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_SCRIPT%" -ExtensionDirectory "%TARGET_EXTENSION%"
) else (
  echo Locating the extension folder automatically from Chrome profile data...
  echo.
  "%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%UPDATE_SCRIPT%"
)
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo ERROR: Update failed with exit code %RESULT%.
  echo Read the message above for the detected extension ID and candidate paths.
  if "%PAUSE_AT_END%"=="1" pause
  exit /b %RESULT%
)

echo.
echo Update completed successfully.
if "%PAUSE_AT_END%"=="1" pause
exit /b 0
