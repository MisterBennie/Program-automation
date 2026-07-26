#!/usr/bin/env bash
set -euo pipefail
HOST_NAME="com.local.chatgpt_folder_bridge"
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts/$HOST_NAME.json"
rm -f "$HOME/Library/Application Support/Chromium/NativeMessagingHosts/$HOST_NAME.json"
rm -rf "$HOME/Library/Application Support/ChatGPTFolderBridge"
echo "Uninstalled $HOST_NAME"
