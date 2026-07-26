$ErrorActionPreference = 'Stop'
$HostName = 'com.local.chatgpt_folder_bridge'
$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
Remove-Item -Path $RegPath -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path (Join-Path $env:LOCALAPPDATA 'ChatGPTFolderBridge') -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Uninstalled $HostName"
