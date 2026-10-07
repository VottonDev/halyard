"""Asynchronous D-Bus client for the Halyard sync daemon.

Every call on this object is non-blocking. Results arrive on callbacks running
in the GTK main loop, so the UI never stalls waiting for the bus. Some daemon
calls (remote folder listings in particular) take seconds.

The daemon's availability is tracked with ``Gio.bus_watch_name``: the UI can
start before the daemon, survive it exiting, and recover on its own when it
comes back.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable

from gi.repository import Gio, GLib, GObject

from .models import (
    VideoPreview, PhotoTrashResult, PhotoManagementResult,
    Account,
    Conflict,
    HistoryEntry,
    LoginState,
    Notification,
    Pair,
    RemoteFolder,
    Status,
    Photo, PhotoPage, PhotoAlbum, PhotoThumbnail, PhotoDownload,
)

#: The production daemon's bus name, as fixed by docs/dbus-api.md.
DEFAULT_BUS_NAME = "io.github.votton.Halyard.Daemon"

#: Overridable so the UI can be pointed at tests/mock_daemon.py, which owns a
#: different name so that it never collides with a real daemon on the same
#: session bus. The object path and interface are unchanged either way.
BUS_NAME = os.environ.get("HALYARD_BUS_NAME") or DEFAULT_BUS_NAME

OBJECT_PATH = "/io/github/votton/Halyard/Daemon"
INTERFACE = "io.github.votton.Halyard.Daemon"

DEFAULT_TIMEOUT_MS = 30_000
# Remote listings and login handshakes talk to Proton over the network.
SLOW_TIMEOUT_MS = 120_000

OkCallback = Callable[[Any], None]
ErrCallback = Callable[[str], None]


class DaemonError(Exception):
    """A failure reported by the daemon, or by the bus itself."""


def _friendly_error(error: GLib.Error) -> str:
    """Turn a GError into something worth putting in front of a person.

    Daemon-raised errors already carry a human-readable message, which the
    contract says to show verbatim; bus-level plumbing errors do not.
    """
    remote = Gio.dbus_error_get_remote_error(error)
    if remote:
        # Strips the "org.example.Error: " prefix in place and reports whether
        # it changed anything; it does not return the error.
        Gio.dbus_error_strip_remote_error(error)
        if remote in (
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "org.freedesktop.DBus.Error.NameHasNoOwner",
        ):
            return "The Halyard sync service is not running."
        if remote == "org.freedesktop.DBus.Error.NoReply":
            return "The sync service stopped responding."
        if remote == "org.freedesktop.DBus.Error.TimedOut":
            return "The sync service took too long to respond."
    return error.message or "The sync service reported an unknown error."


class DaemonClient(GObject.Object):
    """Typed, async facade over the daemon interface."""

    __gsignals__ = {
        # available, plus a human-readable reason when it goes away
        "availability-changed": (GObject.SIGNAL_RUN_FIRST, None, (bool,)),
        "status-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "login-state-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "notification": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "photos-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "video-preview-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "photo-uploads-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
        "photo-downloads-changed": (GObject.SIGNAL_RUN_FIRST, None, (object,)),
    }

    def __init__(self) -> None:
        super().__init__()
        self._proxy: Gio.DBusProxy | None = None
        self._available = False
        self._watch_id = 0
        self._proxy_pending = False

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        """Begin watching for the daemon without blocking."""
        if self._watch_id:
            return
        self._watch_id = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            self._on_name_appeared,
            self._on_name_vanished,
        )

    def stop(self) -> None:
        if self._watch_id:
            Gio.bus_unwatch_name(self._watch_id)
            self._watch_id = 0
        self._proxy = None
        self._available = False

    @property
    def available(self) -> bool:
        return self._available

    def _on_name_appeared(self, connection, name, name_owner) -> None:
        if self._proxy is not None:
            self._set_available(True)
            return
        if self._proxy_pending:
            return
        self._proxy_pending = True
        Gio.DBusProxy.new(
            connection,
            # No properties on this interface, so don't waste a round trip.
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            None,
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE,
            None,
            self._on_proxy_ready,
        )

    def _on_proxy_ready(self, source, result) -> None:
        self._proxy_pending = False
        try:
            proxy = Gio.DBusProxy.new_finish(result)
        except GLib.Error:
            self._set_available(False)
            return
        self._proxy = proxy
        proxy.connect("g-signal", self._on_g_signal)
        self._set_available(True)

    def _on_name_vanished(self, connection, name) -> None:
        self._proxy = None
        self._set_available(False)

    def _set_available(self, available: bool) -> None:
        if available == self._available:
            return
        self._available = available
        self.emit("availability-changed", available)

    # -- incoming signals ------------------------------------------------

    def _on_g_signal(self, proxy, sender_name, signal_name, parameters) -> None:
        try:
            (payload,) = parameters.unpack()
        except (ValueError, TypeError):
            return
        try:
            data = json.loads(payload)
        except (ValueError, TypeError):
            return
        if signal_name == "StatusChanged":
            self.emit("status-changed", Status.from_json(data))
        elif signal_name == "LoginStateChanged":
            self.emit("login-state-changed", LoginState.from_json(data))
        elif signal_name == "Notify":
            self.emit("notification", Notification.from_json(data))
        elif signal_name == "PhotosChanged":
            self.emit("photos-changed", data)
        elif signal_name == "VideoPreviewChanged":
            self.emit("video-preview-changed", VideoPreview.from_json(data))
        elif signal_name == "PhotoUploadsChanged":
            self.emit("photo-uploads-changed", tuple(PhotoDownload.from_json(j) for j in data) if isinstance(data, list) else ())
        elif signal_name == "PhotoDownloadsChanged":
            self.emit("photo-downloads-changed", tuple(PhotoDownload.from_json(j) for j in data) if isinstance(data, list) else ())

    # -- the async call plumbing -----------------------------------------

    def _call(
        self,
        method: str,
        args: GLib.Variant | None = None,
        *,
        parse: Callable[[Any], Any] | None = None,
        on_ok: OkCallback | None = None,
        on_err: ErrCallback | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
    ) -> None:
        proxy = self._proxy
        if proxy is None:
            if on_err is not None:
                # Defer, so callers never see a callback fire before the call
                # they made has returned.
                GLib.idle_add(
                    lambda: (
                        on_err("The Halyard sync service is not running."),
                        False,
                    )[1]
                )
            return

        def on_done(source, result) -> None:
            try:
                reply = source.call_finish(result)
            except GLib.Error as error:
                if on_err is not None:
                    on_err(_friendly_error(error))
                return
            if on_ok is None:
                return
            unpacked = reply.unpack()
            value = unpacked[0] if unpacked else None
            if parse is None:
                on_ok(value)
                return
            try:
                on_ok(parse(json.loads(value) if isinstance(value, str) else value))
            except (ValueError, TypeError) as exc:
                if on_err is not None:
                    on_err(f"The sync service sent a malformed reply: {exc}")

        proxy.call(
            method,
            args,
            Gio.DBusCallFlags.NONE,
            timeout_ms,
            None,
            on_done,
        )

    # -- account ---------------------------------------------------------

    def list_photos(self, query: dict, on_ok: OkCallback, on_err: ErrCallback) -> None:
        """List a gallery page, optionally filtered by four-digit year or YYYY-MM month."""
        self._call("ListPhotos", GLib.Variant("(s)", [json.dumps(query)]),
                   parse=PhotoPage.from_json, on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def list_photo_albums(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ListPhotoAlbums", parse=lambda data: tuple(PhotoAlbum.from_json(a) for a in data) if isinstance(data, list) else (),
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def get_photo(self, uid: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("GetPhoto", GLib.Variant("(s)", [uid]), parse=Photo.from_json,
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def create_photo_album(self, name: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("CreatePhotoAlbum", GLib.Variant("(s)", [name]), parse=PhotoAlbum.from_json,
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def rename_photo_album(self, uid: str, name: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("RenamePhotoAlbum", GLib.Variant("(s)", [json.dumps({"uid": uid, "name": name})]), parse=PhotoAlbum.from_json,
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def delete_photo_album(self, uid: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("DeletePhotoAlbum", GLib.Variant("(s)", [uid]), on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def manage_photos(self, request: dict, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ManagePhotos", GLib.Variant("(s)", [json.dumps(request)]), parse=PhotoManagementResult.from_json,
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def cancel_photo_operation(self, operation_id: str, on_err: ErrCallback) -> None:
        self._call("CancelPhotoOperation", GLib.Variant("(s)", [operation_id]), on_err=on_err)

    def get_photo_thumbnails(self, uids: list[str], on_ok: OkCallback, on_err: ErrCallback, preview: bool = False) -> None:
        self._call("GetPhotoThumbnails", GLib.Variant("(s)", [json.dumps({"uids": uids, "preview": preview})]),
                   parse=lambda data: tuple(PhotoThumbnail.from_json(t) for t in data) if isinstance(data, list) else (),
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def start_photo_download(self, uids: list[str], destination: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("StartPhotoDownload", GLib.Variant("(s)", [json.dumps({"uids": uids, "destination": destination})]),
                   parse=PhotoDownload.from_json, on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def trash_photos(self, uids, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("TrashPhotos", GLib.Variant("(s)", [json.dumps({"uids": uids})]),
                   parse=lambda data: tuple(PhotoTrashResult.from_json(r) for r in data) if isinstance(data, list) else (),
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def start_video_preview(self, uid, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("StartVideoPreview", GLib.Variant("(s)", [uid]), parse=VideoPreview.from_json,
                   on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def release_video_preview(self, preview_id) -> None:
        self._call("ReleaseVideoPreview", GLib.Variant("(s)", [preview_id]))

    def start_photo_upload(self, files: list[dict], on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("StartPhotoUpload", GLib.Variant("(s)", [json.dumps({"files": files})]),
                   parse=PhotoDownload.from_json, on_ok=on_ok, on_err=on_err, timeout_ms=SLOW_TIMEOUT_MS)

    def list_photo_uploads(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ListPhotoUploads", parse=lambda data: tuple(PhotoDownload.from_json(j) for j in data) if isinstance(data, list) else (),
                   on_ok=on_ok, on_err=on_err)

    def control_photo_upload(self, job_id: str, action: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ControlPhotoUpload", GLib.Variant("(ss)", [job_id, action]), on_ok=on_ok, on_err=on_err)

    def list_photo_downloads(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ListPhotoDownloads", parse=lambda data: tuple(PhotoDownload.from_json(j) for j in data) if isinstance(data, list) else (),
                   on_ok=on_ok, on_err=on_err)

    def control_photo_download(self, job_id: str, action: str, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("ControlPhotoDownload", GLib.Variant("(ss)", [job_id, action]), on_ok=on_ok, on_err=on_err)

    def get_account(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("GetAccount", parse=Account.from_json,
                   on_ok=on_ok, on_err=on_err)

    def begin_login(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        """Returns the sign-in URL the UI must open in a browser."""

        def parse(data: Any) -> str:
            url = (data or {}).get("signInUrl") if isinstance(data, dict) else None
            if not url:
                raise ValueError("no signInUrl in the reply")
            return str(url)

        self._call("BeginLogin", parse=parse, on_ok=on_ok, on_err=on_err,
                   timeout_ms=SLOW_TIMEOUT_MS)

    def cancel_login(self, on_ok: OkCallback | None = None,
                     on_err: ErrCallback | None = None) -> None:
        self._call("CancelLogin", on_ok=on_ok, on_err=on_err)

    def logout(self, on_ok: OkCallback | None = None,
               on_err: ErrCallback | None = None) -> None:
        self._call("Logout", on_ok=on_ok, on_err=on_err)

    # -- pairs -----------------------------------------------------------

    def list_pairs(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        def parse(data: Any) -> list[Pair]:
            return [Pair.from_json(p) for p in data] if isinstance(data, list) else []

        self._call("ListPairs", parse=parse, on_ok=on_ok, on_err=on_err)

    def add_pair(self, local_path: str, remote_uid: str, remote_path: str,
                 on_ok: OkCallback, on_err: ErrCallback,
                 excludes: list[str] | None = None,
                 create_remote: bool = False,
                 remote_name: str | None = None) -> None:
        """Pair a local folder with Proton Drive.

        Pass an existing ``remote_uid``, or set ``create_remote`` to have the
        daemon create a folder at the top of My Files. It uses ``remote_name``
        when set, otherwise it uses the local folder's name.
        """
        payload: dict = {
            "localPath": local_path,
            "remoteUid": remote_uid,
            "remotePath": remote_path,
        }
        if excludes is not None:
            payload["excludes"] = list(excludes)
        if create_remote:
            payload["createRemote"] = True
            if remote_name:
                payload["remoteName"] = remote_name
        self._call("AddPair", GLib.Variant("(s)", [json.dumps(payload)]),
                   parse=Pair.from_json, on_ok=on_ok, on_err=on_err,
                   timeout_ms=SLOW_TIMEOUT_MS)

    #: The only keys UpdatePair understands. A patch with none of them is an
    #: error rather than a no-op, so callers must not send anything else.
    PATCH_KEYS = frozenset(
        {"enabled", "localPath", "remoteUid", "remotePath", "excludes"}
    )

    def update_pair(self, pair_id: str, patch: dict,
                    on_ok: OkCallback | None = None,
                    on_err: ErrCallback | None = None) -> None:
        patch = {k: v for k, v in patch.items() if k in self.PATCH_KEYS}
        if not patch:
            if on_err is not None:
                GLib.idle_add(
                    lambda: (on_err("Nothing to change."), False)[1]
                )
            return
        self._call("UpdatePair",
                   GLib.Variant("(ss)", [pair_id, json.dumps(patch)]),
                   parse=Pair.from_json, on_ok=on_ok, on_err=on_err)

    def set_pair_excludes(self, pair_id: str, excludes: list[str],
                          on_ok: OkCallback | None = None,
                          on_err: ErrCallback | None = None) -> None:
        """An empty list clears every exclusion."""
        self.update_pair(pair_id, {"excludes": list(excludes)}, on_ok, on_err)

    def set_pair_enabled(self, pair_id: str, enabled: bool,
                         on_ok: OkCallback | None = None,
                         on_err: ErrCallback | None = None) -> None:
        self.update_pair(pair_id, {"enabled": enabled}, on_ok, on_err)

    def remove_pair(self, pair_id: str, delete_local_state: bool,
                    on_ok: OkCallback | None = None,
                    on_err: ErrCallback | None = None) -> None:
        self._call("RemovePair",
                   GLib.Variant("(sb)", [pair_id, delete_local_state]),
                   on_ok=on_ok, on_err=on_err)

    def sync_now(self, pair_id: str = "",
                 on_ok: OkCallback | None = None,
                 on_err: ErrCallback | None = None) -> None:
        """An empty pair_id syncs every pair."""
        self._call("SyncNow", GLib.Variant("(s)", [pair_id]),
                   on_ok=on_ok, on_err=on_err)

    def set_paused(self, paused: bool,
                   on_ok: OkCallback | None = None,
                   on_err: ErrCallback | None = None) -> None:
        self._call("SetPaused", GLib.Variant("(b)", [paused]),
                   on_ok=on_ok, on_err=on_err)

    # -- remote browsing -------------------------------------------------

    def list_remote_folders(self, parent_uid: str, on_ok: OkCallback,
                            on_err: ErrCallback) -> None:
        """An empty parent_uid lists My Files folders, then accepted shares."""

        def parse(data: Any) -> list[RemoteFolder]:
            return [
                RemoteFolder.from_json(f) for f in data
            ] if isinstance(data, list) else []

        self._call("ListRemoteFolders", GLib.Variant("(s)", [parent_uid]),
                   parse=parse, on_ok=on_ok, on_err=on_err,
                   timeout_ms=SLOW_TIMEOUT_MS)

    def create_remote_folder(self, parent_uid: str, name: str,
                             on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("CreateRemoteFolder",
                   GLib.Variant("(ss)", [parent_uid, name]),
                   parse=RemoteFolder.from_json, on_ok=on_ok, on_err=on_err,
                   timeout_ms=SLOW_TIMEOUT_MS)

    # -- status and conflicts --------------------------------------------

    def get_status(self, on_ok: OkCallback, on_err: ErrCallback) -> None:
        self._call("GetStatus", parse=Status.from_json,
                   on_ok=on_ok, on_err=on_err)

    def list_conflicts(self, pair_id: str, on_ok: OkCallback,
                       on_err: ErrCallback) -> None:
        def parse(data: Any) -> list[Conflict]:
            return [
                Conflict.from_json(c) for c in data
            ] if isinstance(data, list) else []

        self._call("ListConflicts", GLib.Variant("(s)", [pair_id]),
                   parse=parse, on_ok=on_ok, on_err=on_err)

    def resolve_conflict(self, conflict_id: str, resolution: str,
                         on_ok: OkCallback | None = None,
                         on_err: ErrCallback | None = None) -> None:
        self._call("ResolveConflict",
                   GLib.Variant("(ss)", [conflict_id, resolution]),
                   on_ok=on_ok, on_err=on_err)

    # -- activity log ----------------------------------------------------

    def list_history(self, on_ok: OkCallback, on_err: ErrCallback, *,
                     pair_id: str = "", actions: list[str] | None = None,
                     outcome: str = "", search: str = "",
                     before_id: int | None = None,
                     limit: int = 100) -> None:
        """Fetch activity, newest first.

        Every filter narrows; omitting one means "any". ``before_id`` pages
        backwards through time. Pass the id of the oldest entry you already
        hold to get the next batch.
        """
        query: dict = {"limit": limit}
        if pair_id:
            query["pairId"] = pair_id
        if actions:
            query["actions"] = list(actions)
        if outcome:
            query["outcome"] = outcome
        if search:
            query["search"] = search
        if before_id is not None:
            query["beforeId"] = before_id

        def parse(data: Any) -> list[HistoryEntry]:
            return [
                HistoryEntry.from_json(e) for e in data
            ] if isinstance(data, list) else []

        self._call("ListHistory", GLib.Variant("(s)", [json.dumps(query)]),
                   parse=parse, on_ok=on_ok, on_err=on_err)

    def clear_history(self, pair_id: str = "",
                      on_ok: OkCallback | None = None,
                      on_err: ErrCallback | None = None) -> None:
        """An empty pair_id clears every pair's activity."""
        self._call("ClearHistory", GLib.Variant("(s)", [pair_id]),
                   on_ok=on_ok, on_err=on_err)

    def get_version(self, on_ok: OkCallback,
                    on_err: ErrCallback | None = None) -> None:
        self._call("GetVersion", on_ok=on_ok, on_err=on_err)

    def quit_daemon(self, on_ok: OkCallback | None = None,
                    on_err: ErrCallback | None = None) -> None:
        self._call("Quit", on_ok=on_ok, on_err=on_err)
