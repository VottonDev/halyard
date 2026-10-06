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
    shared_with_me: bool = False
    can_write: bool = True

    @classmethod
    def from_json(cls, data: Any) -> "RemoteFolder":
        data = _as_dict(data)
        return cls(
            uid=str(data.get("uid") or ""),
            name=str(data.get("name") or ""),
            path=str(data.get("path") or ""),
            has_children=bool(data.get("hasChildren", False)),
            shared_with_me=bool(data.get("sharedWithMe", False)),
            can_write=bool(data.get("canWrite", True)),
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


@dataclass(frozen=True)
class Photo:
    uid: str = ""
    name: str = ""
    capture_time: int = 0
    size: int | None = None
    media_type: str = ""
    revision_uid: str = ""
    favourite: bool = False
    related_uids: tuple[str, ...] = ()
    error: str | None = None
    can_favourite: bool = False
    can_trash: bool = False

    @classmethod
    def from_json(cls, data: Any) -> "Photo":
        data = _as_dict(data)
        size = data.get("size")
        related = data.get("relatedUids")
        return cls(
            uid=str(data.get("uid") or ""), name=str(data.get("name") or ""),
            capture_time=int(_as_int(data.get("captureTime"))),
            size=int(size) if isinstance(size, (int, float)) and not isinstance(size, bool) else None,
            media_type=str(data.get("mediaType") or ""),
            revision_uid=str(data.get("revisionUid") or ""),
            favourite=bool(data.get("favourite", False)),
            related_uids=tuple(x for x in related if isinstance(x, str)) if isinstance(related, list) else (),
            error=str(data["error"]) if data.get("error") else None,
            can_favourite=data.get("canFavourite") is True,
            can_trash=data.get("canTrash") is True,
        )

    @property
    def is_video(self) -> bool:
        return self.media_type.startswith("video/")


@dataclass(frozen=True)
class PhotoPage:
    photos: tuple[Photo, ...] = ()
    next_cursor: str | None = None
    revision: int = 0

    @classmethod
    def from_json(cls, data: Any) -> "PhotoPage":
        data = _as_dict(data)
        items = data.get("photos")
        return cls(
            photos=tuple(Photo.from_json(p) for p in items if isinstance(p, dict)) if isinstance(items, list) else (),
            next_cursor=data.get("nextCursor") if isinstance(data.get("nextCursor"), str) else None,
            revision=int(_as_int(data.get("revision"))),
        )


@dataclass(frozen=True)
class PhotoAlbum:
    uid: str = ""
    name: str = ""
    photo_count: int = 0
    cover_photo_uid: str | None = None
    shared_with_me: bool = False
    can_write: bool = False
    can_delete: bool = False

    @classmethod
    def from_json(cls, data: Any) -> "PhotoAlbum":
        data = _as_dict(data)
        return cls(uid=str(data.get("uid") or ""), name=str(data.get("name") or ""),
                   photo_count=int(_as_int(data.get("photoCount"))),
                   cover_photo_uid=data.get("coverPhotoUid") or None,
                   shared_with_me=data.get("sharedWithMe") is True,
                   can_write=data.get("canWrite") is True,
                   can_delete=data.get("canDelete") is True)


@dataclass(frozen=True)
class PhotoThumbnail:
    uid: str = ""
    data: str | None = None
    error: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> "PhotoThumbnail":
        data = _as_dict(data)
        content = data.get("data")
        return cls(uid=str(data.get("uid") or ""),
                   data=content if isinstance(content, str) and len(content) <= 4 * 1024 * 1024 else None,
                   error=str(data["error"]) if data.get("error") else None)


@dataclass(frozen=True)
class PhotoDownloadFile:
    uid: str = ""
    name: str = ""
    size: int | None = None
    bytes_done: int = 0
    status: str = "queued"
    path: str | None = None
    error: str | None = None

    @classmethod
    def from_json(cls, data: Any) -> "PhotoDownloadFile":
        data = _as_dict(data)
        size = data.get("size")
        return cls(uid=str(data.get("uid") or ""), name=str(data.get("name") or ""),
                   size=int(size) if isinstance(size, (int, float)) and not isinstance(size, bool) else None,
                   bytes_done=int(_as_int(data.get("bytesDone"))),
                   status=str(data.get("status") or "queued"),
                   path=data.get("path") or None, error=data.get("error") or None)


@dataclass(frozen=True)
class PhotoDownload:
    id: str = ""
    destination: str = ""
    created_at: int = 0
    status: str = "queued"
    files: tuple[PhotoDownloadFile, ...] = ()

    @classmethod
    def from_json(cls, data: Any) -> "PhotoDownload":
        data = _as_dict(data)
        files = data.get("files")
        return cls(id=str(data.get("id") or ""), destination=str(data.get("destination") or ""),
                   created_at=int(_as_int(data.get("createdAt"))), status=str(data.get("status") or "queued"),
                   files=tuple(PhotoDownloadFile.from_json(f) for f in files if isinstance(f, dict)) if isinstance(files, list) else ())

    @property
    def active(self) -> bool:
        return self.status in ("queued", "downloading", "uploading", "paused")

    @property
    def fraction(self) -> float:
        total = sum(f.size or 0 for f in self.files)
        return min(1.0, sum(f.bytes_done for f in self.files) / total) if total else 0.0


@dataclass(frozen=True)
class PhotoTrashResult:
    uid: str = ""
    ok: bool = False
    error: str | None = None

    @classmethod
    def from_json(cls, data):
        data = _as_dict(data)
        return cls(uid=str(data.get("uid") or ""), ok=data.get("ok") is True, error=data.get("error") or None)


@dataclass(frozen=True)
class PhotoManagementResult:
    results: tuple[PhotoTrashResult, ...] = ()
    cancelled: bool = False
    revision: int = 0

    @classmethod
    def from_json(cls, data):
        data = _as_dict(data)
        results = data.get("results")
        return cls(results=tuple(PhotoTrashResult.from_json(r) for r in results if isinstance(r, dict)) if isinstance(results, list) else (),
                   cancelled=data.get("cancelled") is True, revision=int(_as_int(data.get("revision"))))


@dataclass(frozen=True)
class VideoPreview:
    id: str = ""
    uid: str = ""
    status: str = "failed"
    uri: str | None = None
    size: int = 0
    error: str | None = None

    @classmethod
    def from_json(cls, data):
        from urllib.parse import urlparse
        data = _as_dict(data)
        uri = data.get("uri")
        # Media URIs are capabilities generated by the local daemon. Refuse
        # external or file URIs at the parser boundary.
        if isinstance(uri, str):
            parsed = urlparse(uri)
            if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.path.startswith("/video/"):
                uri = None
        else: uri = None
        return cls(id=str(data.get("id") or ""), uid=str(data.get("uid") or ""), status=str(data.get("status") or "failed"),
                   uri=uri, size=int(_as_int(data.get("size"))), error=data.get("error") or None)
