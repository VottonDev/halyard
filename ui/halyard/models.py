"""Typed views over the JSON payloads defined in docs/dbus-api.md.

Every parser is tolerant: unknown fields are ignored and missing fields fall
back to sane defaults, so a daemon that grows new keys never breaks the UI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

# Pair.status values from the contract.
STATUS_SETUP = "setup"
STATUS_SCANNING = "scanning"
STATUS_SYNCING = "syncing"
STATUS_IDLE = "idle"
STATUS_WAITING = "waiting"
STATUS_PAUSED = "paused"
STATUS_ERROR = "error"

# Conflict.kind values from the contract.
KIND_BOTH_MODIFIED = "bothModified"
KIND_LOCAL_DELETED = "localDeletedRemoteModified"
KIND_REMOTE_DELETED = "remoteDeletedLocalModified"

# ResolveConflict resolutions.
RESOLVE_KEEP_LOCAL = "keepLocal"
RESOLVE_KEEP_REMOTE = "keepRemote"
RESOLVE_DISMISS = "dismiss"

# HistoryEntry.action values from the contract.
ACTION_DOWNLOADED = "downloaded"
ACTION_UPDATED_LOCAL = "updatedLocal"
ACTION_UPLOADED = "uploaded"
ACTION_UPDATED_REMOTE = "updatedRemote"
ACTION_DELETED_LOCAL = "deletedLocal"
ACTION_TRASHED_REMOTE = "trashedRemote"
ACTION_MOVED_LOCAL = "movedLocal"
ACTION_MOVED_REMOTE = "movedRemote"
ACTION_CREATED_LOCAL_FOLDER = "createdLocalFolder"
ACTION_CREATED_REMOTE_FOLDER = "createdRemoteFolder"

#: Groupings the activity filter offers, in the terms a user would ask in.
ACTIONS_REMOVED = (ACTION_DELETED_LOCAL, ACTION_TRASHED_REMOTE)
ACTIONS_ADDED = (
    ACTION_DOWNLOADED,
    ACTION_UPLOADED,
    ACTION_CREATED_LOCAL_FOLDER,
    ACTION_CREATED_REMOTE_FOLDER,
)
ACTIONS_UPDATED = (ACTION_UPDATED_LOCAL, ACTION_UPDATED_REMOTE)
ACTIONS_MOVED = (ACTION_MOVED_LOCAL, ACTION_MOVED_REMOTE)

OUTCOME_OK = "ok"
OUTCOME_FAILED = "failed"


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _as_int(value: Any, default: int = 0) -> int:
    return value if isinstance(value, (int, float)) and not isinstance(
        value, bool
    ) else default


@dataclass(frozen=True)
class Account:
    logged_in: bool = False
    email: str | None = None
    display_name: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> "Account":
        data = _as_dict(data)
        return cls(
            logged_in=bool(data.get("loggedIn", False)),
            email=data.get("email") or None,
            display_name=data.get("displayName") or None,
        )


@dataclass(frozen=True)
class PairStats:
    pending: int = 0
    conflicts: int = 0
    files_up: int = 0
    files_down: int = 0
    bytes_up: int = 0
    bytes_down: int = 0

    @classmethod
    def from_json(cls, data: Any) -> "PairStats":
        data = _as_dict(data)
        return cls(
            pending=_as_int(data.get("pending")),
            conflicts=_as_int(data.get("conflicts")),
            files_up=_as_int(data.get("filesUp")),
            files_down=_as_int(data.get("filesDown")),
            bytes_up=_as_int(data.get("bytesUp")),
            bytes_down=_as_int(data.get("bytesDown")),
        )


@dataclass(frozen=True)
class Pair:
    id: str = ""
    local_path: str = ""
    remote_path: str = ""
    remote_uid: str = ""
    enabled: bool = True
    #: gitignore-style patterns, relative to the pair root.
    excludes: tuple[str, ...] = ()
    status: str = STATUS_IDLE
    last_sync_at: int | None = None
    error: str | None = None
    stats: PairStats = field(default_factory=PairStats)

    @classmethod
    def from_json(cls, data: Any) -> "Pair":
        data = _as_dict(data)
        last = data.get("lastSyncAt")
        raw_excludes = data.get("excludes")
        excludes = tuple(
            str(x) for x in raw_excludes if isinstance(x, str)
        ) if isinstance(raw_excludes, list) else ()
        return cls(
            id=str(data.get("id") or ""),
            local_path=str(data.get("localPath") or ""),
            remote_path=str(data.get("remotePath") or ""),
            remote_uid=str(data.get("remoteUid") or ""),
            enabled=bool(data.get("enabled", True)),
            excludes=excludes,
            status=str(data.get("status") or STATUS_IDLE),
            last_sync_at=int(last) if isinstance(last, (int, float)) else None,
            error=data.get("error") or None,
            stats=PairStats.from_json(data.get("stats")),
        )

    @property
    def is_busy(self) -> bool:
        return self.status in (STATUS_SYNCING, STATUS_SCANNING, STATUS_SETUP)


@dataclass(frozen=True)
class Activity:
    pair_id: str = ""
    kind: str = "upload"
    path: str = ""
    bytes_done: int = 0
    bytes_total: int = 0

    @classmethod
    def from_json(cls, data: Any) -> "Activity | None":
        if not isinstance(data, dict):
            return None
        return cls(
            pair_id=str(data.get("pairId") or ""),
            kind=str(data.get("kind") or "upload"),
            path=str(data.get("path") or ""),
            bytes_done=_as_int(data.get("bytesDone")),
            bytes_total=_as_int(data.get("bytesTotal")),
        )

    @property
    def fraction(self) -> float:
        if self.bytes_total <= 0:
            return 0.0
        return max(0.0, min(1.0, self.bytes_done / self.bytes_total))

    @property
    def is_upload(self) -> bool:
        return self.kind == "upload"


@dataclass(frozen=True)
class Status:
    version: str = ""
    logged_in: bool = False
    email: str | None = None
    paused: bool = False
    online: bool = True
    activity: Activity | None = None
    pairs: tuple[Pair, ...] = ()

    @classmethod
    def from_json(cls, data: Any) -> "Status":
        data = _as_dict(data)
        raw_pairs = data.get("pairs")
        pairs = tuple(
            Pair.from_json(p) for p in raw_pairs
        ) if isinstance(raw_pairs, list) else ()
        return cls(
            version=str(data.get("version") or ""),
            logged_in=bool(data.get("loggedIn", False)),
            email=data.get("email") or None,
            paused=bool(data.get("paused", False)),
            online=bool(data.get("online", True)),
            activity=Activity.from_json(data.get("activity")),
            pairs=pairs,
        )

    @property
    def total_conflicts(self) -> int:
        return sum(p.stats.conflicts for p in self.pairs)

    @property
    def total_pending(self) -> int:
        return sum(p.stats.pending for p in self.pairs)

    def activity_for(self, pair_id: str) -> Activity | None:
        if self.activity is not None and self.activity.pair_id == pair_id:
            return self.activity
        return None


@dataclass(frozen=True)
class RemoteFolder:
    uid: str = ""
    name: str = ""
    path: str = ""
    has_children: bool = False

    @classmethod
    def from_json(cls, data: Any) -> "RemoteFolder":
        data = _as_dict(data)
        return cls(
            uid=str(data.get("uid") or ""),
            name=str(data.get("name") or ""),
            path=str(data.get("path") or ""),
            has_children=bool(data.get("hasChildren", False)),
        )


@dataclass(frozen=True)
class Conflict:
    id: str = ""
    pair_id: str = ""
    path: str = ""
    kind: str = KIND_BOTH_MODIFIED
    detected_at: int | None = None
    kept_copy_path: str | None = None
    local_modified_at: int | None = None
    remote_modified_at: int | None = None

    @classmethod
    def from_json(cls, data: Any) -> "Conflict":
        data = _as_dict(data)

        def ts(key: str) -> int | None:
            value = data.get(key)
            return int(value) if isinstance(value, (int, float)) else None

        return cls(
            id=str(data.get("id") or ""),
            pair_id=str(data.get("pairId") or ""),
            path=str(data.get("path") or ""),
            kind=str(data.get("kind") or KIND_BOTH_MODIFIED),
            detected_at=ts("detectedAt"),
            kept_copy_path=data.get("keptCopyPath") or None,
            local_modified_at=ts("localModifiedAt"),
            remote_modified_at=ts("remoteModifiedAt"),
        )


@dataclass(frozen=True)
class HistoryEntry:
    """One thing sync did to one file, as shown in the activity log."""

    id: int = 0
    pair_id: str = ""
    at: int | None = None
    action: str = ACTION_DOWNLOADED
    path: str = ""
    #: Destination, for moves and renames only.
    to_path: str | None = None
    type: str = "file"
    size: int | None = None
    outcome: str = OUTCOME_OK
    error: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> "HistoryEntry":
        data = _as_dict(data)
        size = data.get("size")
        at = data.get("at")
        return cls(
            id=_as_int(data.get("id")),
            pair_id=str(data.get("pairId") or ""),
            at=int(at) if isinstance(at, (int, float)) else None,
            action=str(data.get("action") or ACTION_DOWNLOADED),
            path=str(data.get("path") or ""),
            to_path=data.get("toPath") or None,
            type=str(data.get("type") or "file"),
            size=int(size) if isinstance(size, (int, float)) else None,
            outcome=str(data.get("outcome") or OUTCOME_OK),
            error=data.get("error") or None,
        )

    @property
    def failed(self) -> bool:
        return self.outcome == OUTCOME_FAILED

    @property
    def is_folder(self) -> bool:
        return self.type == "folder"

    @property
    def name(self) -> str:
        """Return the bare filename shown in the activity list."""
        subject = self.to_path or self.path
        return os.path.basename(subject) or subject


@dataclass(frozen=True)
class Notification:
    kind: str = "info"
    title: str = ""
    body: str = ""

    @classmethod
    def from_json(cls, data: Any) -> "Notification":
        data = _as_dict(data)
        return cls(
            kind=str(data.get("kind") or "info"),
            title=str(data.get("title") or ""),
            body=str(data.get("body") or ""),
        )


@dataclass(frozen=True)
class LoginState:
    state: str = "pending"
    error: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> "LoginState":
        data = _as_dict(data)
        return cls(
            state=str(data.get("state") or "pending"),
            error=data.get("error") or None,
        )
