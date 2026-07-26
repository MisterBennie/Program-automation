#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="com.local.chatgpt_folder_bridge"
rm -f "$HOME/.config/google-chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$HOME/.config/google-chrome-beta/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$HOME/.config/chromium/NativeMessagingHosts/$HOST_NAME.json"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt-folder-bridge"
echo "Uninstalled $HOST_NAME"
