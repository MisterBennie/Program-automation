@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "UNINSTALL_SCRIPT=%SCRIPT_DIR%uninstall_windows.ps1"
set "POWERSHELL_EXE="

if not exist "%UNINSTALL_SCRIPT%" (
  echo ERROR: Uninstaller script not found:
  echo   "%UNINSTALL_SCRIPT%"
  exit /b 1
)

if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)
for /f "delims=" %%P in ('where powershell.exe 2^>nul') do if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
if defined POWERSHELL_EXE goto :powershell_found
for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
if defined POWERSHELL_EXE goto :powershell_found

echo ERROR: PowerShell could not be located automatically.
exit /b 2

:powershell_found
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%UNINSTALL_SCRIPT%"
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo ERROR: Uninstall failed with exit code %RESULT%.
  exit /b %RESULT%
)
echo Uninstall completed successfully.
pause
exit /b 0
