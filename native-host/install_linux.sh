#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.local.chatgpt_folder_bridge"
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 CHROME_EXTENSION_ID" >&2
  exit 2
fi
EXTENSION_ID="$1"
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "The Chrome extension ID should be 32 letters from a-p." >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/chatgpt-folder-bridge"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/folder_bridge_host.py" "$INSTALL_DIR/folder_bridge_host.py"
chmod 700 "$INSTALL_DIR/folder_bridge_host.py"

PYTHON_BIN="$(command -v python3)"
LAUNCHER="$INSTALL_DIR/host.sh"
cat > "$LAUNCHER" <<LAUNCHER_EOF
#!/usr/bin/env bash
exec "$PYTHON_BIN" "$INSTALL_DIR/folder_bridge_host.py" "\$@"
LAUNCHER_EOF
chmod 700 "$LAUNCHER"

MANIFEST=$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Local folder watcher for ChatGPT Folder Bridge",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
)

for DIR in \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/google-chrome-beta/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts"; do
  mkdir -p "$DIR"
  printf '%s\n' "$MANIFEST" > "$DIR/$HOST_NAME.json"
done

echo "Installed $HOST_NAME for extension $EXTENSION_ID"
echo "Restart Chrome, then use the extension's Reconnect helper button."
