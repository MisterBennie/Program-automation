param(
  [Parameter(Mandatory = $false)]
  [string]$ExtensionDirectory
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceExtension = Join-Path $PackageRoot 'extension'
$SourceHost = Join-Path $PackageRoot 'native-host\folder_bridge_host.py'
$InstallDir = Join-Path $env:LOCALAPPDATA 'ChatGPTFolderBridge'
$InstalledHost = Join-Path $InstallDir 'folder_bridge_host.py'
$InstalledLauncher = Join-Path $InstallDir 'host.bat'
$DefaultInstalledManifest = Join-Path $InstallDir 'com.local.chatgpt_folder_bridge.json'
$NativeHostName = 'com.local.chatgpt_folder_bridge'

function Resolve-ExistingDirectory {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw 'No extension directory was supplied.'
  }

  $Expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
  $FullPath = [System.IO.Path]::GetFullPath($Expanded)

  if (-not (Test-Path -LiteralPath $FullPath -PathType Container)) {
    throw "Extension directory does not exist: $FullPath"
  }

  return $FullPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
}

function Copy-DirectoryContents {
  param(
    [string]$Source,
    [string]$Destination
  )

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

function Get-NativeHostManifestPath {
  $RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$NativeHostName"
  if (Test-Path -LiteralPath $RegistryPath) {
    try {
      $Key = Get-Item -LiteralPath $RegistryPath
      $RegisteredPath = [string]$Key.GetValue('')
      if (-not [string]::IsNullOrWhiteSpace($RegisteredPath) -and
          (Test-Path -LiteralPath $RegisteredPath -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($RegisteredPath)
      }
    }
    catch {
      Write-Warning "Could not read the native-host registry entry: $($_.Exception.Message)"
    }
  }

  if (Test-Path -LiteralPath $DefaultInstalledManifest -PathType Leaf) {
    return $DefaultInstalledManifest
  }

  return $null
}

function Get-RegisteredExtensionId {
  $ManifestPath = Get-NativeHostManifestPath
  if (-not $ManifestPath) {
    throw @"
The installed native-host manifest could not be found.
Run native-host\install.cmd with the ID shown on chrome://extensions, then run
update.cmd again. install.cmd installs only the native helper; Chrome keeps the
unpacked extension in whichever folder was originally selected with Load unpacked.
"@
  }

  try {
    $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  }
  catch {
    throw "Could not parse native-host manifest '$ManifestPath': $($_.Exception.Message)"
  }

  foreach ($Origin in @($Manifest.allowed_origins)) {
    $OriginText = [string]$Origin
    if ($OriginText -match '^chrome-extension://([a-p]{32})/?$') {
      return $Matches[1]
    }
  }

  throw "No valid Chrome extension ID was found in: $ManifestPath"
}

function Add-CandidatePath {
  param(
    [System.Collections.Generic.HashSet[string]]$Set,
    [string]$Path,
    [string]$PreferenceFile
  )

  if ([string]::IsNullOrWhiteSpace($Path)) { return }

  $Expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
  $PossiblePaths = New-Object System.Collections.Generic.List[string]

  if ([System.IO.Path]::IsPathRooted($Expanded)) {
    [void]$PossiblePaths.Add($Expanded)
  }
  else {
    $ProfileDirectory = Split-Path -Parent $PreferenceFile
    $UserDataDirectory = Split-Path -Parent $ProfileDirectory
    [void]$PossiblePaths.Add((Join-Path $ProfileDirectory $Expanded))
    [void]$PossiblePaths.Add((Join-Path $UserDataDirectory $Expanded))
  }

  foreach ($Possible in $PossiblePaths) {
    try {
      $Full = [System.IO.Path]::GetFullPath($Possible).TrimEnd('\')
      if (Test-Path -LiteralPath (Join-Path $Full 'manifest.json') -PathType Leaf) {
        [void]$Set.Add($Full)
      }
    }
    catch {
      # Ignore malformed or inaccessible profile paths and continue scanning.
    }
  }
}

function Find-LoadedExtensionDirectories {
  param(
    [string]$ExtensionId,
    [string]$ExpectedName
  )

  $Candidates = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $UserDataRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome Dev\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Chromium\User Data'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data')
  ) | Select-Object -Unique

  foreach ($Root in $UserDataRoots) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { continue }

    $PreferenceFiles = Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        @(
          (Join-Path $_.FullName 'Preferences'),
          (Join-Path $_.FullName 'Secure Preferences')
        )
      } |
      Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }

    foreach ($PreferenceFile in $PreferenceFiles) {
      try {
        $Preferences = Get-Content -LiteralPath $PreferenceFile -Raw | ConvertFrom-Json
        if (-not $Preferences.extensions -or -not $Preferences.extensions.settings) { continue }

        $Property = $Preferences.extensions.settings.PSObject.Properties[$ExtensionId]
        if (-not $Property) { continue }

        $Entry = $Property.Value
        if ($Entry.path) {
          Add-CandidatePath -Set $Candidates -Path ([string]$Entry.path) -PreferenceFile $PreferenceFile
        }
      }
      catch {
        Write-Verbose "Could not inspect '$PreferenceFile': $($_.Exception.Message)"
      }
    }
  }

  $Validated = New-Object System.Collections.Generic.List[string]
  foreach ($Candidate in $Candidates) {
    try {
      $Manifest = Get-Content -LiteralPath (Join-Path $Candidate 'manifest.json') -Raw | ConvertFrom-Json
      if ([string]$Manifest.name -eq $ExpectedName) {
        [void]$Validated.Add($Candidate)
      }
    }
    catch {
      # Ignore unrelated or malformed extension directories.
    }
  }

  return @($Validated | Sort-Object -Unique)
}

function Resolve-TargetExtensionDirectory {
  param(
    [string]$ExplicitDirectory,
    [string]$ExpectedName
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitDirectory)) {
    return Resolve-ExistingDirectory $ExplicitDirectory
  }

  $ExtensionId = Get-RegisteredExtensionId
  Write-Host "Registered extension ID: $ExtensionId"

  $Found = @(Find-LoadedExtensionDirectories -ExtensionId $ExtensionId -ExpectedName $ExpectedName)
  if ($Found.Count -eq 1) {
    Write-Host "Automatically located loaded extension: $($Found[0])"
    return $Found[0]
  }

  if ($Found.Count -gt 1) {
    $List = ($Found | ForEach-Object { "  $_" }) -join [Environment]::NewLine
    throw @"
More than one loaded directory was found for extension ID ${ExtensionId}:
$List

Run update.cmd with the exact directory you want to update, for example:
  update.cmd "C:\Users\Ben\Downloads\chatgpt-folder-bridge\extension"
"@
  }

  throw @"
Chrome profile data did not expose the unpacked directory for extension ID:
  $ExtensionId

The extension folder is the directory you originally selected with Load unpacked;
it contains manifest.json, content-script.js, and service-worker.js. To locate it:
  1. Open chrome://extensions and enable Developer mode.
  2. Find ChatGPT Folder Bridge and note the ID above.
  3. Search the folder where you extracted the original ZIP for manifest.json.
  4. Run update.cmd with that extension directory.

Example:
  update.cmd "C:\Users\Ben\Downloads\chatgpt-folder-bridge\extension"
"@
}

if (-not (Test-Path -LiteralPath (Join-Path $SourceExtension 'manifest.json') -PathType Leaf)) {
  throw "Package extension files are missing from: $SourceExtension"
}
if (-not (Test-Path -LiteralPath $SourceHost -PathType Leaf)) {
  throw "Package native helper is missing: $SourceHost"
}

$SourceManifestObject = Get-Content -LiteralPath (Join-Path $SourceExtension 'manifest.json') -Raw | ConvertFrom-Json
$TargetExtension = Resolve-TargetExtensionDirectory -ExplicitDirectory $ExtensionDirectory -ExpectedName ([string]$SourceManifestObject.name)
$TargetManifest = Join-Path $TargetExtension 'manifest.json'
if (-not (Test-Path -LiteralPath $TargetManifest -PathType Leaf)) {
  throw @"
The selected directory does not contain manifest.json:
  $TargetExtension

Select the exact extension directory currently loaded as an unpacked extension.
"@
}

$SourceFull = [System.IO.Path]::GetFullPath($SourceExtension).TrimEnd('\')
$TargetFull = [System.IO.Path]::GetFullPath($TargetExtension).TrimEnd('\')
$SameDirectory = [string]::Equals($SourceFull, $TargetFull, [System.StringComparison]::OrdinalIgnoreCase)
$TargetManifestObject = Get-Content -LiteralPath $TargetManifest -Raw | ConvertFrom-Json

if ($TargetManifestObject.name -ne $SourceManifestObject.name) {
  throw "The selected folder contains '$($TargetManifestObject.name)', not '$($SourceManifestObject.name)'."
}

$BackupDirectory = $null
$StageDirectory = $null

if (-not $SameDirectory) {
  $Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $ParentDirectory = Split-Path -Parent $TargetExtension
  $LeafName = Split-Path -Leaf $TargetExtension
  $BackupDirectory = Join-Path $ParentDirectory "$LeafName.backup-$Timestamp"
  $StageDirectory = Join-Path $ParentDirectory ".$LeafName.update-$([Guid]::NewGuid().ToString('N'))"

  Write-Host "Creating extension backup: $BackupDirectory"
  Copy-DirectoryContents -Source $TargetExtension -Destination $BackupDirectory

  try {
    Copy-DirectoryContents -Source $SourceExtension -Destination $StageDirectory

    # Keep the loaded directory at the same absolute path so Chrome retains the ID.
    Get-ChildItem -LiteralPath $TargetExtension -Force | Remove-Item -Recurse -Force
    Copy-DirectoryContents -Source $StageDirectory -Destination $TargetExtension
  }
  catch {
    Write-Warning 'Update failed. Attempting to restore the extension backup.'
    try {
      Get-ChildItem -LiteralPath $TargetExtension -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Copy-DirectoryContents -Source $BackupDirectory -Destination $TargetExtension
    }
    catch {
      Write-Warning "Automatic restore also failed. Restore manually from: $BackupDirectory"
    }
    throw
  }
  finally {
    if ($StageDirectory -and (Test-Path -LiteralPath $StageDirectory)) {
      Remove-Item -LiteralPath $StageDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
else {
  Write-Host 'The package extension directory is already the loaded target; no extension copy was needed.'
}

$VerifiedManifestObject = Get-Content -LiteralPath (Join-Path $TargetExtension 'manifest.json') -Raw | ConvertFrom-Json
if ([string]$VerifiedManifestObject.version -ne [string]$SourceManifestObject.version) {
  throw "Extension verification failed: target reports version $($VerifiedManifestObject.version), expected $($SourceManifestObject.version)."
}
$VerifiedContentScript = Get-Content -LiteralPath (Join-Path $TargetExtension 'content-script.js') -Raw
$ExpectedMarker = 'version: "' + [string]$SourceManifestObject.version + '"'
if ($VerifiedContentScript -notlike "*$ExpectedMarker*") {
  throw "Extension verification failed: content-script.js does not contain $ExpectedMarker"
}
Write-Host "Verified copied extension version: $($VerifiedManifestObject.version)"

$InstalledManifest = Get-NativeHostManifestPath
$NativeUpdated = $false
if ((Test-Path -LiteralPath $InstallDir -PathType Container) -and
    (Test-Path -LiteralPath $InstalledLauncher -PathType Leaf) -and
    $InstalledManifest) {
  Copy-Item -LiteralPath $SourceHost -Destination $InstalledHost -Force
  $NativeUpdated = $true
  Write-Host "Updated installed native helper: $InstalledHost"
}
else {
  Write-Warning @"
The native helper does not appear to be installed at:
  $InstallDir
Run native-host\install.cmd with the extension ID after this update.
"@
}

Write-Host ''
Write-Host "Updated ChatGPT Folder Bridge to version $($SourceManifestObject.version)."
Write-Host "Loaded extension directory: $TargetExtension"
if ($BackupDirectory) {
  Write-Host "Backup: $BackupDirectory"
}
if ($NativeUpdated) {
  Write-Host 'Native helper state.json and its processed-file history were preserved.'
}
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Open chrome://extensions.'
Write-Host '  2. Click Reload for ChatGPT Folder Bridge.'
Write-Host '  3. Open ChatGPT; version 0.4.0 reloads stale ChatGPT tabs automatically once.'
Write-Host '  4. Confirm the popup shows matching Extension and Page script versions.'
Write-Host '  5. Click Reconnect helper in the extension popup.'
