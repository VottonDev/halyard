#!/usr/bin/env python3
"""Management controls on real GTK widgets and a private mock D-Bus service.

    GDK_BACKEND=broadway BROADWAY_DISPLAY=:7 dbus-run-session -- \
        python3 ui/tests/integration_photo_management_mock.py

No Proton account, production service, or cloud mutations are used.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile

from integration_photos_mock import (ROOT, CALLBACK_ERRORS, RESULTS, call, check,
    descendants, dialog, loaded, pump, respond, wait)
from halyard.dbus_client import DaemonClient
from halyard.main import _FallbackSettings
from halyard.window import HalyardWindow
from gi.repository import Adw, Gio, GLib, Gtk


def album_form(window, name):
    alert = dialog(window)
    entry = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Adw.EntryRow))
    entry.set_text(name)
    return alert


def rejected(method, *args):
    ok, errors = [], []
    method(*args, ok.append, errors.append)
    wait(lambda: ok or errors)
    return errors[0] if errors else ""


def run_pagination(app):
    log = tempfile.TemporaryFile(mode="w+")
    mock = subprocess.Popen([sys.executable, str(ROOT / "ui/tests/mock_daemon.py"),
        "--logged-in", "--quiet", "--no-activity", "--photo-management-fixture", "--photo-page-change-once"], stdout=log, stderr=log)
    client, window = DaemonClient(), None
    try:
        client.start(); wait(lambda: client.available)
        window = HalyardWindow(app, client, _FallbackSettings())
        window.present(); wait(lambda: window.account_logged_in)
        view, messages = window._photos_view, []
        window.toast = messages.append
        window._views.set_visible_child_name("photos"); loaded(view)
        view._select_button.emit("clicked")
        for photo in view._photos[:2]: view._tile_clicked(photo)
        selected = set(view._selected)
        view.add_to_album(view.selected_items())
        respond(dialog(window), "add")
        wait(lambda: not view._management_busy and not view._loading)
        check("album add clears confirmed selection and keeps selection mode", not view._selected and view._selecting)
        for photo in view._photos[2:4]: view._tile_clicked(photo)
        selected = set(view._selected)
        messages.clear()
        adjustment = view._scrolled.get_vadjustment()
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
        wait(lambda: len(view._photos) > 60 and not view._loading)
        expected = {p.uid for p in call(client.list_photos, {"limit": 100}).photos}
        check("late album event refreshes and completes requested next page", {p.uid for p in view._photos} == expected and len(view._photos) == len(expected))
        check("pagination recovery retains selection without stale-page error", view._selected == selected and view._selecting and not messages and not view._changed_banner.get_revealed())
        call(client.create_photo_album, "Another album")
        wait(lambda: view._changed_banner.get_revealed())
        view._changed_banner.emit("button-clicked"); loaded(view)
        check("explicit gallery refresh retains loaded pages and selection", view._selected == selected and view._selecting and {p.uid for p in view._photos} == expected)
        view._date_button.emit("clicked")
        alert = dialog(window)
        year = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.SpinButton))
        month = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.DropDown))
        year.set_value(2017); month.set_selected(0); respond(alert, "show"); loaded(view)
        check("year jump shows empty result without fetching other years", not view._photos and view._year == "2017" and view._period_banner.get_revealed())
        view._date_button.emit("clicked")
        alert = dialog(window)
        year = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.SpinButton))
        month = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.DropDown))
        year.set_value(2026); month.set_selected(10); respond(alert, "show"); loaded(view)
        from datetime import datetime, timezone
        check("month jump filters capture dates", bool(view._photos) and all(datetime.fromtimestamp(p.capture_time / 1000, timezone.utc).strftime("%Y-%m") == "2026-10" for p in view._photos))
        view._period_banner.emit("button-clicked"); loaded(view); pump(0.2)
        check("all dates restores the full timeline", not view._year and not view._month and not view._period_banner.get_revealed() and len(view._photos) == 60)
        view._select_button.emit("clicked"); view._tile_clicked(view._photos[0])
        selected = set(view._selected)
        call(client.create_photo_album, "Album before scrolling")
        wait(lambda: view._changed_banner.get_revealed())
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
        wait(lambda: len(view._photos) > 60 and not view._loading)
        check("scrolling after a library event refreshes without requiring Reload", view._selected == selected and not view._changed_banner.get_revealed())
        view.reload(); loaded(view); pump(0.2)
        view._select_button.emit("clicked"); view._tile_clicked(view._photos[0])
        selected = set(view._selected)
        original, attempts = client.list_photos, []
        def transient(query, on_ok, on_err):
            if query.get("cursor"):
                attempts.append(query["cursor"])
                if len(attempts) == 1:
                    GLib.timeout_add(200, lambda: (on_err("Temporary page failure"), False)[1])
                    return
            original(query, on_ok, on_err)
        client.list_photos = transient
        window._views.set_visible_child_name("folders")
        wait(lambda: not view._active)
        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
        pump(0.3)
        check("hidden gallery does not fetch pages", not attempts)
        window._views.set_visible_child_name("photos")
        wait(lambda: view._scrolled.get_mapped() and adjustment.get_page_size() > 0)
        for _ in range(10): adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
        wait(lambda: view._page_error)
        pump(0.4)
        check("scroll requests serialize and failures stop automatic retries", len(attempts) == 1 and view._more.get_visible() and view._more.get_label() == "Try again" and view._selected == selected)
        view._more.emit("clicked")
        wait(lambda: len(view._photos) > 60 and not view._loading)
        check("manual page retry resumes browsing and retains selection", len(attempts) == 2 and not view._page_error and not view._more.get_visible() and view._selected == selected)
    finally:
        if window: window.destroy()
        client.stop(); mock.terminate(); mock.wait(timeout=5); pump(0.2)
        log.seek(0)
        if "Traceback" in log.read(): print("Mock pagination scenario had a traceback", file=sys.stderr)
        log.close()


def run(app, empty=False):
    log = tempfile.TemporaryFile(mode="w+")
    flags = ["--logged-in", "--quiet", "--no-activity", "--photo-management-fixture", "--photo-management-errors"]
    if empty: flags = ["--logged-in", "--quiet", "--no-activity", "--no-photos"]
    mock = subprocess.Popen([sys.executable, str(ROOT / "ui/tests/mock_daemon.py"), *flags], stdout=log, stderr=log)
    client, window = DaemonClient(), None
    try:
        client.start(); wait(lambda: client.available)
        window = HalyardWindow(app, client, _FallbackSettings())
        window.present(); wait(lambda: window.account_logged_in)
        messages = []
        original_toast = window.toast
        def toast(message):
            messages.append(message); original_toast(message)
        window.toast = toast
        view = window._photos_view
        window._views.set_visible_child_name("photos"); loaded(view)
        view.show_albums(); loaded(view)
        view._create_album_button.emit("clicked")
        alert = album_form(window, "")
        check("empty album name disables save", not alert.get_response_enabled("save"))
        respond(alert, "cancel")
        check("cancelled creation keeps album list", len(call(client.list_photo_albums)) == (0 if empty else 3))
        view.edit_album()
        respond(album_form(window, "Test album"), "save")
        wait(lambda: not view._management_busy and not view._loading)
        albums = call(client.list_photo_albums)
        created = next(a for a in albums if a.name == "Test album")
        check("create album from empty library" if empty else "create album and refresh listing", created.can_write and created.can_delete and any("Test album" in r.get_title() for r in view._album_rows))
        if empty: return

        viewer = next(a for a in albums if a.uid == "shared-viewer")
        editor = next(a for a in albums if a.uid == "shared-editor")
        view._open_album(viewer); loaded(view)
        check("read-only shared album controls", not view._rename_album_button.get_sensitive() and not view._delete_album_button.get_sensitive())
        shared = view._photos[0]
        view._toggle_selection(); view._tile_clicked(shared)
        check("shared originals cannot be trashed or favourited", not view._trash_button.get_sensitive() and not view._favourite_selection.get_sensitive() and not view._remove_from_album_button.get_sensitive())
        window.open_photo(shared, tuple(view._photos)); preview = window._preview_page
        wait(lambda: preview._texture is not None)
        check("shared preview honours permissions", not preview._favourite_button.get_sensitive() and not preview._trash_button.get_sensitive())
        window.close_photo(); wait(lambda: window._preview_page is None); pump(0.4)
        check("daemon refuses shared viewer rename", "read-only" in rejected(client.rename_photo_album, viewer.uid, "No"))
        check("daemon refuses deletion of shared editor album", "own" in rejected(client.delete_photo_album, editor.uid))
        view._open_album(editor); loaded(view)
        check("shared editor may rename but not delete", view._rename_album_button.get_sensitive() and not view._delete_album_button.get_sensitive())
        view.edit_album(view._album); respond(album_form(window, "Shared renamed"), "save")
        wait(lambda: not view._management_busy and not view._loading)
        check("shared rename retains album navigation", view._album.uid == editor.uid and view._heading.get_label() == "Shared renamed")
        view.remove_from_album([view._photos[0]])
        respond(dialog(window), "remove")
        wait(lambda: not view._management_busy and not view._loading)
        check("remove shared membership keeps photo available", not view._photos and shared.uid in {p.uid for p in call(client.list_photos, {"limit": 100}).photos})

        own = next(a for a in call(client.list_photo_albums) if a.uid == "album-1")
        view._open_album(own); loaded(view)
        album_only = next(p for p in view._photos if p.uid == "photo-1")
        before = call(client.list_photos, {"limit": 100})
        check("album-only original initially outside timeline", album_only.uid not in {p.uid for p in before.photos})
        window.open_photo(album_only, tuple(view._photos)); preview = window._preview_page
        wait(lambda: preview._texture is not None and preview._favourite_button.get_sensitive())
        index = preview._index
        preview._favourite_button.emit("clicked")
        wait(lambda: not view._management_busy and not view._loading and preview._photos[index].favourite)
        check("preview favourite confirms state and preserves preview", window._preview_page is preview and preview._index == index and preview._favourite_button.get_icon_name() == "starred-symbolic")
        check("favouriting album-only photo retains membership and saves timeline", album_only.uid in {p.uid for p in call(client.list_photos, {"limit": 100}).photos} and album_only.uid in {p.uid for p in view._photos})
        preview._favourite_button.emit("clicked")
        wait(lambda: not view._management_busy and not view._loading and not preview._photos[index].favourite)
        check("preview unfavourite confirms server state", preview._favourite_button.get_icon_name() == "non-starred-symbolic")
        view.set_favourites(view._photos[:20], False)
        check("preview exposes cancellation and disables concurrent edits", preview._cancel_button.get_visible() and not preview._favourite_button.get_sensitive())
        preview._cancel_button.emit("clicked")
        wait(lambda: not view._management_busy and not view._loading and not preview._metadata_pending)
        check("preview cancellation keeps navigation and offers per-item details", window._preview_page is preview and preview._index == index and preview._error_details.get_visible())
        window.close_photo(); wait(lambda: window._preview_page is None); pump(0.4)
        view.remove_from_album([album_only]); alert = dialog(window)
        check("remove confirmation assures originals remain", "originals are kept" in alert.get_body() and "saved to your timeline first" in alert.get_body())
        respond(alert, "cancel")
        check("cancelled removal retains membership", album_only.uid in {p.uid for p in call(client.list_photos, {"albumUid": own.uid}).photos})
        view.remove_from_album([album_only]); respond(dialog(window), "remove")
        wait(lambda: not view._management_busy and not view._loading)
        check("confirmed removal changes membership, not original", album_only.uid not in {p.uid for p in view._photos} and call(client.get_photo, album_only.uid).uid == album_only.uid)

        view._open_album(created); loaded(view)
        view.edit_album(view._album); respond(album_form(window, "Renamed album"), "save")
        wait(lambda: not view._management_busy and not view._loading)
        check("rename updates heading without leaving album", view._album.uid == created.uid and view._heading.get_label() == "Renamed album")
        view.show_timeline(); loaded(view)
        view._more.emit("clicked"); loaded(view)
        items = {p.uid: p for p in view._photos}
        view._toggle_selection()
        view._tile_clicked(items["photo-1"]); view._tile_clicked(items["photo-2"])
        selected, count = set(view._selected), len(view._photos)
        view.add_to_album(view.selected_items()); alert = dialog(window)
        picker = alert.get_extra_child()
        choices = [a for a in call(client.list_photo_albums) if a.can_write]
        picker.set_selected(next(i for i, a in enumerate(choices) if a.uid == created.uid))
        respond(alert, "add")
        wait(lambda: not view._management_busy and not view._loading)
        check("partial add clears successes and retains failed selection/paging", view._selected == {"photo-2"} and view._selecting and len(view._photos) == count and any("1 of 2" in m and "Permission denied" in m for m in messages))
        view._management_error_banner.emit("button-clicked")
        alert = dialog(window)
        labels = [w.get_label() for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.Label)]
        check("partial errors identify the failed photo", any(items["photo-2"].name in label and "Permission denied" in label for label in labels))
        respond(alert, "dismiss")
        check("warning can be dismissed without changing results", not view._management_errors and not view._management_error_banner.get_revealed())
        members = call(client.list_photos, {"albumUid": created.uid}).photos
        check("partial add reflects only confirmed membership", {p.uid for p in members} == {"photo-1"})
        view._tile_clicked(items["photo-1"])
        view.set_favourites(view.selected_items(), True)
        wait(lambda: not view._management_busy and not view._loading)
        check("selection favourites handle partial failure", call(client.get_photo, "photo-1").favourite and not call(client.get_photo, "photo-2").favourite and view._selected == selected)
        messages.clear()
        view.set_favourites(view._photos[:20], False)
        wait(lambda: view._management_busy)
        view._cancel_management.emit("clicked")
        wait(lambda: not view._management_busy and not view._loading, timeout=10)
        check("cancel stops remaining work and reports partial outcomes", any("Cancelled." in m for m in messages) and view._selected == selected)
        view.set_favourites(view._photos[:10], False)
        view.show_albums()
        wait(lambda: not view._management_busy and not view._loading)
        check("navigation during a mutation is preserved", view._albums_mode and view._album is None and not view._selected and view._stack.get_visible_child_name() == "albums")

        view._open_album(next(a for a in call(client.list_photo_albums) if a.uid == created.uid)); loaded(view)
        view.delete_album(view._album); alert = dialog(window)
        check("album deletion requires preservation confirmation", "photos remain available" in alert.get_body() and "cannot be undone" in alert.get_body() and alert.get_default_response() == "cancel")
        respond(alert, "cancel")
        check("cancelled album deletion keeps album", any(a.uid == created.uid for a in call(client.list_photo_albums)))
        view.delete_album(view._album); respond(dialog(window), "delete")
        wait(lambda: not view._management_busy and not view._loading)
        check("confirmed album deletion returns to albums and keeps photos", view._albums_mode and not any(a.uid == created.uid for a in call(client.list_photo_albums)) and call(client.get_photo, "photo-1").uid == "photo-1")
        failed_album = call(client.create_photo_album, "Cannot delete")
        view._open_album(failed_album); loaded(view)
        view.delete_album(view._album); respond(dialog(window), "delete")
        wait(lambda: not view._management_busy and not view._loading)
        check("failed preservation keeps album and shows failure", view._album.uid == failed_album.uid and any("Album kept" in m for m in messages))

        view.show_timeline(); loaded(view)
        view.set_favourites(view._photos[:20], False)
        call(client.logout)
        wait(lambda: not window.account_logged_in)
        pump(2.5)
        check("sign-out cancels management and suppresses late gallery state", not view._management_busy and not view._management_id and not view._photos and not view._selected)
    finally:
        if window: window.destroy()
        client.stop(); mock.terminate(); mock.wait(timeout=5); pump(0.2)
        log.seek(0)
        output = log.read()
        if "Traceback" in output: print(output, file=sys.stderr)
        log.close()


def main():
    Adw.init()
    app = Adw.Application(application_id="io.github.votton.Halyard.PhotoManagementTest", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.register(None)
    try:
        run_pagination(app)
        run(app, empty=True)
        run(app)
    except Exception:
        import traceback
        check("management scenario completes", False)
        traceback.print_exc()
    check("no Python callback exceptions", not CALLBACK_ERRORS)
    failed = sum(not ok for _, ok in RESULTS)
    print(f"{len(RESULTS) - failed}/{len(RESULTS)} management checks passed", flush=True)
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
