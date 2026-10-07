#!/usr/bin/env python3
"""Exercise the GTK Trash flow on a fresh private bus, with no Proton access.

    dbus-run-session -- python3 ui/tests/integration_trash_mock.py

Set HALYARD_TEST_SCREENSHOT to capture this test's own GTK window.
All restore operations only change the mock's in-memory fixtures.
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ui"))
os.environ["HALYARD_BUS_NAME"] = "io.github.votton.Halyard.MockDaemon"
os.environ["GSETTINGS_BACKEND"] = "memory"

import halyard  # noqa: E402
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402
from halyard.dbus_client import DaemonClient  # noqa: E402
from halyard.main import _FallbackSettings  # noqa: E402
from halyard.window import HalyardWindow  # noqa: E402

CONTEXT = GLib.MainContext.default()
RESULTS = []
CALLBACK_ERRORS = []


def exception_hook(*args):
    CALLBACK_ERRORS.append("".join(traceback.format_exception(*args)))
    sys.__excepthook__(*args)


sys.excepthook = exception_hook


def pump(seconds=0.05):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while CONTEXT.pending(): CONTEXT.iteration(False)
        time.sleep(0.005)


def wait(predicate, timeout=10):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline: raise AssertionError("Timed out waiting for mock Trash state")
        pump()
    pump()


def check(name, predicate):
    RESULTS.append(bool(predicate))
    print(f"{'PASS' if predicate else 'FAIL'} {name}", flush=True)


def call(method, *args):
    replies, errors = [], []
    method(*args, replies.append, errors.append)
    wait(lambda: replies or errors)
    if errors: raise AssertionError(errors[0])
    return replies[0]


def descendants(widget):
    yield widget
    child = widget.get_first_child()
    while child:
        yield from descendants(child)
        child = child.get_next_sibling()


def respond(dialog, answer):
    label = dialog.get_response_label(answer)
    next(w for w in descendants(dialog) if isinstance(w, Gtk.Button) and w.get_label() == label).emit("clicked")
    pump()


def select(page, *uids):
    names = [page._items[uid].name for uid in uids]
    for row in page._rows:
        row.get_activatable_widget().set_active(row.get_title() in names)


def restore(page, *uids):
    select(page, *uids)
    page._restore.emit("clicked")
    wait(lambda: page._dialog is not None)
    respond(page._dialog, "restore")


def settled(client):
    wait(lambda: not call(client.list_trash_restores)[0].status == "running")
    return call(client.list_trash_restores)[0]


def snapshot(window, path):
    from gi.repository import Graphene
    pump(0.3)
    paintable = Gtk.WidgetPaintable.new(window)
    drawing = Gtk.Snapshot.new()
    paintable.snapshot(drawing, window.get_width(), window.get_height())
    bounds = Graphene.Rect()
    bounds.init(0, 0, window.get_width(), window.get_height())
    window.get_renderer().render_texture(drawing.to_node(), bounds).save_to_png(path)


def scenario(app):
    with tempfile.TemporaryFile(mode="w+") as log:
        mock = subprocess.Popen([sys.executable, str(ROOT / "ui/tests/mock_daemon.py"), "--logged-in", "--quiet", "--no-activity"], stdout=log, stderr=log)
        client, window = DaemonClient(), None
        try:
            client.start()
            wait(lambda: client.available)
            settings = _FallbackSettings()
            settings.set_boolean("close-notice-shown", True)
            window = HalyardWindow(app, client, settings)
            window.set_default_size(760, 850)
            window.present()
            wait(lambda: window.account_logged_in)
            check("Trash is lazy until the menu action is invoked", window._trash_page is None)
            window.lookup_action("trash").activate(None)
            page = window._trash_page
            wait(lambda: not page._loading and len(page._items) == 50)
            check("menu opens a paged Files and folders Trash", page.source == "drive" and page._more.get_visible() and window._nav.get_visible_page() is page)
            if os.environ.get("HALYARD_TEST_SCREENSHOT"): snapshot(window, os.environ["HALYARD_TEST_SCREENSHOT"])
            page._more.emit("clicked")
            wait(lambda: not page._loading and len(page._items) == 56)
            bad = next(row for row in page._rows if row.get_title() == "Unavailable name")
            check("next page appends without duplicates and unverified names cannot be selected", len(page._rows) == 56 and not page._more.get_visible() and not bad.get_activatable_widget().get_sensitive())

            select(page, "report", "collision", "missing")
            page._restore.emit("clicked")
            wait(lambda: page._dialog is not None)
            check("confirmation explains original location and local conflict preservation", "original locations" in page._dialog.get_body() and "conflict copies" in page._dialog.get_body() and page._dialog.get_default_response() == "cancel")
            respond(page._dialog, "cancel")
            check("cancelled confirmation sends no restore", call(client.list_trash_restores) == ())
            restore(page, "report", "collision", "missing")
            job = settled(client)
            check("partial failure preserves success and exposes name-collision/missing-parent reasons", [r.status for r in job.results].count("restored") == 1 and [r.status for r in job.results].count("failed") == 2 and any("name already exists" in (r.item.error or "") for r in job.results) and any("parent is unavailable" in (r.item.error or "") for r in job.results))
            page._job_rows[0].set_expanded(True)
            page._on_jobs(client, (job,))
            check("expanded results show individual errors and stay open across signals", page._job_rows[0].get_expanded() and any(isinstance(w, Adw.ActionRow) and "name already exists" in (w.get_subtitle() or "") for w in descendants(page._job_rows[0])))
            wait(lambda: not page._loading and "report" not in page._items)
            check("completed restore refreshes Trash", "report" not in page._items and "collision" in page._items)

            restore(page, "unknown")
            job = settled(client)
            check("unconfirmed outcome stays distinct from failure and success", job.results[0].status == "unknown" and "Refresh Trash" in job.results[0].item.error)
            wait(lambda: not page._loading)
            restore(page, "folder", "child")
            job = settled(client)
            check("folder and child can be restored together", all(r.status == "restored" for r in job.results))
            wait(lambda: not page._loading)

            archived = [uid for uid in page._items if uid.startswith("archived-")][:10]
            restore(page, *archived)
            wait(lambda: any(r.status == "restored" for r in call(client.list_trash_restores)[0].results))
            job = call(client.list_trash_restores)[0]
            call(client.cancel_trash_restore, job.id)
            job = call(client.list_trash_restores)[0]
            check("cancelling retains confirmed restores and cancels remaining items", job.status == "cancelled" and any(r.status == "restored" for r in job.results) and any(r.status == "cancelled" for r in job.results))

            page.reload()
            page._source.set_selected(1)
            wait(lambda: not page._loading and "live" in page._items)
            check("source switching discards stale Files replies", all(item.source == "photos" for item in page._items.values()))
            restore(page, "live", "album", "photo-folder")
            job = settled(client)
            check("Photos restore includes its video companion, albums and folders", {r.item.uid for r in job.results} == {"live", "companion", "album", "photo-folder"} and all(r.status == "restored" for r in job.results))
            wait(lambda: not page._loading and not page._items)
            check("empty Photos Trash has a clear empty state", page._empty.get_visible())

            page.reload()
            page.deactivate()
            pump(0.3)
            check("loading cancellation ignores late callbacks", not page._loading and not page._loading_box.get_visible() and not page._listing_id)
            page.activate()
            wait(lambda: not page._loading)
            # Hold completion callbacks across an account reset. The actual
            # service's cancellation is covered above; these emulate delayed
            # replies already queued on the GTK client side.
            delayed = {}
            def hold_start(_source, _uids, finished, failed):
                delayed["start_ok"], delayed["start_error"] = finished, failed
            def hold_cancel(_uid, finished, failed):
                delayed["cancel_ok"], delayed["cancel_error"] = finished, failed
            with patch.object(client, "start_trash_restore", hold_start):
                page._start_restore("photos", ["live"])
            cancel_button = Gtk.Button(label="Cancel")
            with patch.object(client, "cancel_trash_restore", hold_cancel):
                page._cancel_restore(cancel_button, "delayed-job")
            call(client.logout)
            wait(lambda: not window.account_logged_in)
            check("sign-out returns home and clears Trash state", window._nav.get_visible_page().get_tag() == "main" and not page._items and not page._job_rows)
            jobs_request = page._jobs_request
            delayed["start_ok"](None)
            delayed["cancel_ok"](None)
            pump()
            check("late restore and cancellation replies after sign-out do not fetch jobs", page._jobs_request == jobs_request)
            delayed["start_error"]("Old restore error")
            delayed["cancel_error"]("Old cancellation error")
            check("late restore errors after sign-out cannot repopulate the page", not page._message.get_visible() and not cancel_button.get_sensitive())
        finally:
            if window: window.destroy()
            client.stop()
            mock.terminate(); mock.wait(timeout=5)
            pump()
            if not all(RESULTS) or CALLBACK_ERRORS:
                log.seek(0); print(log.read(), flush=True)


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    names = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames", None,
                          GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if any(name in names for name in ("io.github.votton.Halyard.Daemon", "io.github.votton.Halyard.MockDaemon")):
        raise SystemExit("Use a fresh dbus-run-session: a Halyard daemon is already on this bus.")
    Adw.init()
    app = Adw.Application(application_id="io.github.votton.Halyard.TrashTest", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.register(None)
    try: scenario(app)
    except Exception:
        check("Trash scenario completes", False)
        traceback.print_exc()
    check("no Python callback exceptions", not CALLBACK_ERRORS)
    print(f"{sum(RESULTS)}/{len(RESULTS)} GTK/mock checks passed", flush=True)
    return not all(RESULTS)


if __name__ == "__main__": sys.exit(main())
