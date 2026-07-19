#!/usr/bin/env python3
"""Mock Halyard sync daemon.

A standalone stand-in for the real Node daemon, implementing the frozen D-Bus
contract in docs/dbus-api.md with believable fake data so the GTK user
interface can be developed and verified without a Proton account.

It deliberately answers some calls slowly, so that any accidental synchronous
D-Bus call in the UI shows up immediately as a frozen window.

It owns ``io.github.votton.Halyard.MockDaemon``, NOT the real daemon's name,
so it can run alongside a real daemon on the same session bus. Point the UI at
it with ``HALYARD_BUS_NAME=io.github.votton.Halyard.MockDaemon``.

Usage:
    python3 mock_daemon.py [options]

Options:
    --bus-name NAME     bus name to own (default: …Halyard.MockDaemon)
    --logged-in         start already signed in (default: signed out)
    --login-delay N     seconds before a login attempt succeeds (default: 4)
    --login-fails       make the next login attempt fail instead of succeed
    --offline           report the daemon as offline
    --no-activity       do not animate a transfer
    --quiet             do not emit periodic Notify signals
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time

from gi.repository import Gio, GLib

#: The real daemon's name. The mock must never take this: a real daemon is
#: connected to someone's actual Proton Drive, and a UI pointed at the wrong
#: one would issue writes against live data.
PRODUCTION_BUS_NAME = "io.github.votton.Halyard.Daemon"

#: What the mock owns instead. Point the UI at it with
#: HALYARD_BUS_NAME=io.github.votton.Halyard.MockDaemon
DEFAULT_BUS_NAME = "io.github.votton.Halyard.MockDaemon"

OBJECT_PATH = "/io/github/votton/Halyard/Daemon"
INTERFACE = "io.github.votton.Halyard.Daemon"
ERROR_FAILED = "io.github.votton.Halyard.Error.Failed"

VERSION = "0.1.0-mock"

INTROSPECTION = f"""
<node>
  <interface name="{INTERFACE}">
    <method name="GetAccount">
      <arg type="s" name="account" direction="out"/>
    </method>
    <method name="BeginLogin">
      <arg type="s" name="result" direction="out"/>
    </method>
    <method name="CancelLogin"/>
    <method name="Logout"/>

    <method name="ListPairs">
      <arg type="s" name="pairs" direction="out"/>
    </method>
    <method name="AddPair">
      <arg type="s" name="newPair" direction="in"/>
      <arg type="s" name="pair" direction="out"/>
    </method>
    <method name="UpdatePair">
      <arg type="s" name="id" direction="in"/>
      <arg type="s" name="patch" direction="in"/>
      <arg type="s" name="pair" direction="out"/>
    </method>
    <method name="RemovePair">
      <arg type="s" name="id" direction="in"/>
      <arg type="b" name="deleteLocalState" direction="in"/>
    </method>
    <method name="SyncNow">
      <arg type="s" name="id" direction="in"/>
    </method>
    <method name="SetPaused">
      <arg type="b" name="paused" direction="in"/>
    </method>

    <method name="ListRemoteFolders">
      <arg type="s" name="parentUid" direction="in"/>
      <arg type="s" name="folders" direction="out"/>
    </method>
    <method name="CreateRemoteFolder">
      <arg type="s" name="parentUid" direction="in"/>
      <arg type="s" name="name" direction="in"/>
      <arg type="s" name="folder" direction="out"/>
    </method>

    <method name="GetStatus">
      <arg type="s" name="status" direction="out"/>
    </method>
    <method name="ListConflicts">
      <arg type="s" name="pairId" direction="in"/>
      <arg type="s" name="conflicts" direction="out"/>
    </method>
    <method name="ResolveConflict">
      <arg type="s" name="conflictId" direction="in"/>
      <arg type="s" name="resolution" direction="in"/>
    </method>
    <method name="GetVersion">
      <arg type="s" name="version" direction="out"/>
    </method>
    <method name="Quit"/>

    <signal name="StatusChanged">
      <arg type="s" name="status"/>
    </signal>
    <signal name="LoginStateChanged">
      <arg type="s" name="state"/>
    </signal>
    <signal name="Notify">
      <arg type="s" name="notification"/>
    </signal>
  </interface>
</node>
"""


#: Keys UpdatePair understands. A patch with none of them is an error.
PATCH_KEYS = {"enabled", "localPath", "remoteUid", "remotePath", "excludes"}


def validate_excludes(patterns) -> list[str]:
    """Validate gitignore-style exclusions the way the contract describes.

    Raises ValueError naming the offending pattern, so the UI can show the
    message against the row it belongs to.
    """
    if not isinstance(patterns, list):
        raise ValueError("excludes must be a list of patterns.")
    cleaned: list[str] = []
    for raw in patterns:
        if not isinstance(raw, str):
            raise ValueError("excludes must be a list of strings.")
        pattern = raw.strip()
        if not pattern:
            continue
        if pattern.startswith("#"):
            cleaned.append(pattern)   # comment: kept verbatim, matches nothing
            continue
        if pattern.startswith("!"):
            raise ValueError(
                f'Exclusion "{pattern}": Negated patterns (!) are not supported'
            )
        if ".." in pattern.split("/"):
            raise ValueError(
                f'Exclusion "{pattern}": Patterns cannot walk outside the '
                "pair with .."
            )
        if pattern.count("**") and "***" in pattern:
            raise ValueError(
                f'Exclusion "{pattern}": "***" is not a valid wildcard'
            )
        if pattern.startswith("~"):
            raise ValueError(
                f'Exclusion "{pattern}": Patterns are relative to the pair '
                "folder, so they cannot start with ~"
            )
        cleaned.append(pattern)
    return cleaned


def now_ms() -> int:
    return int(time.time() * 1000)


def minutes_ago(n: float) -> int:
    return now_ms() - int(n * 60_000)


HOME = os.path.expanduser("~")


class MockState:
    """All the fake data, and the rules that make it move."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.logged_in = args.logged_in
        self.email = "jordan.reyes@proton.me"
        self.display_name = "Jordan Reyes"
        self.paused = False
        self.online = not args.offline
        self.login_pending = False
        self.login_timeout: int | None = None

        self.pairs: list[dict] = [
            {
                "id": "p_7f3a",
                "localPath": f"{HOME}/Documents/Work",
                "remotePath": "/Work",
                "remoteUid": "vol_1~node_work",
                "enabled": True,
                "excludes": ["node_modules", "*.iso"],
                "status": "syncing",
                "lastSyncAt": minutes_ago(0.5),
                "error": None,
                "stats": {
                    "pending": 14, "conflicts": 2,
                    "filesUp": 128, "filesDown": 31,
                    "bytesUp": 734_003_200, "bytesDown": 91_234_567,
                },
            },
            {
                "id": "p_2c81",
                "localPath": f"{HOME}/Pictures/Camera",
                "remotePath": "/Photos/Camera Roll",
                "remoteUid": "vol_1~node_camera",
                "enabled": True,
                "excludes": [],
                "status": "idle",
                "lastSyncAt": minutes_ago(6),
                "error": None,
                "stats": {
                    "pending": 0, "conflicts": 0,
                    "filesUp": 2841, "filesDown": 12,
                    "bytesUp": 18_253_611_008, "bytesDown": 4_194_304,
                },
            },
            {
                "id": "p_9d44",
                "localPath": f"{HOME}/Notes",
                "remotePath": "/Notes",
                "remoteUid": "vol_1~node_notes",
                "enabled": True,
                "excludes": [],
                "status": "error",
                "lastSyncAt": minutes_ago(94),
                "error": "The remote folder no longer exists. It may have been "
                         "moved to trash in Proton Drive.",
                "stats": {
                    "pending": 7, "conflicts": 1,
                    "filesUp": 63, "filesDown": 63,
                    "bytesUp": 1_048_576, "bytesDown": 2_097_152,
                },
            },
            {
                "id": "p_4b06",
                "localPath": f"{HOME}/Documents/Design Assets",
                "remotePath": "/Design/Assets",
                "remoteUid": "vol_1~node_assets",
                "enabled": True,
                "excludes": ["/Renders", "**/cache"],
                "status": "scanning",
                "lastSyncAt": minutes_ago(38),
                "error": None,
                "stats": {
                    "pending": 219, "conflicts": 0,
                    "filesUp": 0, "filesDown": 0,
                    "bytesUp": 0, "bytesDown": 0,
                },
            },
            {
                "id": "p_5e17",
                "localPath": f"{HOME}/Archive/2024",
                "remotePath": "/Archive/2024",
                "remoteUid": "vol_1~node_archive",
                "enabled": False,
                "excludes": [],
                "status": "paused",
                "lastSyncAt": minutes_ago(60 * 24 * 3),
                "error": None,
                "stats": {
                    "pending": 0, "conflicts": 0,
                    "filesUp": 9317, "filesDown": 0,
                    "bytesUp": 47_284_318_208, "bytesDown": 0,
                },
            },
        ]

        self.conflicts: list[dict] = [
            {
                "id": "c_19ab",
                "pairId": "p_7f3a",
                "path": "proposals/q3-roadmap.md",
                "kind": "bothModified",
                "detectedAt": minutes_ago(22),
                "keptCopyPath": "proposals/q3-roadmap (conflict 2026-07-19).md",
                "localModifiedAt": minutes_ago(25),
                "remoteModifiedAt": minutes_ago(23),
            },
            {
                "id": "c_2f70",
                "pairId": "p_7f3a",
                "path": "budget/2026-forecast.ods",
                "kind": "remoteDeletedLocalModified",
                "detectedAt": minutes_ago(140),
                "keptCopyPath": "budget/2026-forecast.ods",
                "localModifiedAt": minutes_ago(150),
                "remoteModifiedAt": minutes_ago(600),
            },
            {
                "id": "c_88c2",
                "pairId": "p_9d44",
                "path": "daily/2026-07-14.md",
                "kind": "localDeletedRemoteModified",
                "detectedAt": minutes_ago(300),
                "keptCopyPath": "daily/2026-07-14 (restored from Proton Drive).md",
                "localModifiedAt": minutes_ago(320),
                "remoteModifiedAt": minutes_ago(310),
            },
        ]

        # Remote folder tree: uid -> list of child folders.
        self.remote_tree: dict[str, list[dict]] = {
            "": [
                {"uid": "vol_1~node_work", "name": "Work", "path": "/Work",
                 "hasChildren": True},
                {"uid": "vol_1~node_photos", "name": "Photos", "path": "/Photos",
                 "hasChildren": True},
                {"uid": "vol_1~node_notes", "name": "Notes", "path": "/Notes",
                 "hasChildren": False},
                {"uid": "vol_1~node_design", "name": "Design", "path": "/Design",
                 "hasChildren": True},
                {"uid": "vol_1~node_archive_root", "name": "Archive",
                 "path": "/Archive", "hasChildren": True},
                {"uid": "vol_1~node_shared", "name": "Shared with me",
                 "path": "/Shared with me", "hasChildren": False},
            ],
            "vol_1~node_work": [
                {"uid": "vol_1~node_proposals", "name": "proposals",
                 "path": "/Work/proposals", "hasChildren": False},
                {"uid": "vol_1~node_budget", "name": "budget",
                 "path": "/Work/budget", "hasChildren": False},
                {"uid": "vol_1~node_contracts", "name": "contracts",
                 "path": "/Work/contracts", "hasChildren": True},
            ],
            "vol_1~node_photos": [
                {"uid": "vol_1~node_camera", "name": "Camera Roll",
                 "path": "/Photos/Camera Roll", "hasChildren": False},
                {"uid": "vol_1~node_2025", "name": "2025",
                 "path": "/Photos/2025", "hasChildren": False},
            ],
            "vol_1~node_design": [
                {"uid": "vol_1~node_assets", "name": "Assets",
                 "path": "/Design/Assets", "hasChildren": False},
                {"uid": "vol_1~node_mockups", "name": "Mockups",
                 "path": "/Design/Mockups", "hasChildren": False},
            ],
            "vol_1~node_archive_root": [
                {"uid": "vol_1~node_archive", "name": "2024",
                 "path": "/Archive/2024", "hasChildren": False},
                {"uid": "vol_1~node_archive23", "name": "2023",
                 "path": "/Archive/2023", "hasChildren": False},
            ],
            "vol_1~node_contracts": [
                {"uid": "vol_1~node_signed", "name": "signed",
                 "path": "/Work/contracts/signed", "hasChildren": False},
            ],
            "vol_1~node_notes": [],
            "vol_1~node_camera": [],
            "vol_1~node_2025": [],
            "vol_1~node_assets": [],
            "vol_1~node_mockups": [],
            "vol_1~node_archive": [],
            "vol_1~node_archive23": [],
            "vol_1~node_signed": [],
            "vol_1~node_shared": [],
        }

        self._transfer_queue = [
            ("upload", "proposals/q3-roadmap.md", 1_048_576),
            ("upload", "budget/2026-forecast.ods", 8_912_896),
            ("download", "contracts/signed/msa-2026.pdf", 3_407_872),
            ("upload", "design/hero-shot@2x.png", 24_117_248),
        ]
        if getattr(args, "no_pairs", False):
            self.pairs = []
            self.conflicts = []

        self._transfer_index = 0
        self.activity: dict | None = None
        if not args.no_activity and self.pairs:
            self._start_next_transfer()

    # -- serialisation ---------------------------------------------------

    def account(self) -> dict:
        if not self.logged_in:
            return {"loggedIn": False, "email": None, "displayName": None}
        return {
            "loggedIn": True,
            "email": self.email,
            "displayName": self.display_name,
        }

    def status(self) -> dict:
        return {
            "version": VERSION,
            "loggedIn": self.logged_in,
            "email": self.email if self.logged_in else None,
            "paused": self.paused,
            "online": self.online,
            "activity": self.activity,
            "pairs": self.pairs if self.logged_in else [],
        }

    def find_pair(self, pair_id: str) -> dict | None:
        return next((p for p in self.pairs if p["id"] == pair_id), None)

    # -- the animated transfer ------------------------------------------

    def _start_next_transfer(self) -> None:
        kind, path, total = self._transfer_queue[
            self._transfer_index % len(self._transfer_queue)
        ]
        self._transfer_index += 1
        pair_id = "p_7f3a" if not path.startswith("design/") else "p_4b06"
        self.activity = {
            "pairId": pair_id,
            "kind": kind,
            "path": path,
            "bytesDone": 0,
            "bytesTotal": total,
        }

    def tick(self) -> bool:
        """Advance the fake transfer. Returns True if something changed."""
        if self.paused or not self.online or not self.logged_in:
            if self.activity is not None:
                self.activity = None
                return True
            return False
        if self.args.no_activity or not self.pairs:
            return False
        if self.activity is None:
            # Signing in (or resuming) picks the transfer back up, so the UI
            # always has live progress to render.
            self._start_next_transfer()
            return True

        act = self.activity
        step = max(int(act["bytesTotal"] * random.uniform(0.03, 0.11)), 16384)
        act["bytesDone"] = min(act["bytesDone"] + step, act["bytesTotal"])

        pair = self.find_pair(act["pairId"])
        if pair is not None and pair["status"] not in ("syncing",):
            pair["status"] = "syncing"

        if act["bytesDone"] >= act["bytesTotal"]:
            finished = dict(act)
            if pair is not None:
                pair["lastSyncAt"] = now_ms()
                pair["stats"]["pending"] = max(
                    0, pair["stats"]["pending"] - 1
                )
                if finished["kind"] == "upload":
                    pair["stats"]["filesUp"] += 1
                    pair["stats"]["bytesUp"] += finished["bytesTotal"]
                else:
                    pair["stats"]["filesDown"] += 1
                    pair["stats"]["bytesDown"] += finished["bytesTotal"]
            self._start_next_transfer()
        return True


class MockDaemon:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.bus_name = args.bus_name
        self.state = MockState(args)
        self.loop = GLib.MainLoop()
        self.connection: Gio.DBusConnection | None = None
        self.reg_id = 0
        self.exit_code = 0
        self.node_info = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)

    # -- lifecycle -------------------------------------------------------

    def run(self) -> int:
        Gio.bus_own_name(
            Gio.BusType.SESSION,
            self.bus_name,
            # Never REPLACE and never ALLOW_REPLACEMENT: the mock must lose
            # cleanly rather than fight another process for a name.
            Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
            self._on_bus_acquired,
            self._on_name_acquired,
            self._on_name_lost,
        )
        GLib.timeout_add(250, self._on_tick)
        if not self.args.quiet:
            GLib.timeout_add_seconds(21, self._on_periodic_notify)
        self.loop.run()
        return self.exit_code

    def _on_bus_acquired(self, connection: Gio.DBusConnection, name: str) -> None:
        self.connection = connection
        register = (
            getattr(connection, "register_object_with_closures2", None)
            or getattr(connection, "register_object_with_closures", None)
            or connection.register_object
        )
        self.reg_id = register(
            OBJECT_PATH,
            self.node_info.interfaces[0],
            self._on_method_call,
            None,
            None,
        )

    def _on_name_acquired(self, connection, name) -> None:
        log(f"owning {name}")
        log(f"point the UI at it with HALYARD_BUS_NAME={name}")
        log(f"signed {'in' if self.state.logged_in else 'out'}; "
            f"{len(self.state.pairs)} pairs, "
            f"{len(self.state.conflicts)} conflicts")

    def _on_name_lost(self, connection, name) -> None:
        # With DO_NOT_QUEUE this means somebody else already owns the name.
        log(f"could not take {name} — another process already owns it.")
        log("Refusing to fight over the bus name. Exiting.")
        self.exit_code = 1
        self.loop.quit()

    # -- signal emission -------------------------------------------------

    def emit(self, signal: str, payload) -> None:
        if self.connection is None:
            return
        body = payload if isinstance(payload, str) else json.dumps(payload)
        self.connection.emit_signal(
            None, OBJECT_PATH, INTERFACE, signal, GLib.Variant("(s)", [body])
        )

    def emit_status(self) -> None:
        self.emit("StatusChanged", self.state.status())

    def _on_tick(self) -> bool:
        if self.state.tick():
            self.emit_status()
        return True

    def _on_periodic_notify(self) -> bool:
        if not self.state.logged_in:
            return True
        self.emit("Notify", {
            "kind": "info",
            "title": "Sync complete",
            "body": "Work is up to date — 14 files uploaded.",
        })
        return True

    # -- method dispatch -------------------------------------------------

    def _on_method_call(self, connection, sender, object_path, interface_name,
                        method_name, parameters, invocation) -> None:
        args = list(parameters.unpack())
        log(f"call {method_name}{tuple(args) if args else '()'}")
        handler = getattr(self, f"_do_{method_name}", None)
        if handler is None:
            invocation.return_dbus_error(
                "org.freedesktop.DBus.Error.UnknownMethod",
                f"No such method {method_name}",
            )
            return
        try:
            handler(invocation, *args)
        except Exception as exc:  # surfaced to the UI verbatim, as documented
            invocation.return_dbus_error(ERROR_FAILED, str(exc))

    @staticmethod
    def _reply_json(invocation, payload, delay_ms: int = 0) -> None:
        body = json.dumps(payload)

        def send() -> bool:
            invocation.return_value(GLib.Variant("(s)", [body]))
            return False

        if delay_ms:
            GLib.timeout_add(delay_ms, send)
        else:
            send()

    @staticmethod
    def _reply_void(invocation, delay_ms: int = 0) -> None:
        def send() -> bool:
            invocation.return_value(None)
            return False

        if delay_ms:
            GLib.timeout_add(delay_ms, send)
        else:
            send()

    # -- account ---------------------------------------------------------

    def _do_GetAccount(self, invocation) -> None:
        self._reply_json(invocation, self.state.account(), delay_ms=120)

    def _do_BeginLogin(self, invocation) -> None:
        st = self.state
        if st.logged_in:
            invocation.return_dbus_error(ERROR_FAILED, "Already signed in.")
            return
        st.login_pending = True
        url = ("https://account.proton.me/authorize"
               f"?app=halyard&fork={random.randint(10**7, 10**8)}")
        # The real daemon contacts Proton before it can hand back a URL.
        self._reply_json(invocation, {"signInUrl": url}, delay_ms=700)

        def announce_pending() -> bool:
            if st.login_pending:
                self.emit("LoginStateChanged", {"state": "pending", "error": None})
            return False

        GLib.timeout_add(800, announce_pending)

        def finish() -> bool:
            if not st.login_pending:
                return False
            st.login_pending = False
            st.login_timeout = None
            if self.args.login_fails:
                self.emit("LoginStateChanged", {
                    "state": "failed",
                    "error": "The sign-in session expired before it was "
                             "approved. Please try again.",
                })
                return False
            st.logged_in = True
            self.emit("LoginStateChanged", {"state": "success", "error": None})
            self.emit_status()
            self.emit("Notify", {
                "kind": "info",
                "title": "Signed in to Proton Drive",
                "body": f"Connected as {st.email}.",
            })
            return False

        st.login_timeout = GLib.timeout_add_seconds(
            max(self.args.login_delay, 1) + 1, finish
        )

    def _do_CancelLogin(self, invocation) -> None:
        st = self.state
        if st.login_timeout is not None:
            GLib.source_remove(st.login_timeout)
            st.login_timeout = None
        was_pending = st.login_pending
        st.login_pending = False
        self._reply_void(invocation)
        if was_pending:
            self.emit("LoginStateChanged", {"state": "cancelled", "error": None})

    def _do_Logout(self, invocation) -> None:
        self.state.logged_in = False
        self.state.activity = None
        self._reply_void(invocation, delay_ms=300)
        GLib.timeout_add(350, lambda: (self.emit_status(), False)[1])

    # -- pairs -----------------------------------------------------------

    def _do_ListPairs(self, invocation) -> None:
        self._reply_json(invocation, self.state.pairs, delay_ms=150)

    def _do_AddPair(self, invocation, new_pair_json: str) -> None:
        data = json.loads(new_pair_json)
        local = data.get("localPath")
        if not local:
            raise ValueError("localPath is required.")
        if any(p["localPath"] == local for p in self.state.pairs):
            raise ValueError(f"{local} is already synced.")
        excludes = validate_excludes(data.get("excludes") or [])
        pair = {
            "id": f"p_{random.randint(0x1000, 0xffff):04x}",
            "localPath": local,
            "remotePath": data.get("remotePath") or "/",
            "remoteUid": data.get("remoteUid") or "",
            "enabled": True,
            "excludes": excludes,
            "status": "setup",
            "lastSyncAt": None,
            "error": None,
            "stats": {"pending": 0, "conflicts": 0, "filesUp": 0,
                      "filesDown": 0, "bytesUp": 0, "bytesDown": 0},
        }
        self.state.pairs.append(pair)
        self._reply_json(invocation, pair, delay_ms=600)

        def progress() -> bool:
            pair["status"] = "scanning"
            pair["stats"]["pending"] = random.randint(20, 400)
            self.emit_status()
            return False

        GLib.timeout_add_seconds(2, progress)

        def settle() -> bool:
            pair["status"] = "idle"
            pair["stats"]["pending"] = 0
            pair["lastSyncAt"] = now_ms()
            self.emit_status()
            self.emit("Notify", {
                "kind": "info",
                "title": "Folder pair ready",
                "body": f"{os.path.basename(local)} is now syncing with "
                        f"{pair['remotePath']}.",
            })
            return False

        GLib.timeout_add_seconds(7, settle)

    def _do_UpdatePair(self, invocation, pair_id: str, patch_json: str) -> None:
        pair = self.state.find_pair(pair_id)
        if pair is None:
            raise ValueError(f"No folder pair with id {pair_id}.")
        patch = json.loads(patch_json)
        if not isinstance(patch, dict) or not (PATCH_KEYS & set(patch)):
            raise ValueError(
                "The update contained nothing that can be changed."
            )
        if "excludes" in patch:
            # Validated before anything is mutated, so a bad pattern leaves
            # the pair exactly as it was.
            pair["excludes"] = validate_excludes(patch["excludes"])
        for key in ("localPath", "remotePath", "remoteUid", "enabled"):
            if key in patch:
                pair[key] = patch[key]
        if "enabled" in patch:
            if not patch["enabled"]:
                pair["status"] = "paused"
                if (self.state.activity or {}).get("pairId") == pair_id:
                    self.state.activity = None
            elif pair["status"] == "paused":
                pair["status"] = "idle"
        self._reply_json(invocation, pair, delay_ms=250)
        GLib.timeout_add(300, lambda: (self.emit_status(), False)[1])

    def _do_RemovePair(self, invocation, pair_id: str,
                       delete_local_state: bool) -> None:
        pair = self.state.find_pair(pair_id)
        if pair is None:
            raise ValueError(f"No folder pair with id {pair_id}.")
        self.state.pairs.remove(pair)
        self.state.conflicts = [
            c for c in self.state.conflicts if c["pairId"] != pair_id
        ]
        if (self.state.activity or {}).get("pairId") == pair_id:
            self.state.activity = None
        self._reply_void(invocation, delay_ms=400)
        GLib.timeout_add(450, lambda: (self.emit_status(), False)[1])

    def _do_SyncNow(self, invocation, pair_id: str) -> None:
        targets = (
            self.state.pairs if not pair_id
            else [p for p in self.state.pairs if p["id"] == pair_id]
        )
        if pair_id and not targets:
            raise ValueError(f"No folder pair with id {pair_id}.")
        for pair in targets:
            if pair["enabled"] and pair["status"] != "error":
                pair["status"] = "scanning"
        self._reply_void(invocation, delay_ms=200)
        self.emit_status()

        def settle() -> bool:
            for pair in targets:
                if pair["status"] == "scanning":
                    pair["status"] = "idle"
                    pair["lastSyncAt"] = now_ms()
            self.emit_status()
            return False

        GLib.timeout_add_seconds(4, settle)

    def _do_SetPaused(self, invocation, paused: bool) -> None:
        self.state.paused = paused
        for pair in self.state.pairs:
            if paused:
                if pair["status"] in ("syncing", "scanning", "idle"):
                    pair["status"] = "paused"
            elif pair["enabled"] and pair["status"] == "paused":
                pair["status"] = "idle"
        if paused:
            self.state.activity = None
        self._reply_void(invocation, delay_ms=150)
        self.emit_status()

    # -- remote browsing -------------------------------------------------

    def _do_ListRemoteFolders(self, invocation, parent_uid: str) -> None:
        if parent_uid not in self.state.remote_tree:
            raise ValueError("That folder is no longer available in "
                             "Proton Drive.")
        folders = sorted(
            self.state.remote_tree[parent_uid], key=lambda f: f["name"].lower()
        )
        # Deliberately slow: proves the UI stays responsive during the call.
        self._reply_json(invocation, folders, delay_ms=750)

    def _do_CreateRemoteFolder(self, invocation, parent_uid: str,
                               name: str) -> None:
        name = name.strip()
        if not name:
            raise ValueError("Folder name cannot be empty.")
        if "/" in name:
            raise ValueError("Folder names cannot contain “/”.")
        siblings = self.state.remote_tree.setdefault(parent_uid, [])
        if any(f["name"].lower() == name.lower() for f in siblings):
            raise ValueError(f"A folder called “{name}” already exists here.")
        parent_path = ""
        for children in self.state.remote_tree.values():
            for folder in children:
                if folder["uid"] == parent_uid:
                    parent_path = folder["path"]
                    break
        folder = {
            "uid": f"vol_1~node_{random.randint(0x100000, 0xffffff):06x}",
            "name": name,
            "path": f"{parent_path}/{name}",
            "hasChildren": False,
        }
        siblings.append(folder)
        self.state.remote_tree[folder["uid"]] = []
        for children in self.state.remote_tree.values():
            for existing in children:
                if existing["uid"] == parent_uid:
                    existing["hasChildren"] = True
        self._reply_json(invocation, folder, delay_ms=550)

    # -- status and conflicts --------------------------------------------

    def _do_GetStatus(self, invocation) -> None:
        self._reply_json(invocation, self.state.status(), delay_ms=100)

    def _do_ListConflicts(self, invocation, pair_id: str) -> None:
        # An empty pairId means "every pair", matching the SyncNow convention.
        conflicts = [
            c for c in self.state.conflicts
            if not pair_id or c["pairId"] == pair_id
        ]
        self._reply_json(invocation, conflicts, delay_ms=200)

    def _do_ResolveConflict(self, invocation, conflict_id: str,
                            resolution: str) -> None:
        if resolution not in ("keepLocal", "keepRemote", "dismiss"):
            raise ValueError(f"Unknown resolution “{resolution}”.")
        conflict = next(
            (c for c in self.state.conflicts if c["id"] == conflict_id), None
        )
        if conflict is None:
            raise ValueError("That conflict has already been resolved.")
        self.state.conflicts.remove(conflict)
        pair = self.state.find_pair(conflict["pairId"])
        if pair is not None:
            pair["stats"]["conflicts"] = max(
                0, pair["stats"]["conflicts"] - 1
            )
        self._reply_void(invocation, delay_ms=350)
        GLib.timeout_add(400, lambda: (self.emit_status(), False)[1])

    def _do_GetVersion(self, invocation) -> None:
        invocation.return_value(GLib.Variant("(s)", [VERSION]))

    def _do_Quit(self, invocation) -> None:
        self._reply_void(invocation)
        log("Quit requested — exiting")
        GLib.timeout_add(200, lambda: (self.loop.quit(), False)[1])


def log(message: str) -> None:
    print(f"[mock-daemon] {message}", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Mock Halyard sync daemon")
    parser.add_argument("--logged-in", action="store_true",
                        help="start already signed in")
    parser.add_argument("--login-delay", type=int, default=4,
                        help="seconds before a login attempt completes")
    parser.add_argument("--login-fails", action="store_true",
                        help="make login attempts fail")
    parser.add_argument("--offline", action="store_true",
                        help="report the daemon as offline")
    parser.add_argument("--no-activity", action="store_true",
                        help="do not animate a transfer")
    parser.add_argument("--quiet", action="store_true",
                        help="do not emit periodic Notify signals")
    parser.add_argument("--no-pairs", action="store_true",
                        help="start with no folder pairs (empty state)")
    parser.add_argument("--bus-name", default=DEFAULT_BUS_NAME,
                        help=f"bus name to own (default: {DEFAULT_BUS_NAME})")
    parser.add_argument("--allow-production-name", action="store_true",
                        help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.bus_name == PRODUCTION_BUS_NAME and not args.allow_production_name:
        log(f"refusing to own {PRODUCTION_BUS_NAME}: that is the real "
            "daemon's name, and a real daemon is connected to a live "
            "Proton Drive account.")
        log(f"use the default ({DEFAULT_BUS_NAME}) and point the UI at it "
            "with HALYARD_BUS_NAME.")
        return 2

    return MockDaemon(args).run()


if __name__ == "__main__":
    sys.exit(main())
