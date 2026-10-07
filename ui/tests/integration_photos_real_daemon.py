#!/usr/bin/env python3
"""Photos integration checks against a signed-in daemon built from this checkout.

Read-only by default. --writes uploads four generated test images, downloads
them, tests duplicates and filename collisions, and moves only its new images
to Proton Trash. Run that option only with the account owner's authorization.
Sources/downloads are retained in a unique folder under the user's home.
Requires the UI's system dependencies and Pillow; --gtk also needs a display.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from gi.repository import Gio, GLib  # noqa: E402
from halyard import __version__  # noqa: E402
from halyard.models import Photo, PhotoAlbum, PhotoPage, PhotoThumbnail, PhotoDownload, VideoPreview  # noqa: E402

BUS = "io.github.votton.Halyard.Daemon"
OBJECT = "/io/github/votton/Halyard/Daemon"
RESULTS = []
CREATED = set()
TRASHED = set()
JOBS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""), flush=True)


def call(proxy, method, *args):
    parameters = GLib.Variant("(" + "s" * len(args) + ")", args)
    value = proxy.call_sync(method, parameters, Gio.DBusCallFlags.NONE, 120_000, None)
    if value.n_children() == 0:
        return None
    raw = value.unpack()[0]
    return raw if method == "GetVersion" else json.loads(raw)


def finish(proxy, kind, job):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        current = next(j for j in call(proxy, "ListPhoto" + kind + "s") if j["id"] == job["id"])
        if current["status"] in ("completed", "failed", "cancelled"):
            for item in current["files"]:
                if kind == "Upload" and item["status"] == "completed":
                    CREATED.add(item["uid"])
                if item.get("error"):
                    print(f"Transfer error for generated test file: {item['error']}", flush=True)
            return current
        time.sleep(0.4)
    raise TimeoutError("Photo transfer did not finish within three minutes")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_checks(proxy):
    page = PhotoPage.from_json(call(proxy, "ListPhotos", json.dumps({"limit": 12})))
    check("gallery parses", isinstance(page.photos, tuple), f"{len(page.photos)} items on first page")
    check("gallery entries decrypt", all(not p.error for p in page.photos))
    check("gallery is newest first", all(a.capture_time >= b.capture_time for a, b in zip(page.photos, page.photos[1:])))
    if page.next_cursor:
        second = PhotoPage.from_json(call(proxy, "ListPhotos", json.dumps({"limit": 12, "cursor": page.next_cursor})))
        check("gallery pagination has no repeated items", not ({p.uid for p in page.photos} & {p.uid for p in second.photos}))
    albums = tuple(PhotoAlbum.from_json(a) for a in call(proxy, "ListPhotoAlbums"))
    check("albums parse", isinstance(albums, tuple), f"{len(albums)} albums")
    if albums:
        album = PhotoPage.from_json(call(proxy, "ListPhotos", json.dumps({"limit": 3, "albumUid": albums[0].uid})))
        check("album contents parse", all(isinstance(p, Photo) for p in album.photos))
    if page.photos:
        photo = page.photos[0]
        got = Photo.from_json(call(proxy, "GetPhoto", photo.uid))
        check("single-photo metadata agrees with gallery", got == photo)
        previews = tuple(PhotoThumbnail.from_json(t) for t in call(proxy, "GetPhotoThumbnails", json.dumps({"uids": [p.uid for p in page.photos[:3]]})))
        check("thumbnail replies contain image bytes", bool(previews) and all(t.data and not t.error for t in previews))
        from PIL import Image
        from io import BytesIO
        for thumb in previews:
            if thumb.data:
                Image.open(BytesIO(base64.b64decode(thumb.data))).verify()
        check("thumbnails decode", all(t.data for t in previews))
    favourite = PhotoPage.from_json(call(proxy, "ListPhotos", json.dumps({"limit": 2, "kind": "favourites"})))
    check("favourites filter", all(p.favourite for p in favourite.photos))
    videos = PhotoPage.from_json(call(proxy, "ListPhotos", json.dumps({"limit": 1, "kind": "videos"})))
    check("video filter", all(p.is_video for p in videos.photos))
    if videos.photos:
        preview = VideoPreview.from_json(call(proxy, "StartVideoPreview", videos.photos[0].uid))
        try:
            if not preview.uri or not preview.size:
                check("real video stream ready", False)
                return
            with urlopen(Request(preview.uri, method="HEAD"), timeout=60) as response:
                check("real video HEAD", response.status == 200 and int(response.headers["Content-Length"]) == preview.size)
            for name, offset in (("start", 0), ("middle", preview.size // 2)):
                end = min(preview.size - 1, offset + 1023)
                with urlopen(Request(preview.uri, headers={"Range": f"bytes={offset}-{end}"}), timeout=60) as response:
                    check(f"real video seek range at {name}", response.status == 206 and len(response.read()) == end - offset + 1)
        except Exception as error:
            check("real video streaming", False, str(error))
        finally:
            call(proxy, "ReleaseVideoPreview", preview.id)
        try:
            urlopen(preview.uri, timeout=10).close()
            check("video capability revoked after release", False)
        except HTTPError as error:
            check("video capability revoked after release", error.code == 404)
    else:
        print("SKIP real video: none in the bounded filtered page", flush=True)


def generated_inputs(folder):
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
    from PIL import Image, ImageDraw
    paths, inputs, expected = [], [], {}
    marker = folder.name
    for index, (extension, format_name) in enumerate((("jpg", "JPEG"), ("png", "PNG"), ("webp", "WEBP"), ("jpg", "JPEG"))):
        directory = folder / ("variant" if index == 3 else "sources")
        directory.mkdir(exist_ok=True)
        name = f"{marker}-{'jpg' if index == 3 else extension}.{extension}"
        path = directory / name
        image = Image.new("RGB", (640, 480), ((index * 59 + 23) % 256, 140, 205))
        ImageDraw.Draw(image).text((25, 25), f"Halyard Photos integration test {index}", fill="white")
        exif = Image.Exif()
        exif[274] = 6 if index == 0 else 1
        exif[34665] = {36867: "2026:01:15 12:00:00"}
        image.save(path, format_name, **({"exif": exif} if extension == "jpg" else {}))
        mtime = datetime(2026, 1, 16 + min(index, 2), 12, tzinfo=timezone.utc).timestamp()
        os.utime(path, (mtime, mtime))
        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), 2048, 2048, True).apply_embedded_orientation()
        thumbnails = []
        for kind, bound in ((1, 256), (2, 2048)):
            ratio = min(1, bound / max(pixbuf.get_width(), pixbuf.get_height()))
            scaled = pixbuf.scale_simple(max(1, int(pixbuf.get_width() * ratio)), max(1, int(pixbuf.get_height() * ratio)), GdkPixbuf.InterpType.BILINEAR)
            ok, data = scaled.save_to_bufferv("jpeg", ["quality"], ["85"])
            if not ok:
                raise ValueError("Could not create generated-image thumbnail")
            thumbnails.append({"type": kind, "data": base64.b64encode(data).decode()})
        inputs.append({"path": str(path), "thumbnails": thumbnails})
        paths.append(path)
        expected[str(path)] = (digest(path), int((datetime(2026, 1, 15, 12, tzinfo=timezone.utc).timestamp() if extension == "jpg" else mtime) * 1000))
    return paths, inputs, expected


def gtk_checks(video_name=None, scroll=False):
    os.environ["HALYARD_BUS_NAME"] = BUS
    from gi.repository import Adw, Gtk
    from halyard.dbus_client import DaemonClient
    from halyard.main import _FallbackSettings
    from halyard.window import HalyardWindow
    context = GLib.MainContext.default()
    def wait(predicate):
        deadline = time.monotonic() + 90
        while not predicate():
            if time.monotonic() > deadline:
                raise TimeoutError("Real-account GTK state did not become ready")
            while context.pending():
                context.iteration(False)
            time.sleep(0.01)
    def descendants(widget):
        child = widget.get_first_child()
        while child:
            yield child
            yield from descendants(child)
            child = child.get_next_sibling()
    def pump(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            while context.pending(): context.iteration(False)
            time.sleep(0.01)
    Adw.init()
    app = Adw.Application(application_id="io.github.votton.Halyard.LivePhotosTest", flags=Gio.ApplicationFlags.NON_UNIQUE)
    app.register(None)
    client = DaemonClient()
    client.start()
    window = None
    try:
        wait(lambda: client.available)
        settings = _FallbackSettings()
        settings.set_boolean("close-notice-shown", True)
        window = HalyardWindow(app, client, settings)
        window.present()
        wait(lambda: window.account_logged_in)
        window._views.set_visible_child_name("photos")
        view = window._photos_view
        wait(lambda: view._loaded and not view._loading)
        check("real gallery opens in GTK", view._stack.get_visible_child_name() in ("photos", "empty"))
        if not view._photos:
            return
        wait(lambda: bool(view._textures))
        wait(lambda: not view._thumb_idle and not view._thumb_busy and not view._thumb_waiters)
        pictures = [w for w in descendants(view._list) if isinstance(w, Gtk.Picture) and w.get_mapped()]
        check("real thumbnails paint on first load", bool(pictures) and any(p.get_paintable() for p in pictures))
        if scroll:
            view._select_button.emit("clicked")
            view._tile_clicked(view._photos[0])
            selected = set(view._selected)
            adjustment = view._scrolled.get_vadjustment()
            wait(lambda: adjustment.get_page_size() > 0)
            for index in range(3):
                if not view._next_cursor: break
                wait(lambda: view._scroll_restore_position is None)
                before = len(view._photos)
                started = time.monotonic()
                adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size() - 100)
                wait(lambda: (len(view._photos) > before and not view._loading) or view._page_error or not view._next_cursor)
                check(f"real scroll appends page {index + 1}", not view._page_error and len(view._photos) > before and not view._more.get_visible(), f"{len(view._photos)} photos; {time.monotonic() - started:.2f}s")
                check("real scroll retains unique photos and selection", len({p.uid for p in view._photos}) == len(view._photos) and view._selected == selected and view._selecting)
                wait(lambda: not view._thumb_idle and not view._thumb_busy and not view._thumb_waiters)
            wait(lambda: view._scroll_restore_position is None)
            view._tile_clicked(view._photos[-10])
            selected, extent = set(view._selected), len(view._photos)
            anchor = view._selection_anchor
            adjustment.set_value((adjustment.get_upper() - adjustment.get_page_size()) * 0.6)
            pump(0.4)
            position = adjustment.get_value()
            view.reload(preserve=True)
            wait(lambda: not view._loading and view._scroll_restore_position is None)
            check("real refresh retains deep position and loaded selection", len(view._photos) >= extent and view._selected == selected and view._selection_anchor == anchor and abs(adjustment.get_value() - position) < 2, f"offset {position:.0f} → {adjustment.get_value():.0f}")
            view._select_button.emit("clicked")
            view._date_button.emit("clicked")
            wait(lambda: window.get_visible_dialog() is not None)
            alert = window.get_visible_dialog()
            year = next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.SpinButton))
            year.set_value(2017)
            started = time.monotonic()
            next(w for w in descendants(alert) if isinstance(w, Gtk.Button) and w.get_label() == alert.get_response_label("show")).emit("clicked")
            wait(lambda: view._year == "2017" and not view._loading)
            check("real year jump shows only the requested year", not view._page_error and all(datetime.fromtimestamp(p.capture_time / 1000, timezone.utc).year == 2017 for p in view._photos), f"{len(view._photos)} photos; {time.monotonic() - started:.2f}s")
            if view._photos:
                period = datetime.fromtimestamp(view._photos[0].capture_time / 1000, timezone.utc).strftime("%Y-%m")
                view._date_button.emit("clicked")
                wait(lambda: window.get_visible_dialog() is not None)
                alert = window.get_visible_dialog()
                next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.SpinButton)).set_value(int(period[:4]))
                next(w for w in descendants(alert.get_extra_child()) if isinstance(w, Gtk.DropDown)).set_selected(int(period[-2:]))
                next(w for w in descendants(alert) if isinstance(w, Gtk.Button) and w.get_label() == alert.get_response_label("show")).emit("clicked")
                wait(lambda: view._month == period and not view._loading)
                for _ in range(10):
                    if not view._next_cursor: break
                    wait(lambda: view._scroll_restore_position is None)
                    cursor = view._next_cursor
                    adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
                    view._schedule_scroll_load()
                    wait(lambda: not view._loading and (view._next_cursor != cursor or view._page_error))
                    if view._page_error: break
                check("real month jump includes only the requested month", bool(view._photos) and not view._page_error and all(datetime.fromtimestamp(p.capture_time / 1000, timezone.utc).strftime("%Y-%m") == period for p in view._photos), f"{len(view._photos)} photos in {period}")
                if not view._next_cursor:
                    wait(lambda: view._scroll_restore_position is None)
                    original, requests = client.list_photos, []
                    def counted(query, on_ok, on_err):
                        requests.append(query); original(query, on_ok, on_err)
                    client.list_photos = counted
                    try:
                        adjustment.set_value(adjustment.get_upper() - adjustment.get_page_size())
                        view._schedule_scroll_load(); pump(0.6)
                        check("real month end stays idle when scrolling to the bottom", not requests and not view._loading, f"{len(view._photos)} photos; zero further requests")
                    finally: client.list_photos = original
                else:
                    print("SKIP real month-end idle check: bounded ten-page traversal did not reach end", flush=True)
            view._period_banner.emit("button-clicked")
            wait(lambda: not view._loading)
            check("real All dates returns to the timeline", not view._year and not view._month and bool(view._photos))
        still = next((p for p in view._photos if not p.is_video), view._photos[0])
        window.open_photo(still, tuple(view._photos))
        preview = window._preview_page
        wait(lambda: preview._texture is not None or preview._stack.get_visible_child_name() == "error")
        check("real image preview decodes in GTK", preview._texture is not None)
        window.close_photo()
        window.open_photo(still, tuple(view._photos))
        check("real preview can immediately reopen", window._nav.get_visible_page() is window._preview_page)
        if video_name is None:
            return
        window.close_photo()
        pages, errors = [], []
        client.list_photos({"kind": "videos", "search": video_name, "limit": 1}, pages.append, errors.append)
        wait(lambda: pages or errors)
        if errors:
            raise RuntimeError(errors[0])
        if not pages[0].photos:
            check("real video found for GTK playback", False)
            return
        window.open_photo(pages[0].photos[0], pages[0].photos)
        preview = window._preview_page
        wait(lambda: preview._texture is not None or preview._stack.get_visible_child_name() == "error")
        started = time.monotonic()
        preview._play_button.emit("clicked")
        wait(lambda: (preview._media is not None and preview._media.is_prepared()) or preview._stack.get_visible_child_name() == "error")
        media = preview._media
        check("real video prepares in GTK", media is not None and media.is_prepared(), f"{time.monotonic() - started:.2f}s")
        if media is None:
            return
        media.set_muted(True)
        wait(lambda: media.get_timestamp() > 1_000_000 or media.get_error() is not None)
        check("real video plays decoded frames in GTK", media.get_error() is None and media.get_intrinsic_width() > 0 and media.get_intrinsic_height() > 0, f"{time.monotonic() - started:.2f}s")
        media.pause()
        check("real video pauses in GTK", not media.get_playing())
        check("real video is seekable in GTK", media.is_seekable())
        if media.is_seekable():
            middle = media.get_duration() // 2
            started = time.monotonic()
            media.seek(middle)
            wait(lambda: not media.is_seeking() and abs(media.get_timestamp() - middle) < 500_000)
            check("real video seeks forward in GTK", media.get_error() is None, f"{time.monotonic() - started:.2f}s")
            media.seek(0)
            wait(lambda: not media.is_seeking() and media.get_timestamp() < 500_000)
            check("real video seeks backward in GTK", media.get_error() is None)
        media.play()
        wait(lambda: media.get_timestamp() > 500_000)
        check("real video resumes in GTK", media.get_playing() and media.get_error() is None)
        window.close_photo()
        check("leaving real video clears GTK playback", preview._media is None and preview._video_session is None)
    finally:
        if window:
            window.destroy()
        client.stop()


def write_checks(proxy):
    date = datetime.now(timezone.utc).strftime("%Y%m%d")
    folder = Path.home() / f"halyard-photos-test-{date}-{uuid.uuid4().hex[:8]}"
    pairs = call(proxy, "ListPairs")
    for pair in pairs:
        root = Path(pair["localPath"]).resolve()
        if root == folder or root in folder.parents:
            raise ValueError("The proposed test folder overlaps an existing sync pair")
    folder.mkdir(mode=0o700)
    print(f"Generated test artifacts: {folder}", flush=True)
    paths, inputs, expected = generated_inputs(folder)
    job = call(proxy, "StartPhotoUpload", json.dumps({"files": inputs}))
    JOBS.append(("Upload", job["id"]))
    upload = finish(proxy, "Upload", job)
    check("JPEG, PNG, WebP and different content with the same filename upload", upload["status"] == "completed" and all(f["status"] == "completed" for f in upload["files"]))
    if upload["status"] != "completed":
        return
    check("different content with same filename gets separate nodes", upload["files"][0]["uid"] != upload["files"][3]["uid"])
    for file in upload["files"]:
        metadata = Photo.from_json(call(proxy, "GetPhoto", file["uid"]))
        check("uploaded metadata preserves name, size and capture time", metadata.name == file["name"] and metadata.size == file["size"] and metadata.capture_time == expected[file["path"]][1], Path(file["path"]).suffix)
    duplicate_job = call(proxy, "StartPhotoUpload", json.dumps({"files": inputs[:3]}))
    JOBS.append(("Upload", duplicate_job["id"]))
    duplicate = finish(proxy, "Upload", duplicate_job)
    check("identical re-upload skips all three formats", duplicate["status"] == "completed" and all(f["status"] == "skipped" for f in duplicate["files"]))
    target = folder / "downloads"
    uids = [f["uid"] for f in upload["files"]]
    originals = {f["uid"]: expected[f["path"]][0] for f in upload["files"]}
    first = call(proxy, "StartPhotoDownload", json.dumps({"uids": uids, "destination": str(target)}))
    JOBS.append(("Download", first["id"]))
    downloaded = finish(proxy, "Download", first)
    PhotoDownload.from_json(downloaded)
    check("originals download byte-identically", downloaded["status"] == "completed" and all(f["path"] and digest(f["path"]) == originals[f["uid"]] for f in downloaded["files"]))
    saved = {f["path"]: digest(f["path"]) for f in downloaded["files"] if f["path"]}
    again = call(proxy, "StartPhotoDownload", json.dumps({"uids": uids, "destination": str(target)}))
    JOBS.append(("Download", again["id"]))
    collisions = finish(proxy, "Download", again)
    check("repeat downloads keep existing files and create numbered copies", collisions["status"] == "completed" and all(f["path"] not in saved and digest(f["path"]) == originals[f["uid"]] for f in collisions["files"]) and all(digest(path) == value for path, value in saved.items()))
    check("uploads keep all local originals", all(digest(path) == expected[str(path)][0] for path in paths))
    results = call(proxy, "TrashPhotos", json.dumps({"uids": uids}))
    check("only generated test images move to recoverable Trash", {r["uid"] for r in results} == set(uids) and all(r["ok"] for r in results))
    CREATED.difference_update(r["uid"] for r in results if r["ok"])
    TRASHED.update(r["uid"] for r in results if r["ok"])
    check("Trash leaves downloaded copies untouched", all(digest(path) == value for path, value in saved.items()))
    print("Generated test photos are in Proton Trash; originals and downloads are retained locally.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--writes", action="store_true")
    parser.add_argument("--gtk", action="store_true", help="also check GTK rendering on the available display")
    parser.add_argument("--scroll", action="store_true", help="read-only GTK scrolling and year-jump checks on the real library")
    parser.add_argument("--video", nargs="?", const="", help="also test GTK video playback and seeking, optionally searching by filename")
    args = parser.parse_args()
    proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, None, BUS, OBJECT, BUS, None)
    if proxy.get_name_owner() is None:
        raise SystemExit("The real daemon is not running")
    if call(proxy, "GetVersion") != __version__:
        raise SystemExit(f"This test requires the {__version__} daemon")
    if not call(proxy, "GetAccount")["loggedIn"]:
        raise SystemExit("The real daemon is not signed in")
    try:
        read_checks(proxy)
        if args.gtk or args.scroll or args.video is not None:
            gtk_checks(args.video, args.scroll)
        if args.writes:
            write_checks(proxy)
    except Exception as error:
        check("live Photos test completes", False, str(error))
    finally:
        for kind, job_id in JOBS:
            jobs = call(proxy, "ListPhoto" + kind + "s")
            job = next((j for j in jobs if j["id"] == job_id), None)
            if job and job["status"] in ("queued", "uploading", "downloading", "paused"):
                call(proxy, "ControlPhoto" + kind, job_id, "cancel")
            if kind == "Upload" and job:
                CREATED.update(f["uid"] for f in job["files"] if f["status"] == "completed" and f["uid"] not in TRASHED)
        if CREATED:
            results = call(proxy, "TrashPhotos", json.dumps({"uids": sorted(CREATED)}))
            check("remaining generated uploads cleaned up to recoverable Trash", all(r["ok"] for r in results))
    failed = sum(not ok for _, ok in RESULTS)
    print(f"{len(RESULTS) - failed}/{len(RESULTS)} live Photos checks passed", flush=True)
    return bool(failed)


if __name__ == "__main__":
    sys.exit(main())
