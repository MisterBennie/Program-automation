@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem ChatGPT Folder Bridge - Windows installer launcher
rem This wrapper uses a process-only PowerShell execution-policy bypass.
rem It does not change the machine or user execution policy.

set "SCRIPT_DIR=%~dp0"
set "INSTALL_SCRIPT=%SCRIPT_DIR%install_windows.ps1"
set "EXTENSION_ID=%~1"
set "PAUSE_AT_END=0"
set "POWERSHELL_EXE="

if not exist "%INSTALL_SCRIPT%" (
  echo ERROR: Installer script not found:
  echo   "%INSTALL_SCRIPT%"
  echo.
  echo Keep install.cmd in the same folder as install_windows.ps1.
  exit /b 1
)

if not defined EXTENSION_ID (
  set "PAUSE_AT_END=1"
  echo ChatGPT Folder Bridge installer
  echo.
  echo Find the extension ID at chrome://extensions after loading the
  echo extension folder with Developer mode enabled.
  echo.
  set /p "EXTENSION_ID=Enter the 32-character Chrome extension ID: "
)

if not defined EXTENSION_ID (
  echo.
  echo ERROR: No extension ID was supplied.
  if "%PAUSE_AT_END%"=="1" pause
  exit /b 2
)

rem Prefer the standard inbox Windows PowerShell executable.
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)

rem A 32-bit cmd process can use Sysnative to reach 64-bit System32.
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" (
  set "POWERSHELL_EXE=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  goto :powershell_found
)

rem Fall back to executables available on PATH.
for /f "delims=" %%P in ('where powershell.exe 2^>nul') do (
  if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
)
if defined POWERSHELL_EXE goto :powershell_found

for /f "delims=" %%P in ('where pwsh.exe 2^>nul') do (
  if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
)
if defined POWERSHELL_EXE goto :powershell_found

rem Last-resort common PowerShell 7 installation paths.
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
echo Checked Windows PowerShell in System32 and Sysnative, then searched
echo PATH for powershell.exe and pwsh.exe.
echo.
echo You can run the installer manually with:
echo   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_SCRIPT%" -ExtensionId %EXTENSION_ID%
if "%PAUSE_AT_END%"=="1" pause
exit /b 3

:powershell_found
echo.
echo Using PowerShell:
echo   "%POWERSHELL_EXE%"
echo.
echo Installing the native helper for extension %EXTENSION_ID%...
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%INSTALL_SCRIPT%" -ExtensionId "%EXTENSION_ID%"
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo ERROR: Installation failed with exit code %RESULT%.
  echo Review the error above. If execution is blocked by organization policy,
  echo contact your administrator because a process-level bypass cannot override it.
  if "%PAUSE_AT_END%"=="1" pause
  exit /b %RESULT%
)

echo.
echo Installation completed successfully.
echo Restart Chrome, then click Reconnect helper in the extension.
if "%PAUSE_AT_END%"=="1" pause
exit /b 0
