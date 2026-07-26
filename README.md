# ChatGPT Folder Bridge

A local Chrome Manifest V3 extension plus a Python native-messaging helper.

It can:

- maintain separate automation profiles for ChatGPT projects such as **Stream** and **Stocks**;
- keep independent watched folders, upload expressions, prompts, submit actions, download expressions, and download folders for each project;
- watch every enabled project folder concurrently for new or changed matching files;
- route an upload only to a ChatGPT tab whose project matches the file's profile;
- detect newly presented assistant download controls using the active project's download expression;
- save matched downloads under the profile's configurable subfolder of Chrome's normal Downloads folder.

## Download matching

Automatic download detection is intentionally simple:

- only `<button>` elements in assistant messages are considered;
- the regular expression is tested only against the button's complete visible text;
- after a page load or refresh, the bridge waits at least thirty seconds;
- during that period it snapshots the complete ordered set of matching buttons once per second;
- the set must remain unchanged for fifteen continuous seconds before a download is selected;
- if ChatGPT is still hydrating the conversation, the bridge keeps waiting for up to three minutes;
- all matching buttons are then evaluated once in page order and only the **last matching button** can be activated;
- the extension establishes that button as a page boundary, so older controls lazily rendered above it are ignored;
- observer scans are suppressed while the selected control is scrolled to and clicked, preventing a single click from cascading through other buttons;
- **Scan result links** is a manual override and also activates only the last current matching button.

For a button labelled:

```text
Download Stream-2026-07-25-015.zip
```

use:

```regex
^Download\s+Stream-\d{4}-\d{2}-\d{2}-\d{3}\.zip$
```

## Important safety behavior

- The bridge is **disabled by default**.
- Use a dedicated inbox folder containing only files you intend to send to ChatGPT.
- Existing files are skipped by default on the first scan.
- The native helper never exposes a network server. It communicates only through Chrome Native Messaging.
- The helper stores only file fingerprints in a local state file to prevent duplicate uploads.

## Install

### 1. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Choose the `extension` directory from this repository.
5. Copy the 32-character extension ID shown by Chrome.

### 2. Register the native helper

Python 3 is required.

**Linux**

```bash
cd native-host
./install_linux.sh YOUR_EXTENSION_ID
```

**macOS**

```bash
cd native-host
./install_macos.sh YOUR_EXTENSION_ID
```

**Windows**

Double-click `native-host\install.cmd` and enter the extension ID when prompted, or run:

```bat
cd native-host
install.cmd YOUR_EXTENSION_ID
```

The launcher locates Windows PowerShell or PowerShell 7 and applies an execution-policy bypass only to the installer process. It does not modify the machine or user execution policy. The installer validates the Python runtime instead of trusting `where python`; it ignores the Microsoft Store `WindowsApps` alias and can use a normal Python 3 installation or LibreOffice's bundled Python.

Restart Chrome after installing the helper. To verify the installed helper from Command Prompt, run `native-host\check_helper.cmd`. To remove it later without directly launching PowerShell, run `native-host\uninstall.cmd`.

## Updating an existing Windows installation

Extract the new package and double-click the package-root `update.cmd`, or run it without arguments:

```bat
update.cmd
```

The updater reads the extension ID from the installed native-host manifest and searches Chrome profile data for the unpacked extension directory that is already loaded. This keeps the existing Chrome extension ID. `install.cmd` installs only the native helper under `%LOCALAPPDATA%\ChatGPTFolderBridge`; it does not install or relocate the unpacked extension.

If automatic detection finds more than one Chrome profile or cannot recover the path, supply the existing extension directory explicitly:

```bat
update.cmd "C:\Users\Ben\Downloads\chatgpt-folder-bridge\extension"
```

The target is the old `extension` directory containing `manifest.json`, `content-script.js`, and `service-worker.js`. It is the directory originally selected using **Load unpacked**, not the newly extracted package root.

The updater:

- creates a timestamped backup beside the existing extension directory;
- replaces the extension files while keeping the same absolute directory, which preserves the unpacked extension ID;
- updates `%LOCALAPPDATA%\ChatGPTFolderBridge\folder_bridge_host.py` when the native helper is already installed;
- preserves Chrome extension settings and `%LOCALAPPDATA%\ChatGPTFolderBridge\state.json`;
- restores the backup automatically if the extension-file replacement fails.

After the update, open `chrome://extensions`, click **Reload**, reload any open ChatGPT tabs, and click **Reconnect helper**.

### 3. Configure project profiles

1. Open the ChatGPT project you want to automate, for example **Stream**.
2. Open the extension's **Settings** page.
3. Click **Add current project**. The extension captures the stable project ID from a link such as `/g/g-p-...-stream/project` and stores `Stream` as the display name.
4. Set that project's watch folder, upload expression, prompt/submission action, download expression, and download subfolder.
5. Repeat for another project such as **Stocks**.
6. Remove or disable the migrated **Default (all projects)** profile when every project has its own exact profile.
7. Save, reload open ChatGPT tabs after an extension update, and enable the bridge from its toolbar popup.

## Architecture

- `extension/service-worker.js`: native host connection, upload queue, Chrome downloads API, settings.
- `extension/content-script.js`: ChatGPT page integration, file reconstruction, attachment/submission, result-button detection.
- `native-host/folder_bridge_host.py`: folder polling, stable-file detection, chunked file transfer.

The helper uses 512 KiB binary chunks encoded as base64, keeping each native-host-to-Chrome message below Chrome's 1 MiB limit.

## Current version

The source currently corresponds to **v0.4.0**.

Highlights:

- Per-project Stream/Stocks-style profiles.
- Concurrent watchers for all enabled upload profiles.
- Project-aware upload routing and download matching.
- Optional last-matching download after page reload.
- Content-script version reporting and stale-context recovery.
- Windows installer, updater, helper diagnostics, and LibreOffice Python fallback.

## Troubleshooting

**Helper disconnected**

- Verify the extension ID passed to the installer exactly matches `chrome://extensions`.
- Run `native-host\check_helper.cmd` from Command Prompt.
- Inspect `%LOCALAPPDATA%\ChatGPTFolderBridge\host.bat`; it must point to a real Python executable, not `Microsoft\WindowsApps\python.exe`.
- Restart Chrome, reload the extension, and click **Reconnect helper**.

**File queued but not uploaded**

- Open a conversation inside the ChatGPT project that matches the queued file's profile.
- Check the popup's **Project** and **Profile** values.
- Ensure the normal prompt box is visible and no modal dialog is open.

**Download not detected**

- Check the full visible button text against the project's download regular expression.
- Use **Scan result links** for a manual scan.
- Close DevTools for the ChatGPT tab; Chrome permits only one debugger attachment at a time.

## Limitations

This is browser UI automation, not an official ChatGPT automation API. It may require maintenance when the ChatGPT web interface changes. Chrome may still show security or dangerous-download prompts; the extension intentionally does not bypass them.
