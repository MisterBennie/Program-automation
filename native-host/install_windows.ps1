param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.local.chatgpt_folder_bridge'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:LOCALAPPDATA 'ChatGPTFolderBridge'
$HostScript = Join-Path $InstallDir 'folder_bridge_host.py'
$Launcher = Join-Path $InstallDir 'host.bat'
$ManifestPath = Join-Path $InstallDir "$HostName.json"

function Add-Candidate {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Path
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { return }

  try {
    $Expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
    $FullPath = [System.IO.Path]::GetFullPath($Expanded)
  }
  catch {
    return
  }

  if ($FullPath -match '(?i)\\Microsoft\\WindowsApps\\python(?:3)?\.exe$') {
    return
  }

  if (-not $List.Contains($FullPath)) {
    [void]$List.Add($FullPath)
  }
}

function Test-PythonCandidate {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }

  $Probe = @'
import base64, hashlib, json, mimetypes, os, re, struct, sys, threading, time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
print(sys.executable)
'@

  try {
    $Output = & $Path -c $Probe 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    return -not [string]::IsNullOrWhiteSpace(($Output | Out-String))
  }
  catch {
    return $false
  }
}

function Find-UsablePython {
  $Candidates = [System.Collections.Generic.List[string]]::new()

  # Commands on PATH, excluding the Microsoft Store execution alias.
  foreach ($Name in @('python.exe', 'python3.exe')) {
    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($Command) { Add-Candidate $Candidates $Command.Source }
  }

  # Paths registered with the Python launcher. A stale launcher entry is ignored.
  $PyLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue
  if ($PyLauncher) {
    try {
      $LauncherLines = & $PyLauncher.Source -0p 2>$null
      foreach ($Line in $LauncherLines) {
        if ($Line -match '([A-Za-z]:\\.*?python(?:3)?\.exe)\s*$') {
          Add-Candidate $Candidates $Matches[1]
        }
      }
    }
    catch {
      # Continue with filesystem candidates.
    }
  }

  # Common standalone Python locations.
  $Patterns = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python*\python.exe'),
    (Join-Path $env:ProgramFiles 'Python*\python.exe')
  )
  if (${env:ProgramFiles(x86)}) {
    $Patterns += (Join-Path ${env:ProgramFiles(x86)} 'Python*\python.exe')
  }

  # LibreOffice includes a standard-library Python runtime that is sufficient
  # for this helper. Prefer its main launcher, then its versioned core runtime.
  $Patterns += (Join-Path $env:ProgramFiles 'LibreOffice\program\python.exe')
  $Patterns += (Join-Path $env:ProgramFiles 'LibreOffice\program\python-core-*\bin\python.exe')
  if (${env:ProgramFiles(x86)}) {
    $Patterns += (Join-Path ${env:ProgramFiles(x86)} 'LibreOffice\program\python.exe')
    $Patterns += (Join-Path ${env:ProgramFiles(x86)} 'LibreOffice\program\python-core-*\bin\python.exe')
  }

  foreach ($Pattern in $Patterns) {
    Get-ChildItem -Path $Pattern -File -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      ForEach-Object { Add-Candidate $Candidates $_.FullName }
  }

  foreach ($Candidate in $Candidates) {
    Write-Host "Checking Python candidate: $Candidate"
    if (Test-PythonCandidate $Candidate) {
      return $Candidate
    }
  }

  return $null
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $ScriptDir 'folder_bridge_host.py') $HostScript -Force

$Python = Find-UsablePython
if (-not $Python) {
  throw @'
No usable Python 3 interpreter was found.

The installer rejected Microsoft WindowsApps aliases because they only open the
Microsoft Store. Install Python 3 from python.org, or install LibreOffice, then
run install.cmd again.
'@
}

$EscapedPython = $Python.Replace('%', '%%')
$EscapedHostScript = $HostScript.Replace('%', '%%')
@"
@echo off
"$EscapedPython" "$EscapedHostScript" %*
"@ | Set-Content -Path $Launcher -Encoding Ascii

$Manifest = [ordered]@{
  name = $HostName
  description = 'Local folder watcher for ChatGPT Folder Bridge'
  path = $Launcher
  type = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$ManifestJson = $Manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, (New-Object System.Text.UTF8Encoding($false)))

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegPath -Force | Out-Null
Set-Item -Path $RegPath -Value $ManifestPath

Write-Host ''
Write-Host "Installed $HostName for extension $ExtensionId"
Write-Host "Python runtime: $Python"
Write-Host "Native host manifest: $ManifestPath"
Write-Host 'Restart Chrome, reload the extension, then click Reconnect helper.'
