#!/usr/bin/env python3
"""Native Messaging host for ChatGPT Folder Bridge.

Uses only the Python standard library. It polls every enabled project folder,
announces stable matching files, and streams requested files to Chrome in
sub-1MB messages.
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import re
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO

HOST_NAME = "com.local.chatgpt_folder_bridge"
CHUNK_BYTES = 512 * 1024
STATE_LIMIT = 2000
DEFAULT_UPLOAD_PATTERN = r".*\.(pdf|docx|xlsx|xls|csv|tsv|txt|md|pptx|png|jpe?g)$"


@dataclass(frozen=True)
class FileRecord:
    file_id: str
    path: Path
    name: str
    size: int
    modified_ns: int
    mime: str
    profile_id: str
    profile_name: str


class NativeProtocol:
    def __init__(self) -> None:
        self._write_lock = threading.Lock()
        if os.name == "nt":
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    @property
    def input(self) -> BinaryIO:
        return sys.stdin.buffer

    @property
    def output(self) -> BinaryIO:
        return sys.stdout.buffer

    def send(self, message: dict[str, Any]) -> None:
        payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(payload) > 1024 * 1024:
            raise ValueError(f"Native message is too large: {len(payload)} bytes")
        with self._write_lock:
            self.output.write(struct.pack("=I", len(payload)))
            self.output.write(payload)
            self.output.flush()

    def receive(self) -> dict[str, Any] | None:
        raw_length = self.input.read(4)
        if not raw_length:
            return None
        if len(raw_length) != 4:
            raise EOFError("Truncated native message length")
        length = struct.unpack("=I", raw_length)[0]
        if length > 64 * 1024 * 1024:
            raise ValueError(f"Incoming native message is too large: {length} bytes")
        payload = self.input.read(length)
        if len(payload) != length:
            raise EOFError("Truncated native message body")
        value = json.loads(payload.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Native messages must be JSON objects")
        return value


class FolderBridgeHost:
    def __init__(self, protocol: NativeProtocol) -> None:
        self.protocol = protocol
        self.stop_event = threading.Event()
        self.config_lock = threading.RLock()
        self.enabled = False
        self.configs: list[dict[str, Any]] = []
        self.patterns: dict[str, re.Pattern[str]] = {}
        self.observed: dict[tuple[str, Path], tuple[int, int, float]] = {}
        self.records: dict[str, FileRecord] = {}
        self.announced: dict[str, float] = {}
        self.in_flight: set[str] = set()
        self.baselined_keys: set[str] = set()
        self.baseline_ignored: dict[str, set[str]] = {}
        self.last_folder_errors: dict[str, str] = {}
        self.state_path = self._state_path()
        self.processed_order: list[str] = []
        self.processed: set[str] = set()
        self._load_state()
        self.watcher = threading.Thread(target=self._watch_loop, name="folder-watcher", daemon=True)

    @staticmethod
    def _state_path() -> Path:
        if os.name == "nt":
            root = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ChatGPTFolderBridge"
        elif sys.platform == "darwin":
            root = Path.home() / "Library" / "Application Support" / "ChatGPTFolderBridge"
        else:
            root = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local" / "state")) / "chatgpt-folder-bridge"
        root.mkdir(parents=True, exist_ok=True)
        return root / "state.json"

    def _load_state(self) -> None:
        try:
            data = json.loads(self.state_path.read_text("utf-8"))
            values = data.get("processed", [])
            if isinstance(values, list):
                self.processed_order = [str(value) for value in values[-STATE_LIMIT:]]
                self.processed = set(self.processed_order)
        except FileNotFoundError:
            return
        except Exception as exc:
            self.protocol.send({"type": "status", "message": "Could not read native host state", "error": str(exc)})

    def _save_state(self) -> None:
        temp = self.state_path.with_suffix(".tmp")
        temp.write_text(json.dumps({"processed": self.processed_order[-STATE_LIMIT:]}, indent=2), "utf-8")
        temp.replace(self.state_path)

    def _mark_processed(self, file_id: str) -> None:
        if file_id not in self.processed:
            self.processed.add(file_id)
            self.processed_order.append(file_id)
            if len(self.processed_order) > STATE_LIMIT:
                removed = self.processed_order[:-STATE_LIMIT]
                self.processed_order = self.processed_order[-STATE_LIMIT:]
                self.processed.difference_update(removed)
            try:
                self._save_state()
            except Exception as exc:
                self.protocol.send({"type": "status", "message": "Could not save native host state", "error": str(exc)})

    @staticmethod
    def _fingerprint(path: Path, stat: os.stat_result) -> str:
        value = f"{path.resolve()}\0{stat.st_size}\0{stat.st_mtime_ns}".encode("utf-8", "surrogatepass")
        return hashlib.sha256(value).hexdigest()

    @staticmethod
    def _normalize_profile(raw: dict[str, Any], index: int) -> tuple[dict[str, Any], re.Pattern[str]]:
        profile_id = str(raw.get("profileId", "")).strip() or f"profile-{index + 1}"
        profile_name = str(raw.get("profileName", "")).strip() or profile_id
        folder = str(raw.get("watchFolder", "")).strip()
        pattern_text = str(raw.get("uploadPattern", DEFAULT_UPLOAD_PATTERN))
        pattern = re.compile(pattern_text, re.IGNORECASE)
        config = {
            "profileId": profile_id,
            "profileName": profile_name,
            "watchFolder": folder,
            "uploadPattern": pattern_text,
            "recursive": bool(raw.get("recursive", False)),
            "includeExisting": bool(raw.get("includeExisting", False)),
            "stableSeconds": max(1.0, float(raw.get("stableSeconds", 2.0))),
            "retrySeconds": max(5.0, float(raw.get("retrySeconds", 20.0))),
            "maxFileBytes": max(1, int(raw.get("maxFileBytes", 50 * 1024 * 1024))),
        }
        return config, pattern

    def configure(self, incoming: dict[str, Any]) -> None:
        raw_profiles = incoming.get("profiles")
        if not isinstance(raw_profiles, list):
            # Backward-compatible single-profile configuration.
            raw_profiles = [incoming] if str(incoming.get("watchFolder", "")).strip() else []

        normalized: list[dict[str, Any]] = []
        patterns: dict[str, re.Pattern[str]] = {}
        for index, raw in enumerate(raw_profiles):
            if not isinstance(raw, dict):
                continue
            config, pattern = self._normalize_profile(raw, index)
            if not config["watchFolder"]:
                continue
            normalized.append(config)
            patterns[config["profileId"]] = pattern

        with self.config_lock:
            self.enabled = bool(incoming.get("enabled", False)) and bool(normalized)
            self.configs = normalized
            self.patterns = patterns

            active_profile_ids = {config["profileId"] for config in normalized}
            for observed_key in list(self.observed):
                if observed_key[0] not in active_profile_ids:
                    self.observed.pop(observed_key, None)

            for config in normalized:
                folder_text = config["watchFolder"]
                try:
                    resolved_folder = str(Path(folder_text).expanduser().resolve())
                except OSError:
                    resolved_folder = folder_text
                baseline_key = f"{config['profileId']}\0{resolved_folder}"
                if config["includeExisting"]:
                    self.baselined_keys.discard(baseline_key)
                    self.baseline_ignored.pop(baseline_key, None)

        if not self.enabled:
            message = "Folder watchers disabled"
        elif len(normalized) == 1:
            message = f"Watching 1 project folder for {normalized[0]['profileName']}"
        else:
            message = f"Watching {len(normalized)} project folders"
        self.protocol.send({"type": "status", "message": message})

    @staticmethod
    def _iter_files(folder: Path, recursive: bool):
        iterator = folder.rglob("*") if recursive else folder.glob("*")
        for path in iterator:
            try:
                if path.is_file():
                    yield path
            except OSError:
                continue

    def _snapshot_matching(
        self,
        config: dict[str, Any],
        pattern: re.Pattern[str],
        folder: Path,
    ) -> list[FileRecord]:
        records: list[FileRecord] = []
        for path in self._iter_files(folder, bool(config["recursive"])):
            if not pattern.search(path.name):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size <= 0 or stat.st_size > int(config["maxFileBytes"]):
                continue
            file_id = self._fingerprint(path, stat)
            records.append(FileRecord(
                file_id=file_id,
                path=path,
                name=path.name,
                size=stat.st_size,
                modified_ns=stat.st_mtime_ns,
                mime=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                profile_id=str(config["profileId"]),
                profile_name=str(config["profileName"]),
            ))
        return records

    def _watch_loop(self) -> None:
        while not self.stop_event.wait(1.0):
            try:
                self._scan_once()
            except Exception as exc:
                self.protocol.send({"type": "status", "message": "Folder scan failed", "error": str(exc)})
                time.sleep(2.0)

    def _scan_once(self) -> None:
        with self.config_lock:
            enabled = self.enabled
            configs = [dict(config) for config in self.configs]
            patterns = dict(self.patterns)

        if not enabled:
            return

        now = time.monotonic()
        for config in configs:
            profile_id = str(config["profileId"])
            pattern = patterns.get(profile_id)
            if pattern is None:
                continue
            try:
                self._scan_profile(config, pattern, now)
                self.last_folder_errors.pop(profile_id, None)
            except Exception as exc:
                error = str(exc)
                if self.last_folder_errors.get(profile_id) != error:
                    self.last_folder_errors[profile_id] = error
                    self.protocol.send({
                        "type": "status",
                        "message": f"Folder scan failed for {config['profileName']}",
                        "error": error,
                    })

    def _scan_profile(self, config: dict[str, Any], pattern: re.Pattern[str], now: float) -> None:
        folder = Path(str(config["watchFolder"])).expanduser()
        if not folder.is_dir():
            raise FileNotFoundError(f"Watch folder does not exist: {folder}")

        records = self._snapshot_matching(config, pattern, folder)
        resolved_folder = str(folder.resolve())
        baseline_key = f"{config['profileId']}\0{resolved_folder}"
        if baseline_key not in self.baselined_keys and not bool(config["includeExisting"]):
            self.baselined_keys.add(baseline_key)
            self.baseline_ignored[baseline_key] = {record.file_id for record in records}
            self.protocol.send({
                "type": "status",
                "message": f"Watching {folder} for {config['profileName']}; existing files were skipped",
            })
            return
        self.baselined_keys.add(baseline_key)
        ignored_file_ids = self.baseline_ignored.get(baseline_key, set())

        current_paths = {record.path for record in records}
        for observed_key in list(self.observed):
            if observed_key[0] == config["profileId"] and observed_key[1] not in current_paths:
                self.observed.pop(observed_key, None)

        for record in records:
            observed_key = (record.profile_id, record.path)
            previous = self.observed.get(observed_key)
            if previous and previous[0] == record.size and previous[1] == record.modified_ns:
                stable_since = previous[2]
            else:
                stable_since = now
                self.observed[observed_key] = (record.size, record.modified_ns, stable_since)
                continue

            if now - stable_since < float(config["stableSeconds"]):
                continue
            if record.file_id in ignored_file_ids:
                continue
            if record.file_id in self.processed or record.file_id in self.in_flight:
                continue
            announced_at = self.announced.get(record.file_id)
            if announced_at is not None and now - announced_at < float(config["retrySeconds"]):
                continue

            self.records[record.file_id] = record
            self.announced[record.file_id] = now
            self.protocol.send({
                "type": "file_available",
                "fileId": record.file_id,
                "name": record.name,
                "size": record.size,
                "mime": record.mime,
                "modifiedMs": record.modified_ns // 1_000_000,
                "profileId": record.profile_id,
                "profileName": record.profile_name,
            })

    def stream_file(self, file_id: str) -> None:
        record = self.records.get(file_id)
        if not record:
            self.protocol.send({"type": "file_error", "fileId": file_id, "error": "Unknown or expired file ID"})
            return
        if file_id in self.in_flight:
            return
        self.in_flight.add(file_id)

        def worker() -> None:
            try:
                stat = record.path.stat()
                current_id = self._fingerprint(record.path, stat)
                if current_id != file_id:
                    raise RuntimeError("The file changed before it could be uploaded")
                self.protocol.send({
                    "type": "file_start",
                    "fileId": file_id,
                    "name": record.name,
                    "size": record.size,
                    "mime": record.mime,
                    "modifiedMs": record.modified_ns // 1_000_000,
                    "profileId": record.profile_id,
                    "profileName": record.profile_name,
                })
                index = 0
                with record.path.open("rb") as handle:
                    while True:
                        chunk = handle.read(CHUNK_BYTES)
                        if not chunk:
                            break
                        self.protocol.send({
                            "type": "file_chunk",
                            "fileId": file_id,
                            "index": index,
                            "data": base64.b64encode(chunk).decode("ascii"),
                        })
                        index += 1
                self.protocol.send({"type": "file_end", "fileId": file_id, "chunks": index})
            except Exception as exc:
                self.protocol.send({"type": "file_error", "fileId": file_id, "error": str(exc)})
                self.in_flight.discard(file_id)

        threading.Thread(target=worker, name=f"file-stream-{file_id[:8]}", daemon=True).start()

    def transfer_result(self, file_id: str, ok: bool, reason: str | None) -> None:
        self.in_flight.discard(file_id)
        if ok:
            self._mark_processed(file_id)
            self.records.pop(file_id, None)
            self.announced.pop(file_id, None)
            self.protocol.send({"type": "status", "message": "Upload acknowledged by Chrome"})
        else:
            self.announced[file_id] = time.monotonic()
            self.protocol.send({"type": "status", "message": "Upload will be retried", "error": reason or "Unknown browser error"})

    def run(self) -> None:
        self.watcher.start()
        self.protocol.send({"type": "status", "message": "Native host started"})
        while not self.stop_event.is_set():
            message = self.protocol.receive()
            if message is None:
                break
            kind = message.get("type")
            try:
                if kind == "configure":
                    config = message.get("config")
                    if not isinstance(config, dict):
                        raise ValueError("configure.config must be an object")
                    self.configure(config)
                elif kind == "send_file":
                    self.stream_file(str(message.get("fileId", "")))
                elif kind == "transfer_result":
                    self.transfer_result(
                        str(message.get("fileId", "")),
                        bool(message.get("ok")),
                        str(message.get("reason")) if message.get("reason") is not None else None,
                    )
                elif kind == "ping":
                    self.protocol.send({"type": "status", "message": "pong"})
                else:
                    self.protocol.send({"type": "status", "message": "Unknown command", "error": str(kind)})
            except Exception as exc:
                self.protocol.send({"type": "status", "message": f"Command failed: {kind}", "error": str(exc)})
        self.stop_event.set()


def main() -> int:
    protocol = NativeProtocol()
    host = FolderBridgeHost(protocol)
    try:
        host.run()
        return 0
    except (EOFError, BrokenPipeError):
        return 0
    except Exception as exc:
        try:
            protocol.send({"type": "status", "message": "Native host crashed", "error": str(exc)})
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
