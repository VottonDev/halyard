#!/usr/bin/env python3
"""Exercise real GTK widgets and D-Bus callbacks against the Photos mock.

Run on a private session bus with a usable GTK display:
    dbus-run-session -- python3 ui/tests/integration_photos_mock.py

The mock simulates transfers and Trash. No Proton account is used. Native file
choosing is replaced with a fixture so this also works with GTK Broadway.
"""

from __future__ import annotations

import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ui"))
os.environ["HALYARD_BUS_NAME"] = "io.github.votton.Halyard.MockDaemon"
os.environ["GSETTINGS_BACKEND"] = "memory"

import halyard  # noqa: E402
from gi.repository import Adw, Gio, GLib, Gtk  # noqa: E402
from halyard.dbus_client import DaemonClient  # noqa: E402
from halyard.main import _FallbackSettings  # noqa: E402
from halyard.window import HalyardWindow  # noqa: E402
from mock_daemon import mock_preview  # noqa: E402

RESULTS = []
CALLBACK_ERRORS = []
CONTEXT = GLib.MainContext.default()


def exception_hook(*args):
    CALLBACK_ERRORS.append("".join(traceback.format_exception(*args)))
    sys.__excepthook__(*args)


sys.excepthook = exception_hook


def pump(seconds=0.2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        while CONTEXT.pending():
            CONTEXT.iteration(False)
        time.sleep(0.01)


def wait(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Timed out waiting for GTK/D-Bus state")
        pump(0.02)
    pump(0.05)


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


def dialog(window):
    wait(lambda: window.get_visible_dialog() is not None)
    return window.get_visible_dialog()


def respond(alert, response):
    label = alert.get_response_label(response)
    control = next(w for w in descendants(alert) if isinstance(w, Gtk.Button) and w.get_label() == label)
    control.emit("clicked")
    pump(0.3)


def loaded(view):
    wait(lambda: view._loaded and not view._loading)
    pump(0.3)


def button(window, job_id, label):
    actions = window._transfers_view._cards[job_id][2]
    widget = next(w for w in descendants(actions) if isinstance(w, Gtk.Button) and w.get_label() == label)
    widget.emit("clicked")
    pump(0.15)


def run_scenario(app, flags, scenario):
    log = tempfile.TemporaryFile(mode="w+")
    mock = subprocess.Popen([sys.executable, str(ROOT / "ui/tests/mock_daemon.py"),
                             "--quiet", "--no-activity", *flags], stdout=log, stderr=log)
    client = DaemonClient()
    window = None
    try:
        client.start()
        wait(lambda: client.available)
        settings = _FallbackSettings()
        settings.set_boolean("close-notice-shown", True)
        window = HalyardWindow(app, client, settings)
        window.present()
        wait(lambda: window._account_logged_in is not None)
        view = window._photos_view
        check(f"{scenario}: opens on Folders without loading Photos", window._views.get_visible_child_name() == "folders" and not view._loaded)
        if scenario == "signed-out":
            check("signed-out: login screen and hidden gallery navigation", window._stack.get_visible_child_name() == "login" and not window._switcher_bar.get_reveal())
            return
        window._views.set_visible_child_name("photos")
        loaded(view)
        if scenario == "empty":
            check("empty gallery", view._stack.get_visible_child_name() == "empty" and not view._photos)
            view.show_albums()
            loaded(view)
            check("empty albums", view._empty.get_title() == "No albums yet")
            return
        if scenario == "offline":
            check("offline error screen", view._stack.get_visible_child_name() == "error" and "connect" in view._error.get_description())
            view.reload()
            loaded(view)
            check("offline retry remains usable", view._stack.get_visible_child_name() == "error")
            return

        check("first page awaits scrolling", len(view._photos) == 60 and view._next_cursor and not view._more.get_visible())
        wait(lambda: len(view._textures) > 0)
        wait(lambda: not view._thumb_busy and not view._thumb_idle and not view._thumb_waiters)
        pictures = [w for w in descendants(view._list) if isinstance(w, Gtk.Picture) and w.get_mapped()]
        check("mapped gallery thumbnails have textures", bool(pictures) and all(p.get_paintable() is not None for p in pictures))
        missing = [p.get_tooltip_text() for p in pictures if p.get_paintable() is None]
        if missing:
            print(f"Missing mapped previews: {missing}; cached textures={len(view._textures)}", flush=True)
        adjustment = view._scrolled.get_vadjustment()
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
        wait(lambda: len(view._photos) == 96 and not view._loading)
        check("scroll paging: 96 unique items and no more button", len(view._photos) == len({p.uid for p in view._photos}) == 96 and not view._more.get_visible())
        adjustment = view._scrolled.get_vadjustment()
        adjustment.set_value(350)
        pump()
        position, revision = adjustment.get_value(), view._request
        window._views.set_visible_child_name("folders")
        pump()
        window._views.set_visible_child_name("photos")
        pump(0.5)
        check("tab revisit preserves paging and scroll", len(view._photos) == 96 and view._request == revision and abs(adjustment.get_value() - position) < 1)
        view._select_button.emit("clicked")
        view._tile_clicked(view._photos[0])
        selected = set(view._selected)
        window.set_default_size(430, 640)
        wait(lambda: view.columns == 2)
        check("narrow resize preserves selection", view._selected == selected and view._selecting and view.columns == 2)
        if view.columns != 2:
            print(f"Narrow allocation: window={window.get_width()}, gallery={view.get_width()}, columns={view.columns}", flush=True)
        window.set_default_size(1000, 700)
        wait(lambda: view.columns == 5)
        check("wide resize preserves selection", view._selected == selected and view.columns == 5)
        view._select_button.emit("clicked")
        view._kind.set_selected(1)
        loaded(view)
        check("favourites filter", len(view._photos) == 20 and all(p.favourite for p in view._photos))
        view._kind.set_selected(2)
        loaded(view)
        check("videos filter", len(view._photos) == 6 and all(p.is_video for p in view._photos))
        view._kind.set_selected(0)
        loaded(view)
        view._search_entry.set_text("IMG_0001")
        wait(lambda: not view._loading and len(view._photos) == 4)
        check("filename search", all("IMG_0001" in p.name for p in view._photos))
        view._search_entry.set_text("no-such-photo")
        wait(lambda: view._stack.get_visible_child_name() == "empty")
        check("no matching photos screen", view._empty.get_title() == "No matching photos")
        view._search_entry.set_text("")
        wait(lambda: not view._loading and len(view._photos) == 60)
        view.show_albums()
        loaded(view)
        check("albums listing", len(view._album_rows) == 1 and view._stack.get_visible_child_name() == "albums")
        view._album_rows[0].emit("activated")
        loaded(view)
        check("album contents", len(view._photos) == 32 and view._heading.get_label() == "Summer")
        view.show_timeline()
        loaded(view)
        still = next(p for p in view._photos if not p.is_video)
        window.open_photo(still, tuple(view._photos))
        preview = window._preview_page
        wait(lambda: preview._texture is not None)
        check("image preview", preview._stack.get_visible_child_name() == "preview")
        preview._zoom_button.emit("clicked")
        check("preview zoom", preview._zoomed and preview._picture.get_size_request()[0] == preview._texture.get_width())
        index = preview._index
        preview._next.emit("clicked")
        wait(lambda: preview._texture is not None)
        check("preview next", preview._index == index + 1)
        preview._previous.emit("clicked")
        wait(lambda: preview._texture is not None)
        check("preview previous", preview._index == index)
        window.close_photo()
        wait(lambda: window._preview_page is None)
        pump(0.5)

        video = next(p for p in view._photos if p.is_video)
        window.open_photo(video, tuple(view._photos))
        pump(0.5)
        window.close_photo()
        window.open_photo(video, tuple(view._photos))
        navigable = window._nav.get_visible_page() is window._preview_page
        check("rapid preview reopen remains navigable", navigable)
        if not navigable:
            window._preview_page.reset()
            window._preview_page = None
            window._nav.pop_to_tag("main")
            pump(0.5)
            window.open_photo(video, tuple(view._photos))
        preview = window._preview_page
        wait(lambda: preview._texture is not None)
        preview._play_button.emit("clicked")
        wait(lambda: preview._media is not None or preview._stack.get_visible_child_name() == "error")
        if preview._media:
            media = preview._media
            wait(lambda: media.is_prepared() or media.get_error() is not None, timeout=12)
            check("video backend prepared", media.is_prepared() and media.get_error() is None)
            uri = preview._video_session.uri
            with urlopen(Request(uri, headers={"Range": "bytes=0-63"})) as response:
                check("video HTTP seek range", response.status == 206 and len(response.read()) == 64)
            media.pause()
            check("video pause", not media.get_playing())
            if media.is_seekable():
                media.seek(media.get_duration() // 2)
                wait(lambda: not media.is_seeking())
                check("video forward seek", abs(media.get_timestamp() - media.get_duration() // 2) < 500000)
                media.seek(0)
                wait(lambda: not media.is_seeking())
                check("video backward seek", media.get_timestamp() < 500000)
            else:
                check("video seekable", False)
            media.play()
            pump(0.2)
            check("video resume", media.get_playing())
            window.close_photo()
            wait(lambda: window._preview_page is None)
            pump(0.5)
            try:
                urlopen(uri).close()
                released = False
            except HTTPError as error:
                released = error.code == 404
            check("leaving video releases stream", preview._media is None and released)
        else:
            check("video playback", False)
            print(preview._error.get_description(), flush=True)
            window.close_photo()
            wait(lambda: window._preview_page is None)
            pump(0.5)

        photo = view._photos[0]
        before = call(client.list_photos, {"limit": 100})
        view.trash_items([photo])
        respond(dialog(window), "cancel")
        pump()
        after = call(client.list_photos, {"limit": 100})
        check("Trash cancellation keeps photo", len(before.photos) == len(after.photos))
        view.trash_items([photo])
        respond(dialog(window), "trash")
        wait(lambda: not view._loading and photo.uid not in {p.uid for p in view._photos})
        check("confirmed Trash refreshes gallery", photo.uid not in {p.uid for p in call(client.list_photos, {"limit": 100}).photos})
        photo = view._photos[0]
        window.open_photo(photo, tuple(view._photos))
        window.trash_photos([photo])
        respond(dialog(window), "trash")
        wait(lambda: window._preview_page is None and not view._loading)
        check("Trash from preview closes preview", photo.uid not in {p.uid for p in view._photos})

        settings.set_string("photo-download-folder", window.folder_pairs[1].local_path)
        linked = next(p for p in call(client.list_photos, {"limit": 100}).photos if p.related_uids)
        view.download_items([linked])
        download_dialog = dialog(window)
        labels = [w.get_label() for w in descendants(download_dialog.get_extra_child()) if isinstance(w, Gtk.Label)]
        check("download warns about synced destination", any("will also sync to Proton Drive, unless excluded" in label for label in labels))
        respond(download_dialog, "download")
        wait(lambda: len(window._transfers_view.downloads) == 1)
        job = window._transfers_view.downloads[0]
        check("download includes linked asset", len(job.files) == 2)
        window._show_photo_transfers()
        pump()
        button(window, job.id, "Pause")
        wait(lambda: window._transfers_view.downloads[0].status == "paused")
        check("transfer pause", window._transfer_bar.get_revealed())
        button(window, job.id, "Resume")
        wait(lambda: window._transfers_view.downloads[0].status in ("queued", "downloading"))
        check("transfer resume", True)
        button(window, job.id, "Cancel")
        wait(lambda: window._transfers_view.downloads[0].status == "cancelled")
        check("transfer cancel", True)
        button(window, job.id, "Retry")
        wait(lambda: window._transfers_view.downloads[0].status in ("queued", "downloading"))
        check("transfer retry", True)
        call(client.control_photo_download, job.id, "pause")

        with tempfile.TemporaryDirectory(prefix="halyard-photo-ui-test-", dir=Path.home()) as folder:
            image = Path(folder) / "test-image.png"
            image.write_bytes(base64.b64decode(mock_preview(1)))
            selected_files = Gio.ListStore.new(Gio.File)
            selected_files.append(Gio.File.new_for_path(str(image)))
            class FixtureChooser:
                def __init__(self, **kwargs): pass
                def set_filters(self, *args): pass
                def set_default_filter(self, *args): pass
                def open_multiple_finish(self, result): return selected_files
                def open_multiple(self, parent, cancellable, callback): callback(self, None)
            with patch("halyard.photos_view.Gtk.FileDialog", FixtureChooser):
                view._choose_upload()
                upload_dialog = dialog(window)
                check("upload preparation and confirmation", upload_dialog.get_heading() == "Upload photo")
                respond(upload_dialog, "upload")
                wait(lambda: len(window._transfers_view.uploads) == 1)
            check("upload keeps local original", image.read_bytes() == base64.b64decode(mock_preview(1)))
            upload = window._transfers_view.uploads[0]
            button(window, upload.id, "Pause")
            wait(lambda: window._transfers_view.uploads[0].status == "paused")
            button(window, upload.id, "Resume")
            wait(lambda: window._transfers_view.uploads[0].status == "completed", timeout=15)
            check("upload completion offers Reload", view._changed_banner.get_revealed())
            window._views.set_visible_child_name("photos")
            view.reload()
            loaded(view)
            check("completed upload appears in gallery", any(p.name == image.name for p in view._photos))

        window.close()
        pump()
        check("closing window keeps transfer", not window.get_visible() and call(client.list_photo_downloads)[0].status == "paused")
        client.stop()
        client = DaemonClient()
        client.start()
        wait(lambda: client.available)
        window = HalyardWindow(app, client, settings)
        window.present()
        wait(lambda: window.account_logged_in and window._transfers_view._loaded)
        view = window._photos_view
        check("reopening starts on Folders", window._views.get_visible_child_name() == "folders")
        window._views.set_visible_child_name("photos")
        loaded(view)
        video = next(p for p in view._photos if p.is_video)
        window.open_photo(video, tuple(view._photos))
        preview = window._preview_page
        preview._play_button.emit("clicked")
        pump(0.3)
        call(client.logout)
        wait(lambda: not window.account_logged_in)
        check("sign-out clears photos, selections, jobs and preview", not view._photos and not view._selected and not window._transfers_view.downloads and not window._transfers_view.uploads and window._preview_page is None)
        check("sign-out closes video", preview._media is None and preview._video_session is None)
    finally:
        if window:
            window.destroy()
        client.stop()
        mock.terminate()
        mock.wait(timeout=5)
        pump(0.2)
        log.close()


def main():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    names = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames", None, GLib.VariantType.new("(as)"), Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if "io.github.votton.Halyard.Daemon" in names or "io.github.votton.Halyard.MockDaemon" in names:
        raise SystemExit("Use a fresh dbus-run-session: a Halyard daemon is already on this bus.")
    Adw.init()
    app = Adw.Application(application_id="io.github.votton.Halyard.PhotosTest", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.register(None)
    for scenario, flags in (("gallery", ["--logged-in"]), ("empty", ["--logged-in", "--no-photos"]), ("offline", ["--logged-in", "--offline"]), ("signed-out", [])):
        try:
            run_scenario(app, flags, scenario)
        except Exception:
            check(f"{scenario}: completes", False)
            traceback.print_exc()
    check("no Python callback exceptions", not CALLBACK_ERRORS)
    failed = sum(not ok for _, ok in RESULTS)
    print(f"{len(RESULTS) - failed}/{len(RESULTS)} GTK/mock checks passed", flush=True)
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
