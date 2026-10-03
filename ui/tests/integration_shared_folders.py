#!/usr/bin/env python3
"""Exercise the shared-folder picker on a private bus, without a Proton account.

Run with a usable GTK display:
    dbus-run-session -- python3 ui/tests/integration_shared_folders.py

Set HALYARD_TEST_SCREENSHOT to a PNG path to render the mock root picker.
Only the mock daemon is used; creating a folder here changes in-memory fixtures.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ui"))
os.environ["HALYARD_BUS_NAME"] = "io.github.votton.Halyard.MockDaemon"
os.environ["GSETTINGS_BACKEND"] = "memory"

import halyard  # noqa: E402
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402
from halyard.dbus_client import DaemonClient  # noqa: E402
from halyard.pair_dialog import PairDialog, RemoteFolderPage  # noqa: E402

RESULTS = []
CALLBACK_ERRORS = []
CONTEXT = GLib.MainContext.default()


def exception_hook(*args):
    CALLBACK_ERRORS.append("".join(traceback.format_exception(*args)))
    sys.__excepthook__(*args)


sys.excepthook = exception_hook


def pump(seconds=0.1):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while CONTEXT.pending():
            CONTEXT.iteration(False)
        time.sleep(0.005)


def wait(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out waiting for GTK/D-Bus state")
        pump(0.02)
    pump()


def check(name, predicate):
    ok = bool(predicate)
    RESULTS.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'} {name}", flush=True)


def call(method, *args):
    result, error = [], []
    method(*args, result.append, error.append)
    wait(lambda: result or error)
    if error:
        raise AssertionError(error[0])
    return result[0]


def descendants(widget):
    yield widget
    child = widget.get_first_child()
    while child:
        yield from descendants(child)
        child = child.get_next_sibling()


def loaded(dialog):
    page = dialog._nav.get_visible_page()
    wait(lambda: isinstance(page, RemoteFolderPage) and
         page._stack.get_visible_child_name() in ("list", "empty", "error"))
    if page._stack.get_visible_child_name() == "error":
        raise AssertionError(page._error_page.get_description())
    return page


def row(page, title):
    return next(row for _, row in page._rows if row.get_title() == title)


def browse(dialog):
    dialog._on_browse_remote()
    return loaded(dialog)


def render_picker(window, path):
    """Capture this test's GTK surface, rather than other desktop content."""
    from gi.repository import Graphene
    pump(0.4)
    paintable = Gtk.WidgetPaintable.new(window)
    snapshot = Gtk.Snapshot.new()
    paintable.snapshot(snapshot, window.get_width(), window.get_height())
    node = snapshot.to_node()
    bounds = Graphene.Rect()
    bounds.init(0, 0, window.get_width(), window.get_height())
    texture = window.get_renderer().render_texture(node, bounds)
    texture.save_to_png(str(path))
    print(f"Screenshot: {path}", flush=True)


def run_scenario(app):
    with tempfile.TemporaryFile(mode="w+") as log:
        mock = subprocess.Popen(
            [sys.executable, str(ROOT / "ui/tests/mock_daemon.py"),
             "--logged-in", "--quiet", "--no-activity"], stdout=log, stderr=log,
        )
        client = DaemonClient()
        window = None
        try:
            client.start()
            wait(lambda: client.available)
            window = Adw.ApplicationWindow(application=app)
            window.set_default_size(780, 980)
            window.set_content(Gtk.Box())
            window.present()
            dialog = PairDialog(client, window, [])
            dialog.set_content_width(600)
            dialog.set_content_height(930)
            dialog.present(window)
            root = browse(dialog)

            folders = call(client.list_remote_folders, "")
            own = [f for f in folders if not f.shared_with_me]
            shares = [f for f in folders if f.shared_with_me]
            check("root lists owned folders before accepted shares",
                  len(own) == 5 and len(shares) == 2 and folders == own + shares)
            check("root separates and labels Shared with me below My Files",
                  root._group.get_title() == "My Files" and
                  root._shared_group.get_title() == "Shared with me" and
                  root._shared_group.get_visible() and
                  all(group is root._group for group, _ in root._rows[:len(own)]) and
                  all(group is root._shared_group for group, _ in root._rows[len(own):]) and
                  list(w for w in descendants(root) if isinstance(w, Adw.PreferencesGroup)) ==
                  [root._group, root._shared_group])
            check("Trips is clearly labelled editable and Reference read-only",
                  row(root, "Trips").get_subtitle() == "Can edit" and
                  "Read-only" in row(root, "Reference").get_subtitle() and
                  row(root, "Trips").get_tooltip_text() == "/Shared with me/Trips")

            screenshot = os.environ.get("HALYARD_TEST_SCREENSHOT")
            if screenshot:
                render_picker(window, Path(screenshot))

            before = [(group, r.get_title()) for group, r in root._rows]
            root.load(force=True)
            loaded(dialog)
            check("root reload replaces rows without duplicates",
                  [(group, r.get_title()) for group, r in root._rows] == before)

            row(root, "Trips").emit("activated")
            trips = loaded(dialog)
            check("editable Trips can sync and create folders",
                  trips.get_title() == "Trips" and trips._select_button.get_sensitive() and
                  trips._new_folder.get_sensitive() and trips._banner.get_revealed() and
                  trips._banner.get_title() == "Shared with you · Can edit")
            row(trips, "Summer").emit("activated")
            summer = loaded(dialog)
            check("nested share keeps its full labelled path and editing access",
                  summer._path == "/Shared with me/Trips/Summer" and
                  summer._select_button.get_sensitive() and summer._new_folder.get_sensitive() and
                  summer._banner.get_title() == "Shared with you · Can edit")
            dialog._set_create_remote("Pending folder")
            summer._select_button.emit("clicked")
            pump()
            check("selecting nested share stores uid/path and clears pending creation",
                  dialog._remote_uid == "vol_shared~summer" and
                  dialog._remote_path == "/Shared with me/Trips/Summer" and
                  dialog._remote_row.get_subtitle() == "/Shared with me/Trips/Summer" and
                  not dialog._create_remote and not dialog._remote_name and
                  dialog._nav.get_navigation_stack().get_n_items() == 1)

            root = browse(dialog)
            row(root, "Reference").emit("activated")
            reference = loaded(dialog)
            check("read-only Reference remains browsable with sync/create disabled",
                  reference.get_title() == "Reference" and
                  reference._stack.get_visible_child_name() == "empty" and
                  not reference._select_button.get_sensitive() and
                  not reference._new_folder.get_sensitive() and
                  "Read-only" in reference._banner.get_title())
            selection = (dialog._remote_uid, dialog._remote_path)
            reference._select_button.emit("clicked")
            reference._new_folder.emit("clicked")
            pump()
            check("read-only callbacks do not change selection or open create dialog",
                  selection == (dialog._remote_uid, dialog._remote_path) and
                  window.get_visible_dialog() is dialog)
            errors, results = [], []
            client.create_remote_folder("vol_shared~reference", "Forbidden", results.append, errors.append)
            wait(lambda: errors or results)
            check("mock rejects direct creation in a read-only share",
                  not results and "read-only" in errors[0])

            dialog._nav.pop()
            pump()
            row(root, "Trips").emit("activated")
            trips = loaded(dialog)
            created = []
            original_create = client.create_remote_folder

            def record_create(parent_uid, name, on_ok, on_err):
                def recorded(folder):
                    created.append(folder)
                    on_ok(folder)
                original_create(parent_uid, name, recorded, on_err)

            client.create_remote_folder = record_create
            trips._new_folder.emit("clicked")
            wait(lambda: window.get_visible_dialog() is not dialog)
            alert = window.get_visible_dialog()
            entry = next(w for w in descendants(alert) if isinstance(w, Adw.EntryRow))
            entry.set_text("Autumn")
            label = alert.get_response_label("create")
            next(w for w in descendants(alert) if isinstance(w, Gtk.Button) and
                 w.get_label() == label).emit("clicked")
            wait(lambda: created and any(r.get_title() == "Autumn" for _, r in trips._rows))
            check("create inside Trips propagates sharing metadata and full path",
                  created[0].shared_with_me and created[0].can_write and
                  created[0].path == "/Shared with me/Trips/Autumn" and
                  row(trips, "Autumn").get_subtitle() == "Can edit" and
                  row(trips, "Autumn").get_tooltip_text() == "/Shared with me/Trips/Autumn")
            check("creating a shared folder preserves the sharing status banner",
                  trips._banner.get_revealed() and
                  trips._banner.get_title() == "Shared with you · Can edit")
            trips.load(force=True)
            loaded(dialog)
            check("shared-folder reload preserves one instance of created folder",
                  sorted(r.get_title() for _, r in trips._rows) == ["Autumn", "Summer"])
            row(trips, "Autumn").emit("activated")
            autumn = loaded(dialog)
            check("newly created shared folder remains selectable",
                  autumn._banner.get_revealed() and autumn._select_button.get_sensitive())
            autumn._select_button.emit("clicked")
            pump()
            check("choosing a created shared folder preserves its uid and path",
                  dialog._remote_uid == created[0].uid and
                  dialog._remote_path == created[0].path and
                  dialog._nav.get_navigation_stack().get_n_items() == 1)
            dialog.close()
            pump()
        finally:
            if window:
                window.destroy()
            client.stop()
            mock.terminate()
            mock.wait(timeout=5)
            pump()
            if any(not ok for _, ok in RESULTS) or CALLBACK_ERRORS:
                log.seek(0)
                print(log.read(), flush=True)


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    names = bus.call_sync(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "ListNames", None, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE,
        3000, None,
    ).unpack()[0]
    if any(name in names for name in
           ("io.github.votton.Halyard.Daemon", "io.github.votton.Halyard.MockDaemon")):
        raise SystemExit("Use a fresh dbus-run-session: a Halyard daemon is already on this bus.")
    Adw.init()
    app = Adw.Application(application_id="io.github.votton.Halyard.SharedFoldersTest",
                          flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.register(None)
    try:
        run_scenario(app)
    except Exception:
        check("shared-folder scenario completes", False)
        traceback.print_exc()
    check("no Python callback exceptions", not CALLBACK_ERRORS)
    failed = sum(not ok for _, ok in RESULTS)
    print(f"{len(RESULTS) - failed}/{len(RESULTS)} GTK/mock checks passed", flush=True)
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
