#!/usr/bin/env python3
"""Integration check: the UI's parsers against the REAL daemon's payloads.

The mock daemon proves the UI renders; it cannot prove the UI understands what
the actual Node daemon emits. This closes that gap by calling every read-only
method on the live daemon and feeding each response through the same model
parsers the UI uses.

Read-only by design. It never calls BeginLogin, Logout, AddPair, UpdatePair,
RemovePair, SyncNow, SetPaused, CreateRemoteFolder or ResolveConflict, so it is
safe to run against an account with real data.

    python3 tests/integration_real_daemon.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gi.repository import Gio, GLib  # noqa: E402

from halyard.models import (  # noqa: E402
    Account,
    Conflict,
    Pair,
    RemoteFolder,
    Status,
)

BUS_NAME = "io.github.votton.Halyard.Daemon"
OBJECT_PATH = "/io/github/votton/Halyard/Daemon"
INTERFACE = "io.github.votton.Halyard.Daemon"

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{f' — {detail}' if detail else ''}")


def call(proxy: Gio.DBusProxy, method: str, *args: str) -> str:
    variant = GLib.Variant("(" + "s" * len(args) + ")", args)
    reply = proxy.call_sync(method, variant, Gio.DBusCallFlags.NONE, 30_000, None)
    return reply.unpack()[0]


def main() -> int:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    proxy = Gio.DBusProxy.new_sync(
        bus, Gio.DBusProxyFlags.DO_NOT_AUTO_START, None,
        BUS_NAME, OBJECT_PATH, INTERFACE, None,
    )
    if proxy.get_name_owner() is None:
        print("The real daemon is not running on the session bus.")
        return 2

    print("\nParsing live daemon payloads with the UI's own models\n")

    # --- GetVersion is a bare string, not JSON.
    version = call(proxy, "GetVersion")
    check("GetVersion returns a bare version string", bool(version) and not version.startswith("{"), version)

    # --- Account
    raw_account = call(proxy, "GetAccount")
    account = Account.from_json(json.loads(raw_account))
    check("Account parses", isinstance(account.logged_in, bool), f"logged_in={account.logged_in}")
    if account.logged_in:
        check("Account carries an email when signed in", bool(account.email), account.email or "")

    # --- Status: the payload the whole UI is a function of.
    raw_status = call(proxy, "GetStatus")
    status = Status.from_json(json.loads(raw_status))
    # Models are frozen dataclasses, so collections come back as tuples.
    check("Status parses", isinstance(status.pairs, (list, tuple)), f"{len(status.pairs)} pair(s)")
    check("Status.paused is a bool", isinstance(status.paused, bool), str(status.paused))
    check("Status.activity parses (None when idle)", status.activity is None or hasattr(status.activity, "kind"))

    for pair in status.pairs:
        check(
            f"Pair {pair.id} parses fully",
            bool(pair.local_path) and bool(pair.remote_path) and pair.stats is not None,
            f"{pair.local_path} <-> {pair.remote_path} [{pair.status}]",
        )
        # A status string the UI does not recognise would render as a blank row.
        known = {"setup", "scanning", "syncing", "idle", "paused", "error"}
        check(f"Pair {pair.id} status is a known value", pair.status in known, pair.status)

    # --- ListPairs must agree with the pairs embedded in Status.
    listed = [Pair.from_json(item) for item in json.loads(call(proxy, "ListPairs"))]
    check(
        "ListPairs agrees with Status.pairs",
        {p.id for p in listed} == {p.id for p in status.pairs},
        f"{len(listed)} vs {len(status.pairs)}",
    )

    # --- Conflicts. Empty pairId must mean "all pairs".
    conflicts = [Conflict.from_json(item) for item in json.loads(call(proxy, "ListConflicts", ""))]
    check("ListConflicts('') parses as all pairs", isinstance(conflicts, list), f"{len(conflicts)} conflict(s)")
    for conflict in conflicts:
        known_kinds = {"bothModified", "localDeletedRemoteModified", "remoteDeletedLocalModified"}
        check(
            f"Conflict {conflict.id} parses",
            bool(conflict.path) and conflict.kind in known_kinds,
            f"{conflict.path} ({conflict.kind})",
        )

    # --- The remote folder picker's data source.
    if account.logged_in:
        folders = [RemoteFolder.from_json(item) for item in json.loads(call(proxy, "ListRemoteFolders", ""))]
        check("ListRemoteFolders parses", isinstance(folders, list), f"{len(folders)} folder(s) at root")
        if folders:
            check(
                "RemoteFolder carries uid, name and full path",
                all(f.uid and f.name and f.path.startswith("/") for f in folders),
                folders[0].path,
            )
            # Descend one level to prove lazy expansion works on real data.
            expandable = next((f for f in folders if f.has_children), None)
            if expandable:
                children = [
                    RemoteFolder.from_json(item)
                    for item in json.loads(call(proxy, "ListRemoteFolders", expandable.uid))
                ]
                check(
                    "descending into a folder returns nested paths",
                    all(c.path.startswith(expandable.path + "/") for c in children),
                    f"{expandable.path} -> {len(children)} child folder(s)",
                )

    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("Failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
