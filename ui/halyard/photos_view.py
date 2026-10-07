"""Native photo browsing. Proton access and download jobs stay in the daemon."""

from __future__ import annotations

import base64
import os
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone

from gi.repository import Adw, Gdk, GdkPixbuf, Gio, GLib, GObject, Gtk

from .models import Photo, PhotoAlbum, PhotoPage, PhotoThumbnail
from .util import format_absolute_time, format_size, paths_overlap, tilde_path


def month_key(photo: Photo) -> str:
    return datetime.fromtimestamp(photo.capture_time / 1000, timezone.utc).strftime("%Y-%m")


def texture_from_thumbnail(thumb: PhotoThumbnail) -> Gdk.Texture | None:
    if not thumb.data:
        return None
    try:
        return Gdk.Texture.new_from_bytes(GLib.Bytes.new(base64.b64decode(thumb.data, validate=True)))
    except (ValueError, GLib.Error):
        return None


class _PhotoRow(GObject.Object):
    """A virtualised row of tiles, optionally preceded by a month heading."""

    def __init__(self, photos: tuple[Photo, ...], heading: str = "", columns: int = 5) -> None:
        super().__init__()
        self.photos = photos
        self.heading = heading
        self.columns = columns


class PhotosView(Gtk.Box):
    __gsignals__ = {
        "management-changed": (GObject.SIGNAL_RUN_FIRST, None, (bool, bool)),
    }

    def __init__(self, client, window, settings) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self.client = client
        self.window = window
        self.settings = settings
        self._photos: list[Photo] = []
        self._selected: set[str] = set()
        self._selection_anchor: str | None = None
        self._selecting = False
        self._loaded = False
        self._loading = False
        self._active = False
        self._albums_mode = False
        self._album: PhotoAlbum | None = None
        self._year: str | None = None
        self._month: str | None = None
        self._next_cursor: str | None = None
        self._request = 0
        self._revision = -1
        self._latest_revision = -1
        self._textures: OrderedDict[str, Gdk.Texture] = OrderedDict()
        self._thumb_waiters: dict[str, list] = {}
        self._thumb_busy = False
        self._thumb_idle = 0
        self._search_timeout = 0
        self._scroll_load_source = 0
        self._scroll_restore_tick = 0
        self._scroll_restore_position: float | None = None
        self._scroll_input_serial = 0
        self._page_error = False
        self._tile_checks: dict[str, list[Gtk.CheckButton]] = {}
        self._updating_checks = False
        self._columns = 5
        self._account_epoch = 0
        self._management_id: str | None = None
        self._management_busy = False
        self._management_cancelled = False
        self._management_errors: list[tuple[str, str]] = []
        self._refresh_selection: set[str] | None = None
        self._refresh_position: float | None = None
        self._refresh_count = 0

        self._changed_handler = client.connect("photos-changed", self._on_library_changed)

        self._changed_banner = Adw.Banner(title="Your photo library changed", button_label="Reload")
        self._changed_banner.connect("button-clicked", lambda *_: self.reload(preserve=True))
        self.append(self._changed_banner)
        self._management_error_banner = Adw.Banner(title="Some photo changes could not be completed", button_label="Details")
        self._management_error_banner.connect("button-clicked", lambda *_: self.show_management_errors())
        self.append(self._management_error_banner)
        self._period_banner = Adw.Banner(button_label="All dates")
        self._period_banner.connect("button-clicked", lambda *_: self.clear_period())
        self.append(self._period_banner)

        heading = Gtk.Box(spacing=12)
        self._heading = Gtk.Label(label="Photos", xalign=0, hexpand=True)
        self._heading.add_css_class("title-1")
        heading.append(self._heading)
        search = Gtk.ToggleButton(icon_name="system-search-symbolic", tooltip_text="Search by file name")
        search.connect("toggled", lambda button: self._search_bar.set_search_mode(button.get_active()))
        heading.append(search)
        self._date_button = Gtk.Button(icon_name="x-office-calendar-symbolic", tooltip_text="Jump to year or month…")
        self._date_button.connect("clicked", lambda *_: self.jump_to_date())
        heading.append(self._date_button)
        self._upload_button = Gtk.Button(icon_name="document-send-symbolic", tooltip_text="Upload photos…")
        self._upload_button.connect("clicked", self._choose_upload)
        heading.append(self._upload_button)
        self._select_button = Gtk.Button(label="Select")
        self._select_button.connect("clicked", self._toggle_selection)
        self._select_button.set_tooltip_text("Select photos. Shift-click to select a range.")
        heading.append(self._select_button)
        self._create_album_button = Gtk.Button(icon_name="folder-new-symbolic", tooltip_text="Create album…", visible=False)
        self._create_album_button.connect("clicked", lambda *_: self.edit_album())
        heading.append(self._create_album_button)
        self._album_menu = Gtk.MenuButton(icon_name="view-more-symbolic", tooltip_text="Manage album", visible=False)
        album_actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self._rename_album_button = Gtk.Button(label="Rename album…")
        self._rename_album_button.connect("clicked", lambda *_: (self._album_menu.popdown(), self.edit_album(self._album)))
        album_actions.append(self._rename_album_button)
        self._delete_album_button = Gtk.Button(label="Delete album…")
        self._delete_album_button.add_css_class("destructive-action")
        self._delete_album_button.connect("clicked", lambda *_: (self._album_menu.popdown(), self.delete_album(self._album)))
        album_actions.append(self._delete_album_button)
        self._album_menu.set_popover(Gtk.Popover(child=album_actions))
        heading.append(self._album_menu)
        self._margin(heading, 20)
        self.append(heading)

        self._search_entry = Gtk.SearchEntry(placeholder_text="Search by file name", hexpand=True)
        self._search_entry.connect("search-changed", self._search_changed)
        self._search_bar = Gtk.SearchBar(child=self._search_entry)
        self._search_bar.connect_entry(self._search_entry)
        self._search_bar.set_key_capture_widget(self)
        self.append(self._search_bar)

        controls = Gtk.Box(spacing=8)
        self._back = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Back to albums", visible=False)
        self._back.connect("clicked", lambda *_: self.show_albums())
        controls.append(self._back)
        self._all_button = Gtk.ToggleButton(label="All photos", active=True)
        self._all_button.connect("clicked", lambda *_: self.show_timeline())
        controls.append(self._all_button)
        self._albums_button = Gtk.ToggleButton(label="Albums")
        self._albums_button.connect("clicked", lambda *_: self.show_albums())
        controls.append(self._albums_button)
        controls.append(Gtk.Box(hexpand=True))
        self._kind = Gtk.DropDown.new_from_strings(["Everything", "Favourites", "Videos"])
        self._kind.set_tooltip_text("Filter photos")
        self._kind.connect("notify::selected", lambda *_: self.reload())
        controls.append(self._kind)
        self._margin(controls, 12)
        self.append(controls)

        self._stack = Gtk.Stack(vexpand=True)
        self._loading_page = Adw.StatusPage(title="Loading photos…")
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        self._loading_page.set_child(spinner)
        self._stack.add_named(self._loading_page, "loading")
        self._empty = Adw.StatusPage(icon_name="image-x-generic-symbolic", title="No photos yet",
                                    description="Upload photos or create an album in Albums. Shared albums appear after your own photo gallery has been set up.")
        self._stack.add_named(self._empty, "empty")
        self._error = Adw.StatusPage(icon_name="dialog-error-symbolic", title="Could not load photos")
        retry = Gtk.Button(label="Try again", halign=Gtk.Align.CENTER)
        retry.connect("clicked", lambda *_: self.reload(preserve=True))
        self._error.set_child(retry)
        self._stack.add_named(self._error, "error")

        self._rows = Gio.ListStore.new(_PhotoRow)
        factory = Gtk.SignalListItemFactory()
        factory.connect("setup", self._setup_row)
        factory.connect("bind", self._bind_row)
        factory.connect("unbind", self._unbind_row)
        self._list = Gtk.ListView(model=Gtk.NoSelection.new(self._rows), factory=factory)
        self._list.add_css_class("halyard-photo-list")
        self._scrolled = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True)
        self._scrolled.set_child(self._list)
        scroll = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.VERTICAL)
        scroll.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        scroll.connect("scroll", self._on_user_scroll)
        self._scrolled.add_controller(scroll)
        keys = Gtk.EventControllerKey()
        keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        keys.connect("key-pressed", self._on_scroll_key)
        self._scrolled.add_controller(keys)
        scrollbar = Gtk.GestureClick()
        scrollbar.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        scrollbar.connect("pressed", lambda *_: self._on_user_scroll(None, 0, 0))
        self._scrolled.get_vscrollbar().add_controller(scrollbar)
        adjustment = self._scrolled.get_vadjustment()
        adjustment.connect("value-changed", self._schedule_scroll_load)
        adjustment.connect("changed", self._schedule_scroll_load)
        self._scrolled.connect("map", self._gallery_mapped)
        adaptive = Adw.BreakpointBin(child=self._scrolled)
        adaptive.set_size_request(280, 200)
        for width, columns in ((850, 4), (650, 3), (450, 2)):
            breakpoint = Adw.Breakpoint.new(Adw.BreakpointCondition.parse(f"max-width: {width}sp"))
            breakpoint.add_setter(self, "columns", columns)
            adaptive.add_breakpoint(breakpoint)
        self._stack.add_named(adaptive, "photos")

        self._album_page = Adw.PreferencesPage()
        self._album_group = Adw.PreferencesGroup(title="Albums")
        self._album_page.add(self._album_group)
        self._album_rows: list[Adw.ActionRow] = []
        albums_scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        albums_scroll.set_child(self._album_page)
        self._stack.add_named(albums_scroll, "albums")
        self.append(self._stack)

        self._more = Gtk.Button(label="Load more photos", halign=Gtk.Align.CENTER, visible=False)
        self._more.connect("clicked", lambda *_: self._load(more=True))
        self._more.set_margin_top(8)
        self._more.set_margin_bottom(8)
        self.append(self._more)
        self._page_loading = Gtk.Box(spacing=8, halign=Gtk.Align.CENTER, visible=False)
        spinner = Adw.Spinner()
        spinner.set_size_request(20, 20)
        self._page_loading.append(spinner)
        self._page_loading.append(Gtk.Label(label="Loading more photos…"))
        self._page_loading.set_margin_top(8)
        self._page_loading.set_margin_bottom(8)
        self.append(self._page_loading)
        self._selection_bar = Gtk.ActionBar(revealed=False)
        self._selection_label = Gtk.Label(xalign=0)
        self._selection_bar.pack_start(self._selection_label)
        download = Gtk.Button(label="Download…")
        download.add_css_class("suggested-action")
        download.connect("clicked", lambda *_: self.download_items([p for p in self._photos if p.uid in self._selected]))
        self._selection_bar.pack_end(download)
        self._trash_button = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Move selected photos to Trash")
        self._trash_button.connect("clicked", lambda *_: self.trash_items([p for p in self._photos if p.uid in self._selected]))
        self._selection_bar.pack_end(self._trash_button)
        self._selection_menu = Gtk.MenuButton(icon_name="view-more-symbolic", tooltip_text="Manage selected photos")
        actions = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self._favourite_selection = Gtk.Button(label="Add to favourites")
        self._unfavourite_selection = Gtk.Button(label="Remove from favourites")
        self._add_to_album_button = Gtk.Button(label="Add to album…")
        self._remove_from_album_button = Gtk.Button(label="Remove from this album…", visible=False)
        for button, action in ((self._favourite_selection, lambda: self.set_favourites(self.selected_items(), True)),
                               (self._unfavourite_selection, lambda: self.set_favourites(self.selected_items(), False)),
                               (self._add_to_album_button, lambda: self.add_to_album(self.selected_items())),
                               (self._remove_from_album_button, lambda: self.remove_from_album(self.selected_items()))):
            button.connect("clicked", lambda _button, work=action: (self._selection_menu.popdown(), work()))
            actions.append(button)
        self._selection_menu.set_popover(Gtk.Popover(child=actions))
        self._selection_bar.pack_end(self._selection_menu)
        self.append(self._selection_bar)
        self._management_bar = Gtk.ActionBar(revealed=False)
        self._management_label = Gtk.Label(label="Updating your photo library…", wrap=True)
        self._management_bar.pack_start(self._management_label)
        self._cancel_management = Gtk.Button(label="Cancel")
        self._cancel_management.connect("clicked", self.cancel_management)
        self._management_bar.pack_end(self._cancel_management)
        self.append(self._management_bar)
        self._stack.set_visible_child_name("loading")

    @GObject.Property(type=int, default=5, minimum=2, maximum=5)
    def columns(self) -> int:
        return self._columns

    @columns.setter
    def columns(self, value: int) -> None:
        self._columns = value
        if hasattr(self, "_rows"):
            self._rebuild_rows()

    @staticmethod
    def _margin(widget: Gtk.Widget, vertical: int) -> None:
        widget.set_margin_start(20)
        widget.set_margin_end(20)
        widget.set_margin_top(vertical)
        widget.set_margin_bottom(vertical)

    def activate(self) -> None:
        self._active = True
        if not self._loaded:
            self.reload()
        elif self._year and not self._photos and self._next_cursor and not self._page_error and not self._loading:
            self._load(more=True)
        self._schedule_scroll_load()

    def deactivate(self) -> None:
        self._active = False

    def reset(self) -> None:
        if self._management_id and self.client.available:
            self.client.cancel_photo_operation(self._management_id, lambda _message: None)
        self._account_epoch += 1
        self._management_id = None
        self._management_busy = False
        self._management_cancelled = False
        self._management_errors.clear()
        self._management_error_banner.set_revealed(False)
        self._management_bar.set_revealed(False)
        self.emit("management-changed", False, False)
        self._refresh_selection = None
        self._refresh_position = None
        self._request += 1
        self._cancel_scroll_restore()
        self._loaded = False
        self._loading = False
        self._page_error = False
        self._page_loading.set_visible(False)
        self._more.set_visible(False)
        if self._scroll_load_source:
            GLib.source_remove(self._scroll_load_source)
            self._scroll_load_source = 0
        self._photos.clear()
        self._selected.clear()
        self._selection_anchor = None
        self._textures.clear()
        self._thumb_waiters.clear()
        self._thumb_busy = False
        self._rows.remove_all()
        for row in self._album_rows:
            self._album_group.remove(row)
        self._album_rows.clear()
        self._albums_mode = False
        self._album = None
        self._year = None
        self._month = None
        self._selecting = False
        self._upload_button.set_sensitive(True)
        self._trash_button.set_sensitive(True)
        self._update_controls()
        self._revision = -1
        self._latest_revision = -1
        self._next_cursor = None
        self._search_entry.set_text("")
        self._changed_banner.set_revealed(False)
        self._update_selection()

    def _choose_upload(self, *_):
        chooser = Gtk.FileDialog(title="Upload photos", modal=True)
        image_filter = Gtk.FileFilter(name="JPEG, PNG and WebP images")
        for mime in ("image/jpeg", "image/png", "image/webp"): image_filter.add_mime_type(mime)
        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(image_filter)
        chooser.set_filters(filters)
        chooser.set_default_filter(image_filter)
        def chosen(source, result):
            try:
                selected = source.open_multiple_finish(result)
            except GLib.Error:
                return
            paths = [selected.get_item(i).get_path() for i in range(selected.get_n_items())]
            if not paths or len(paths) > 20 or any(not path for path in paths):
                self.window.toast("Choose between 1 and 20 local images to upload.")
                return
            request = self._request
            self._upload_button.set_sensitive(False)
            self.window.toast("Preparing photo previews…")
            def prepare():
                try:
                    files = []
                    for path in paths:
                        info = GdkPixbuf.Pixbuf.get_file_info(path)
                        if not info[0] or info[1] * info[2] > 100_000_000:
                            raise ValueError("This image could not be opened or is too large to preview.")
                        pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 2048, 2048, True).apply_embedded_orientation()
                        previews = []
                        for kind, bound in ((1, 256), (2, 2048)):
                            ratio = min(1, bound / max(pixbuf.get_width(), pixbuf.get_height()))
                            scaled = pixbuf.scale_simple(max(1, int(pixbuf.get_width() * ratio)), max(1, int(pixbuf.get_height() * ratio)), GdkPixbuf.InterpType.BILINEAR)
                            ok, data = scaled.save_to_bufferv("jpeg", ["quality"], ["85"])
                            if not ok: raise ValueError("Could not prepare this photo preview.")
                            previews.append({"type": kind, "data": base64.b64encode(data).decode("ascii")})
                        files.append({"path": path, "thumbnails": previews})
                    GLib.idle_add(confirm, files, None)
                except (GLib.Error, ValueError, OSError) as error:
                    GLib.idle_add(confirm, [], str(error))
            def confirm(files, error):
                self._upload_button.set_sensitive(True)
                if request != self._request or not self.window.account_logged_in: return False
                if error:
                    self.window.toast(error); return False
                heading = "Upload photo" if len(files) == 1 else f"Upload {len(files)} photos"
                dialog = Adw.AlertDialog(heading=heading, body=(
                    "These images will be added to your Proton Drive gallery. Local originals stay in place. "
                    "Copies with the same name and content are skipped. Halyard keeps the date each photo was taken. "
                    "If that date is missing, it uses the file’s last modified date."))
                dialog.add_response("cancel", "Cancel"); dialog.add_response("upload", "Upload")
                dialog.set_response_appearance("upload", Adw.ResponseAppearance.SUGGESTED)
                dialog.set_default_response("upload"); dialog.set_close_response("cancel")
                def respond(_dialog, response):
                    if response == "upload" and request == self._request and self.window.account_logged_in:
                        self._upload_button.set_sensitive(False)
                        def started(_job):
                            self._upload_button.set_sensitive(True)
                            self.window.toast("Photo upload started. Track its progress in Activity.")
                        def failed(message):
                            self._upload_button.set_sensitive(True); self.window.toast(message)
                        self.client.start_photo_upload(files, started, failed)
                dialog.connect("response", respond); dialog.present(self.window)
                return False
            threading.Thread(target=prepare, daemon=True, name="photo-previews").start()
        chooser.open_multiple(self.window, None, chosen)

    def dispose(self) -> None:
        self._account_epoch += 1
        if self._management_id and self.client.available:
            self.client.cancel_photo_operation(self._management_id, lambda _message: None)
        self.client.disconnect(self._changed_handler)
        for source in (self._thumb_idle, self._search_timeout, self._scroll_load_source):
            if source:
                GLib.source_remove(source)
        self._request += 1
        self._cancel_scroll_restore()

    def show_timeline(self) -> None:
        if not self._albums_mode and self._album is None:
            self._all_button.set_active(True)
            return
        self._albums_mode = False
        self._album = None
        self._update_controls()
        self.reload()

    def show_albums(self) -> None:
        self._albums_mode = True
        self._album = None
        self._update_controls()
        self.reload()

    def _open_album(self, album: PhotoAlbum) -> None:
        self._albums_mode = False
        self._album = album
        self._update_controls()
        self.reload()

    def _update_controls(self) -> None:
        self._heading.set_label(self._album.name if self._album else "Photos")
        self._back.set_visible(self._album is not None)
        self._all_button.set_active(not self._albums_mode and self._album is None)
        self._albums_button.set_active(self._albums_mode or self._album is not None)
        self._kind.set_sensitive(not self._albums_mode)
        self._date_button.set_visible(not self._albums_mode)
        self._period_banner.set_revealed(bool(self._year) and not self._albums_mode)
        self._select_button.set_sensitive(not self._albums_mode)
        self._create_album_button.set_visible(self._albums_mode)
        self._create_album_button.set_sensitive(not self._management_busy)
        self._album_menu.set_visible(self._album is not None)
        self._rename_album_button.set_sensitive(bool(self._album and self._album.can_write) and not self._management_busy)
        self._delete_album_button.set_sensitive(bool(self._album and self._album.can_delete) and not self._management_busy)
        self._remove_from_album_button.set_visible(self._album is not None)

    def _search_changed(self, *_args) -> None:
        if self._search_timeout:
            GLib.source_remove(self._search_timeout)
        def run() -> bool:
            self._search_timeout = 0
            if self._loaded and not self._albums_mode:
                self.reload()
            return False
        self._search_timeout = GLib.timeout_add(300, run)

    def jump_to_date(self) -> None:
        request = self._request
        dialog = Adw.AlertDialog(heading="Jump to date", body="Choose a year and optionally a month to show photos from that period.")
        group = Adw.PreferencesGroup()
        year = Gtk.SpinButton.new_with_range(1, 9999, 1)
        year.set_numeric(True)
        year.set_value(int(self._year) if self._year else datetime.now().year)
        year.set_valign(Gtk.Align.CENTER)
        row = Adw.ActionRow(title="Year")
        row.add_suffix(year); group.add(row)
        month = Gtk.DropDown.new_from_strings(["All months"] + [datetime(2000, i, 1).strftime("%B") for i in range(1, 13)])
        month.set_selected(int(self._month[-2:]) if self._month else 0)
        month.set_valign(Gtk.Align.CENTER)
        row = Adw.ActionRow(title="Month")
        row.add_suffix(month); group.add(row)
        dialog.set_extra_child(group)
        dialog.add_response("cancel", "Cancel"); dialog.add_response("show", "Show photos")
        dialog.set_response_appearance("show", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("show"); dialog.set_close_response("cancel")
        def respond(_dialog, response):
            if response != "show" or request != self._request or not self.window.account_logged_in: return
            year.update()
            self._year = f"{year.get_value_as_int():04d}"
            self._month = f"{self._year}-{month.get_selected():02d}" if month.get_selected() else None
            period = datetime(int(self._year), month.get_selected() or 1, 1).strftime("%B %Y") if self._month else self._year
            self._period_banner.set_title(f"Showing {period}")
            self._update_controls(); self.reload()
        dialog.connect("response", respond); dialog.present(self.window)

    def clear_period(self) -> None:
        self._year = None; self._month = None
        self._update_controls(); self.reload()

    def reload(self, preserve: bool = False, *, scroll_position: float | None = None) -> None:
        if not self.client.available or not self.window.account_logged_in:
            return
        position = scroll_position if scroll_position is not None else self._scroll_restore_position
        if position is None: position = self._scrolled.get_vadjustment().get_value()
        self._request += 1
        self._cancel_scroll_restore()
        self._page_error = False
        self._page_loading.set_visible(False)
        self._refresh_selection = set(self._selected) if preserve else None
        self._refresh_position = position if preserve else 0
        self._refresh_count = len(self._photos) if preserve else 0
        self._loading = False
        self._loaded = True
        self._photos.clear()
        if not preserve:
            self._rows.remove_all()
        if not preserve:
            self._selected.clear()
            self._selection_anchor = None
            self._selecting = False
        self._next_cursor = None
        self._thumb_waiters.clear()
        self._thumb_busy = False
        self._changed_banner.set_revealed(False)
        self._update_selection()
        if self._album:
            request = self._request
            self._loading = True
            def album_ready(albums):
                if request != self._request: return
                self._loading = False
                updated = next((a for a in albums if a.uid == self._album.uid), None)
                if updated is None:
                    self._album = None
                    self._albums_mode = True
                else:
                    self._album = updated
                self._update_controls()
                self._load()
            def album_failed(message):
                if request != self._request: return
                self._loading = False
                self._error.set_description(message)
                self._stack.set_visible_child_name("error")
            self.client.list_photo_albums(album_ready, album_failed)
        else:
            self._load()

    def _schedule_scroll_load(self, *_args) -> None:
        if not self._scroll_load_source:
            # Let GTK finish allocating the appended rows before measuring
            # the remaining space. This is driven by scrolling/layout events.
            self._scroll_load_source = GLib.timeout_add(100, self._load_near_bottom)

    def _gallery_mapped(self, *_args) -> None:
        if self._scroll_restore_position is not None:
            self._restore_scroll_after_layout(self._scroll_restore_position)
        self._schedule_scroll_load()

    def _load_near_bottom(self) -> bool:
        self._scroll_load_source = 0
        if (not self._active or not self._loaded or self._loading or self._scroll_restore_position is not None or self._albums_mode or not self._next_cursor or
                not self._photos or self._page_error or self._management_busy or
                not self._scrolled.get_mapped()):
            return False
        adjustment = self._scrolled.get_vadjustment()
        viewport = adjustment.get_page_size()
        remaining = adjustment.get_upper() - adjustment.get_value() - viewport
        if viewport > 0 and remaining <= max(260, viewport / 2):
            if self._latest_revision > self._revision:
                target = len(self._photos) + 60
                self.reload(preserve=True)
                self._refresh_count = target
            else:
                self._load(more=True)
        return False

    def _load(self, more: bool = False) -> None:
        if self._loading:
            return
        self._loading = True
        self._page_error = False
        self._page_loading.set_visible(more)
        request = self._request
        self._more.set_sensitive(False)
        if not more:
            self._stack.set_visible_child_name("loading")
        def error(message: str) -> None:
            if request != self._request:
                return
            self._loading = False
            self._page_loading.set_visible(False)
            stale = more and (self._latest_revision > self._revision or
                              "Your photo library changed." in message or
                              "The photo page is no longer available." in message)
            if stale and self._photos and self._refresh_selection is None:
                # An album mutation's later SDK event can race continuation.
                # Refresh once and refill the pages plus the requested page.
                target = len(self._photos) + 60
                self.reload(preserve=True)
                self._refresh_count = target
                return
            self._page_error = True
            if self._photos:
                self._display_photos()
                if stale:
                    self._changed_banner.set_revealed(True)
                    self._more.set_visible(False)
                else:
                    self.window.toast(message)
            else:
                self._error.set_description(message)
                self._stack.set_visible_child_name("error")
        if self._albums_mode:
            def albums_ok(albums: tuple[PhotoAlbum, ...]) -> None:
                if request != self._request:
                    return
                self._loading = False
                for row in self._album_rows:
                    self._album_group.remove(row)
                self._album_rows.clear()
                for album in albums:
                    noun = "photo" if album.photo_count == 1 else "photos"
                    row = Adw.ActionRow(title=GLib.markup_escape_text(album.name),
                                        subtitle=f"{album.photo_count} {noun}" + (" · Shared with you" + (" · Read-only" if not album.can_write else "") if album.shared_with_me else ""), activatable=True)
                    row.add_prefix(Gtk.Image.new_from_icon_name("folder-pictures-symbolic"))
                    row.add_suffix(Gtk.Image.new_from_icon_name("go-next-symbolic"))
                    row.connect("activated", lambda _row, a=album: self._open_album(a))
                    self._album_group.add(row)
                    self._album_rows.append(row)
                self._more.set_visible(False)
                self._empty.set_title("No albums yet")
                self._empty.set_description("Create an album to organise your photos. Shared albums appear after your own photo gallery has been set up.")
                self._stack.set_visible_child_name("albums" if albums else "empty")
            self.client.list_photo_albums(albums_ok, error)
            return
        query = {"limit": 60, "kind": ("all", "favourites", "videos")[self._kind.get_selected()],
                 "search": self._search_entry.get_text().strip()}
        if self._album:
            query["albumUid"] = self._album.uid
        if self._year:
            query["year"] = self._year
        if self._month:
            query["month"] = self._month
        if more and self._next_cursor:
            query["cursor"] = self._next_cursor
        def photos_ok(page: PhotoPage) -> None:
            if request != self._request:
                return
            self._loading = False
            self._page_loading.set_visible(False)
            known = {p.uid for p in self._photos}
            self._photos.extend(p for p in page.photos if p.uid not in known)
            self._next_cursor = page.next_cursor
            self._revision = page.revision
            if self._active and self._year and not self._photos and self._next_cursor and self._latest_revision <= page.revision:
                # Traverse only date placeholders until reaching the chosen
                # period. Navigation/account changes stop subsequent requests.
                self._load(more=True)
                return
            # Refill only the pages the user had already loaded after a local
            # action. This keeps selection and scroll without a polling loop.
            if self._refresh_selection is not None and self._next_cursor and len(self._photos) < self._refresh_count and self._latest_revision <= page.revision:
                self._load(more=True)
                return
            self._display_photos()
        self.client.list_photos(query, photos_ok, error)

    def _display_photos(self) -> None:
        if self._refresh_selection is not None:
            self._selected = self._refresh_selection & {p.uid for p in self._photos}
            self._refresh_selection = None
        if self._selection_anchor not in {p.uid for p in self._photos}:
            self._selection_anchor = None
        self._rebuild_rows()
        self._refresh_position = None
        self._update_selection()
        self._more.set_label("Try again" if self._page_error else "Load more photos")
        self._more.set_visible(bool(self._next_cursor) and (self._page_error or not self._photos))
        self._more.set_sensitive(self._latest_revision <= self._revision)
        if self._latest_revision > self._revision:
            self._changed_banner.set_revealed(True)
        filtered = bool(self._year or self._search_entry.get_text().strip()) or self._kind.get_selected() != 0
        self._empty.set_title("No matching photos" if filtered else "No photos yet")
        self._empty.set_description("Try another filter." if filtered else
                                   "Upload photos or create an album in Albums. Shared albums appear after your own photo gallery has been set up.")
        self._stack.set_visible_child_name("photos" if self._photos else "empty")
        self._schedule_scroll_load()

    def _rebuild_rows(self) -> None:
        adjustment = self._scrolled.get_vadjustment()
        position = self._refresh_position
        if position is None: position = self._scroll_restore_position
        if position is None: position = adjustment.get_value()
        rows: list[_PhotoRow] = []
        grouped: OrderedDict[str, list[Photo]] = OrderedDict()
        for photo in self._photos:
            grouped.setdefault(month_key(photo), []).append(photo)
        for month, photos in grouped.items():
            for start in range(0, len(photos), self._columns):
                heading = datetime.strptime(month, "%Y-%m").strftime("%B %Y") if start == 0 else ""
                rows.append(_PhotoRow(tuple(photos[start:start + self._columns]), heading, self._columns))
        # Keep unchanged rows (and GTK's scroll anchor) across metadata refreshes.
        old = [self._rows.get_item(i) for i in range(self._rows.get_n_items())]
        def same(a, b): return a.photos == b.photos and a.heading == b.heading and a.columns == b.columns
        prefix = 0
        while prefix < min(len(old), len(rows)) and same(old[prefix], rows[prefix]): prefix += 1
        suffix = 0
        while suffix < min(len(old), len(rows)) - prefix and same(old[-suffix - 1], rows[-suffix - 1]): suffix += 1
        if prefix + suffix < max(len(old), len(rows)):
            focus = self.window.get_focus()
            focused_row = None
            while focus and focus != self._list:
                focused_row = getattr(focus, "_photo_row", None)
                if focused_row is not None: break
                focus = focus.get_parent()
            if self._active and focused_row in old[prefix:len(old) - suffix]:
                self._select_button.grab_focus()
            self._rows.splice(prefix, len(old) - prefix - suffix, rows[prefix:len(rows) - suffix])
        self._restore_scroll_after_layout(position)

    def _cancel_scroll_restore(self) -> None:
        if self._scroll_restore_tick:
            self._scrolled.remove_tick_callback(self._scroll_restore_tick)
            self._scroll_restore_tick = 0
        self._scroll_restore_position = None

    def _on_user_scroll(self, _controller, _dx, _dy) -> bool:
        self._scroll_input_serial += 1
        self._cancel_scroll_restore()
        return False

    def _on_scroll_key(self, _controller, key, _code, _state) -> bool:
        if key in (Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_Home, Gdk.KEY_End, Gdk.KEY_Up, Gdk.KEY_Down, Gdk.KEY_space):
            self._on_user_scroll(None, 0, 0)
        return False

    def _restore_scroll_after_layout(self, position: float) -> None:
        self._cancel_scroll_restore()
        if not self._photos:
            return
        self._scroll_restore_position = position
        request = self._request
        geometry, stable, started = None, 0, None
        def finished():
            self._scroll_restore_tick = 0
            self._scroll_restore_position = None
            self._schedule_scroll_load()
            return False
        def restore(widget, clock):
            nonlocal geometry, stable, started
            if request != self._request:
                return finished()
            adjustment = widget.get_vadjustment()
            current = (adjustment.get_upper(), adjustment.get_page_size())
            if not widget.get_mapped() or current[1] <= 0:
                return True
            if started is None: started = clock.get_frame_time()
            if clock.get_frame_time() - started > 1_000_000:
                return finished()
            # Ticks run before layout: first let a frame allocate the new rows,
            # then verify the offset survives subsequent layout and bar resizing.
            if current != geometry:
                geometry, stable = current, 0
                return True
            target = max(0, min(position, current[0] - current[1]))
            if abs(adjustment.get_value() - target) < 1:
                stable += 1
                if stable >= 2:
                    return finished()
            else:
                stable = 0
                adjustment.set_value(target)
            return True
        self._scroll_restore_tick = self._scrolled.add_tick_callback(restore)

    def _setup_row(self, _factory, item: Gtk.ListItem) -> None:
        item.set_child(Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8))

    def _unbind_row(self, _factory, item: Gtk.ListItem) -> None:
        box = item.get_child()
        box._photo_row = None
        for uid, check in getattr(item, "_checks", []):
            checks = self._tile_checks.get(uid, [])
            if check in checks:
                checks.remove(check)
        item._checks = []
        child = box.get_first_child()
        while child:
            following = child.get_next_sibling()
            box.remove(child)
            child = following

    def _bind_row(self, _factory, item: Gtk.ListItem) -> None:
        self._unbind_row(_factory, item)
        row = item.get_item()
        box = item.get_child()
        box._photo_row = row
        box.set_margin_start(20)
        box.set_margin_end(20)
        box.set_margin_bottom(8)
        if row.heading:
            label = Gtk.Label(label=row.heading, xalign=0)
            label.add_css_class("heading")
            label.set_margin_top(12)
            box.append(label)
        tiles = Gtk.Box(spacing=8, homogeneous=True)
        for photo in row.photos:
            overlay = Gtk.Overlay()
            picture = Gtk.Picture(content_fit=Gtk.ContentFit.COVER, can_shrink=True)
            picture.set_size_request(90, 130)
            picture.add_css_class("halyard-photo-tile")
            picture.set_tooltip_text(photo.name)
            button = Gtk.Button(child=picture, hexpand=True)
            button.add_css_class("flat")
            button.add_css_class("halyard-photo-button")
            button.set_tooltip_text(photo.name)
            button.connect("clicked", lambda _button, p=photo: self._tile_clicked(p))
            overlay.set_child(button)
            check = Gtk.CheckButton(halign=Gtk.Align.START, valign=Gtk.Align.START)
            check.set_margin_start(8)
            check.set_margin_top(8)
            check.set_tooltip_text(f"Select {photo.name}")
            check.set_active(photo.uid in self._selected)
            check.set_visible(self._selecting)
            check.connect("toggled", lambda b, uid=photo.uid: self._check_toggled(b, uid))
            overlay.add_overlay(check)
            range_click = Gtk.GestureClick(button=Gdk.BUTTON_PRIMARY)
            range_click.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
            range_click.connect("pressed", self._range_pressed, photo.uid)
            range_click.connect("released", self._range_released)
            range_click.connect("cancel", self._range_cancelled)
            range_click.connect("unpaired-release", self._range_cancelled)
            overlay.add_controller(range_click)
            self._tile_checks.setdefault(photo.uid, []).append(check)
            item._checks.append((photo.uid, check))
            badge = Gtk.Label(label="▶" if photo.is_video else "★" if photo.favourite else "")
            badge.set_halign(Gtk.Align.END)
            badge.set_valign(Gtk.Align.END)
            badge.set_margin_end(8)
            badge.set_margin_bottom(8)
            badge.add_css_class("halyard-photo-badge")
            badge.set_visible(photo.is_video or photo.favourite)
            overlay.add_overlay(badge)
            tiles.append(overlay)
            picture.connect("map", lambda image, p=photo: self._load_thumbnail(p, image))
        for _ in range(self._columns - len(row.photos)):
            tiles.append(Gtk.Box(hexpand=True))
        box.append(tiles)

    def _load_thumbnail(self, photo: Photo, picture: Gtk.Picture) -> None:
        cached = self._textures.get(photo.uid)
        if cached:
            self._textures.move_to_end(photo.uid)
            picture.set_paintable(cached)
            return
        request = self._request
        def paint(texture: Gdk.Texture | None) -> None:
            # GTK owns the widget, but not necessarily its Python wrapper.
            # Keep that wrapper alive until the asynchronous reply arrives.
            if request == self._request:
                picture.set_paintable(texture)
                if texture is None:
                    picture.set_tooltip_text(f"{photo.name}\nNo preview available. You can still download the original.")
        self._thumb_waiters.setdefault(photo.uid, []).append(paint)
        if not self._thumb_idle:
            self._thumb_idle = GLib.idle_add(self._request_thumbnails)

    def _request_thumbnails(self) -> bool:
        self._thumb_idle = 0
        if self._thumb_busy or not self._thumb_waiters:
            return False
        self._thumb_busy = True
        request = self._request
        uids = list(self._thumb_waiters)[:12]
        callbacks = {uid: self._thumb_waiters.pop(uid) for uid in uids}
        def complete(thumbnails: tuple[PhotoThumbnail, ...]) -> None:
            if request != self._request:
                return
            self._thumb_busy = False
            results = {t.uid: texture_from_thumbnail(t) for t in thumbnails}
            for uid in uids:
                texture = results.get(uid)
                if texture:
                    self._textures[uid] = texture
                    while len(self._textures) > 128:
                        self._textures.popitem(last=False)
                for callback in callbacks[uid]:
                    callback(texture)
            if self._thumb_waiters:
                self._thumb_idle = GLib.idle_add(self._request_thumbnails)
        self.client.get_photo_thumbnails(uids, complete, lambda _message: complete(()))
        return False

    def _tile_clicked(self, photo: Photo) -> None:
        if self._selecting:
            if photo.uid in self._selected:
                self._selected.remove(photo.uid)
            else:
                self._selected.add(photo.uid)
            self._selection_anchor = photo.uid
            self._update_selection()
        else:
            self.window.open_photo(photo, tuple(self._photos))

    def _range_pressed(self, gesture, _count, _x, _y, uid: str) -> None:
        gesture._range_target = None
        if gesture.get_current_event_state() & Gdk.ModifierType.SHIFT_MASK:
            gesture._range_target = (self._request, uid)
            # Suppress the normal button/check toggle for this Shift click.
            gesture.set_state(Gtk.EventSequenceState.CLAIMED)

    def _range_cancelled(self, gesture, *_args) -> None:
        gesture._range_target = None

    def _range_released(self, gesture, _count, x, y) -> None:
        target = getattr(gesture, "_range_target", None)
        gesture._range_target = None
        tile = gesture.get_widget()
        if (not target or target[0] != self._request or self._stack.get_visible_child_name() != "photos" or
                not (0 <= x < tile.get_width() and 0 <= y < tile.get_height())):
            return
        if self._select_range(target[1]):
            tile.get_child().grab_focus()

    def _select_range(self, uid: str) -> bool:
        # Rows reflect the displayed month grouping, including off-screen tiles.
        uids = [p.uid for i in range(self._rows.get_n_items()) for p in self._rows.get_item(i).photos]
        if uid not in uids or uid not in {p.uid for p in self._photos}:
            return False
        if self._selection_anchor not in uids:
            self._selection_anchor = uid
        start, end = sorted((uids.index(self._selection_anchor), uids.index(uid)))
        self._selecting = True
        self._selected.update(uids[start:end + 1])
        self._update_selection()
        return True

    def _check_toggled(self, check: Gtk.CheckButton, uid: str) -> None:
        if self._updating_checks:
            return
        if check.get_active():
            self._selected.add(uid)
        else:
            self._selected.discard(uid)
        self._selection_anchor = uid
        self._update_selection()

    def _toggle_selection(self, *_args) -> None:
        self._selecting = not self._selecting
        if not self._selecting:
            self._selected.clear()
            self._selection_anchor = None
        self._update_selection()

    def _update_selection(self) -> None:
        self._select_button.set_label("Done" if self._selecting else "Select")
        self._selection_bar.set_revealed(bool(self._selected))
        selected = [p for p in self._photos if p.uid in self._selected]
        noun = "photo" if len(selected) == 1 else "photos"
        size = f" · {format_size(sum(p.size or 0 for p in selected))}" if selected and all(p.size is not None and not p.related_uids for p in selected) else ""
        self._selection_label.set_label(f"{len(selected)} {noun} selected{size}")
        available = bool(selected) and not self._management_busy
        self._selection_menu.set_sensitive(available)
        self._trash_button.set_sensitive(available and all(p.can_trash for p in selected))
        self._favourite_selection.set_sensitive(available and all(p.can_favourite for p in selected) and any(not p.favourite for p in selected))
        self._unfavourite_selection.set_sensitive(available and all(p.can_favourite for p in selected) and any(p.favourite for p in selected))
        self._remove_from_album_button.set_sensitive(available and bool(self._album and self._album.can_write))
        self._updating_checks = True
        try:
            for uid, checks in self._tile_checks.items():
                for check in checks:
                    check.set_visible(self._selecting)
                    check.set_active(uid in self._selected)
        finally:
            self._updating_checks = False

    def _on_library_changed(self, _client, change) -> None:
        revision = change.get("revision", -1) if isinstance(change, dict) else -1
        self._latest_revision = revision
        if self._loaded and revision != self._revision:
            self._textures.clear()
            self._changed_banner.set_revealed(True)
            self._more.set_sensitive(False)

    def selected_items(self) -> list[Photo]:
        return [p for p in self._photos if p.uid in self._selected]

    def _location(self):
        return (self._albums_mode, self._album.uid if self._album else None,
                self._kind.get_selected(), self._search_entry.get_text(), self._year, self._month)

    def _begin_management(self, label: str, operation_id: str | None = None) -> None:
        self._management_errors.clear()
        self._management_error_banner.set_revealed(False)
        self._management_busy = True
        self._management_cancelled = False
        self._management_id = operation_id
        self._management_label.set_label(label)
        self._management_bar.set_revealed(True)
        self._cancel_management.set_visible(operation_id is not None)
        self._cancel_management.set_sensitive(True)
        self._update_controls()
        self._update_selection()
        self.emit("management-changed", True, operation_id is not None)

    def _finish_management(self) -> None:
        self._management_busy = False
        self._management_id = None
        self._management_bar.set_revealed(False)
        self._update_controls()
        self._update_selection()
        self.emit("management-changed", False, False)

    def cancel_management(self, *_args) -> None:
        if not self._management_busy: return
        self._management_cancelled = True
        if self._management_id:
            operation_id, epoch = self._management_id, self._account_epoch
            self._cancel_management.set_sensitive(False)
            self._management_label.set_label("Cancelling… Completed changes are kept.")
            def failed(message):
                if epoch == self._account_epoch and self._management_busy and self._management_id == operation_id:
                    self.window.toast(message)
            self.client.cancel_photo_operation(operation_id, failed)

    def _manage(self, items: list[Photo], action: str, *, album: PhotoAlbum | None = None, favourite: bool | None = None) -> None:
        if self._management_busy or not self.window.account_logged_in:
            return
        items = list({p.uid: p for p in items}.values())
        if not items:
            self.window.toast("Choose at least one photo.")
            return
        if action == "favourite" and not all(p.can_favourite for p in items):
            self.window.toast("Only photos in your own library can have their favourites changed here.")
            return
        if action != "favourite" and (not album or not album.can_write):
            self.window.toast("This album is read-only. Editing access is required.")
            return
        epoch, location = self._account_epoch, self._location()
        scroll_serial = self._scroll_input_serial
        position = self._scroll_restore_position
        if position is None: position = self._scrolled.get_vadjustment().get_value()
        operation_id = str(uuid.uuid4())
        self._begin_management("Updating your photo library…", operation_id)
        next_index, finished = 0, False
        confirmed: set[str] = set()
        errors: dict[str, str] = {}
        def current(batch_id=None):
            return not finished and epoch == self._account_epoch and self._management_busy and (batch_id is None or batch_id == self._management_id)
        def finish(unattempted=None):
            nonlocal finished
            if not current(): return
            finished = True
            if unattempted:
                errors.update((p.uid, unattempted) for p in items[next_index:])
            if action == "add" and self._location() == location:
                self._selected.difference_update(confirmed)
                if self._selection_anchor in confirmed:
                    self._selection_anchor = None
            self._management_errors = [(p.name, errors[p.uid]) for p in items if p.uid in errors]
            if errors or self._management_cancelled:
                self._management_error_banner.set_revealed(bool(self._management_errors))
                message = next(iter(errors.values()), "Completed changes are kept.")
                self.window.toast(f"{'Cancelled. ' if self._management_cancelled else ''}{len(confirmed)} of {len(items)} photos updated. {message}")
            else:
                self.window.toast({"favourite": "Favourites updated", "add": "Photos are in the album", "remove": "Photos removed from album; originals kept"}[action])
            self._finish_management()
            if self._location() == location:
                self.reload(preserve=True, scroll_position=position if self._scroll_input_serial == scroll_serial else None)
        def send_batch():
            nonlocal next_index
            if not current(): return
            if self._management_cancelled:
                finish("Cancelled before this photo was updated."); return
            # Fresh metadata, linked assets and preservation can take several
            # requests per photo. Keep progress and cancellation responsive.
            batch = items[next_index:next_index + 25]
            batch_id = self._management_id
            request = {"operationId": batch_id, "action": action, "uids": [p.uid for p in batch]}
            if album: request["albumUid"] = album.uid
            if favourite is not None: request["favourite"] = favourite
            self._management_label.set_label(f"Updating photos… {next_index} of {len(items)} processed; {len(confirmed)} confirmed")
            next_index += len(batch)
            def done(result):
                if not current(batch_id): return
                requested = set(request["uids"])
                outcomes = {r.uid: r for r in result.results if r.uid in requested}
                for uid in requested:
                    outcome = outcomes.get(uid)
                    if outcome and outcome.ok: confirmed.add(uid)
                    else: errors[uid] = (outcome.error if outcome else None) or "No confirmed result was returned."
                self._management_cancelled |= result.cancelled
                if self._management_cancelled:
                    finish("Cancelled before this photo was updated.")
                elif next_index == len(items): finish()
                else:
                    self._management_id = str(uuid.uuid4())
                    send_batch()
            def failed(message):
                if not current(batch_id): return
                self.client.cancel_photo_operation(batch_id, lambda _message: None)
                errors.update((p.uid, message) for p in batch)
                finish("Not attempted because an earlier request failed.")
            self.client.manage_photos(request, done, failed)
        send_batch()

    def show_management_errors(self) -> None:
        if not self._management_errors: return
        dialog = Adw.AlertDialog(heading="Photo changes", body=(
            "Completed changes are kept. These photos could not be updated. "
            "Check the library before retrying unconfirmed changes."))
        details = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        for name, error in self._management_errors:
            details.append(Gtk.Label(label=f"{name}\n{error}", wrap=True, xalign=0, selectable=True))
        scroll = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER, min_content_height=100,
                                   max_content_height=300, propagate_natural_height=True)
        scroll.set_child(details)
        dialog.set_extra_child(scroll)
        dialog.add_response("close", "Close")
        dialog.add_response("dismiss", "Dismiss warning")
        dialog.set_default_response("close"); dialog.set_close_response("close")
        def respond(_dialog, response):
            if response == "dismiss":
                self._management_errors.clear()
                self._management_error_banner.set_revealed(False)
                self.emit("management-changed", self._management_busy, self._management_id is not None)
        dialog.connect("response", respond)
        dialog.present(self.window)

    def set_favourites(self, items: list[Photo], favourite: bool) -> None:
        self._manage(items, "favourite", favourite=favourite)

    def add_to_album(self, items: list[Photo]) -> None:
        if not items or self._management_busy: return
        request = self._request
        def ready(albums):
            if request != self._request or not self.window.account_logged_in: return
            choices = tuple(a for a in albums if a.can_write)
            if not choices:
                self.window.toast("Create an album first, or ask for editing access to a shared album.")
                return
            dialog = Adw.AlertDialog(heading="Add to album", body=(
                "Originals stay available. Linked live-photo files are included. "
                "Photos from another user’s library are copied into the destination album."))
            picker = Gtk.DropDown.new_from_strings([a.name + (" · Shared with you" if a.shared_with_me else "") for a in choices])
            dialog.set_extra_child(picker)
            dialog.add_response("cancel", "Cancel"); dialog.add_response("add", "Add")
            dialog.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED)
            dialog.set_default_response("add"); dialog.set_close_response("cancel")
            def respond(_dialog, response):
                if response == "add" and request == self._request and self.window.account_logged_in:
                    self._manage(items, "add", album=choices[picker.get_selected()])
            dialog.connect("response", respond); dialog.present(self.window)
        self.client.list_photo_albums(ready, self.window.toast)

    def remove_from_album(self, items: list[Photo]) -> None:
        album = self._album
        if not items or not album or not album.can_write or self._management_busy: return
        request = self._request
        dialog = Adw.AlertDialog(heading="Remove from album", body=(
            f"Remove the selected photos from “{album.name}”? The originals are kept. "
            "Album-only photos are saved to your timeline first; photos shared with you are copied there. "
            "Linked live-photo files are included. A photo stays in the album if it cannot be saved."))
        dialog.add_response("cancel", "Cancel"); dialog.add_response("remove", "Remove")
        dialog.set_default_response("cancel"); dialog.set_close_response("cancel")
        def respond(_dialog, response):
            if response == "remove" and request == self._request and self.window.account_logged_in:
                self._manage(items, "remove", album=album)
        dialog.connect("response", respond); dialog.present(self.window)

    def edit_album(self, album: PhotoAlbum | None = None) -> None:
        if self._management_busy or (album and not album.can_write): return
        epoch = self._account_epoch
        dialog = Adw.AlertDialog(heading="Rename album" if album else "Create album")
        entry = Adw.EntryRow(title="Album name", text=album.name if album else "")
        group = Adw.PreferencesGroup()
        group.add(entry)
        dialog.set_extra_child(group)
        dialog.add_response("cancel", "Cancel"); dialog.add_response("save", "Rename" if album else "Create")
        dialog.set_response_appearance("save", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("save"); dialog.set_close_response("cancel")
        def validate(*_):
            name = entry.get_text().strip()
            dialog.set_response_enabled("save", bool(name) and len(name) <= 255 and not any(ord(c) < 32 or c in "/\\" for c in name))
        entry.connect("changed", validate)
        validate()
        def respond(_dialog, response):
            if response != "save" or epoch != self._account_epoch or not self.window.account_logged_in or self._management_busy: return
            self._begin_management("Renaming album…" if album else "Creating album…")
            def done(updated):
                if epoch != self._account_epoch: return
                self._finish_management()
                self.window.toast("Album renamed" if album else "Album created")
                if self._album and self._album.uid == updated.uid:
                    self._album = updated
                    self._update_controls()
                    self.reload(preserve=True)
                elif self._albums_mode:
                    self.reload()
            def failed(message):
                if epoch != self._account_epoch: return
                self._finish_management(); self.window.toast(message)
                self.reload(preserve=True)
            if album:
                self.client.rename_photo_album(album.uid, entry.get_text().strip(), done, failed)
            else:
                self.client.create_photo_album(entry.get_text().strip(), done, failed)
        dialog.connect("response", respond); dialog.present(self.window)

    def delete_album(self, album: PhotoAlbum | None) -> None:
        if not album or not album.can_delete or self._management_busy: return
        epoch = self._account_epoch
        dialog = Adw.AlertDialog(heading="Delete album", body=(
            f"Permanently delete “{album.name}”? This cannot be undone. The photos remain available in your timeline. "
            "Any album-only photos are saved there first, including linked live-photo files. "
            "If a photo cannot be saved, the album will not be deleted."))
        dialog.add_response("cancel", "Cancel"); dialog.add_response("delete", "Delete album")
        dialog.set_response_appearance("delete", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel"); dialog.set_close_response("cancel")
        def respond(_dialog, response):
            if response != "delete" or epoch != self._account_epoch or not self.window.account_logged_in or self._management_busy: return
            # The pinned SDK has no abort signal for album create/rename/delete.
            self._begin_management("Saving album-only photos and deleting album…")
            def done(_result):
                if epoch != self._account_epoch: return
                self._finish_management()
                self.window.toast("Album deleted; photos kept in your timeline")
                if self._album and self._album.uid == album.uid:
                    self.show_albums()
                elif self._albums_mode:
                    self.reload()
            def failed(message):
                if epoch != self._account_epoch: return
                self._finish_management(); self.window.toast(f"Album deletion could not be confirmed. {message}")
                self.reload(preserve=True)
            self.client.delete_photo_album(album.uid, done, failed)
        dialog.connect("response", respond); dialog.present(self.window)

    def trash_items(self, items: list[Photo]) -> None:
        if not items: return
        if self._management_busy: return
        if not all(p.can_trash for p in items):
            self.window.toast("Only photos in your own library can be moved to Trash here."); return
        if len(items) > 100:
            self.window.toast("Select at most 100 photos to move to Trash at once."); return
        request = self._request
        dialog = Adw.AlertDialog(heading="Move to Trash", body=(
            f"{len(items)} selected photos will be removed from your gallery and albums. "
            "Linked live-photo files are included. You can restore them from Trash in Proton Drive. "
            "Downloaded copies on this computer stay in place."))
        dialog.add_response("cancel", "Cancel"); dialog.add_response("trash", "Move to Trash")
        dialog.set_response_appearance("trash", Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.set_default_response("cancel"); dialog.set_close_response("cancel")
        def respond(_dialog, response):
            if response != "trash" or request != self._request or not self.window.account_logged_in: return
            self._trash_button.set_sensitive(False)
            self.window.toast("Moving photos to Trash…")
            def done(results):
                self._trash_button.set_sensitive(True)
                if request != self._request: return
                failures = [r for r in results if not r.ok]
                if failures:
                    self.window.toast(f"Some files could not be moved to Trash: {failures[0].error}")
                else: self.window.toast("Selected photos moved to Trash")
                self.window.close_photo()
                self.reload()
            def failed(message):
                self._trash_button.set_sensitive(True)
                if request == self._request: self.window.toast(message)
            self.client.trash_photos([p.uid for p in items], done, failed)
        dialog.connect("response", respond); dialog.present(self.window)

    def download_items(self, items: list[Photo]) -> None:
        if not items:
            return
        if len(items) > 1000:
            self.window.toast("Select at most 1,000 photos at a time.")
            return
        pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) or os.path.join(os.path.expanduser("~"), "Pictures")
        destination = [self.settings.get_string("photo-download-folder") or os.path.join(pictures, "Proton Photos")]
        dialog = Adw.AlertDialog(heading="Download photo" if len(items) == 1 else f"Download {len(items)} photos")
        dialog.set_body("Save original files to this computer. Existing files are kept, and linked live-photo images and videos are included.")
        extra = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        folder_row = Adw.ActionRow(title="Download folder")
        change = Gtk.Button(label="Change…", valign=Gtk.Align.CENTER)
        folder_row.add_suffix(change)
        extra.append(folder_row)
        notice = Gtk.Label(wrap=True, xalign=0)
        notice.add_css_class("dim-label")
        extra.append(notice)
        def describe() -> None:
            folder_row.set_subtitle(GLib.markup_escape_text(tilde_path(destination[0])))
            paired = [p for p in self.window.folder_pairs if paths_overlap(destination[0], p.local_path)]
            notice.set_label("Photos saved inside a synced folder will also sync to Proton Drive, unless excluded." if paired else "Downloaded copies do not create a folder pair.")
        def choose(*_args) -> None:
            chooser = Gtk.FileDialog(title="Choose a photo download folder", modal=True)
            initial = destination[0] if os.path.isdir(destination[0]) else pictures if os.path.isdir(pictures) else os.path.expanduser("~")
            chooser.set_initial_folder(Gio.File.new_for_path(initial))
            def chosen(source, result) -> None:
                try:
                    selected = source.select_folder_finish(result)
                    folder = selected.get_path()
                    if folder:
                        destination[0] = folder
                        describe()
                except GLib.Error:
                    pass
            chooser.select_folder(self.window, None, chosen)
        change.connect("clicked", choose)
        describe()
        dialog.set_extra_child(extra)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("download", "Download")
        dialog.set_response_appearance("download", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("download")
        dialog.set_close_response("cancel")
        def respond(_dialog, response: str) -> None:
            if response != "download":
                return
            def started(_job) -> None:
                self.settings.set_string("photo-download-folder", destination[0])
                self._selected.clear()
                self._selecting = False
                self._update_selection()
                self.window.toast("Photo download started. Track its progress in Activity.")
            self.client.start_photo_download([p.uid for p in items], destination[0], started, self.window.toast)
        dialog.connect("response", respond)
        dialog.present(self.window)


class PhotoPreviewPage(Adw.NavigationPage):
    def __init__(self, client, window, photo: Photo, photos: tuple[Photo, ...], management: PhotosView) -> None:
        # A popped page can remain parented during its closing animation.
        # Previews are addressed by object, so they do not need a shared tag.
        super().__init__(title=photo.name)
        self._client = client
        self._window = window
        self._management = management
        self._management_handler = management.connect("management-changed", self._management_changed)
        self._photos = photos
        self._index = next((i for i, p in enumerate(photos) if p.uid == photo.uid), 0)
        self._request = 0
        self._texture = None
        self._zoomed = False
        self._video_session = None
        self._media = None
        self._video_handler = client.connect("video-preview-changed", self._video_changed)
        self._photos_handler = client.connect("photos-changed", self._library_changed)
        self._metadata_request = 0
        self._metadata_pending = True
        self._metadata_available = False
        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        self._title = Adw.WindowTitle(title=photo.name)
        header.set_title_widget(self._title)
        zoom = Gtk.Button(icon_name="zoom-in-symbolic", tooltip_text="Toggle full-size preview")
        zoom.connect("clicked", self._zoom)
        self._zoom_button = zoom
        header.pack_end(zoom)
        trash = Gtk.Button(icon_name="user-trash-symbolic", tooltip_text="Move to Trash")
        trash.connect("clicked", lambda *_: window.trash_photos([self._photos[self._index]]))
        header.pack_end(trash)
        self._trash_button = trash
        self._favourite_button = Gtk.Button(icon_name="non-starred-symbolic", tooltip_text="Add to favourites")
        self._favourite_button.connect("clicked", self._favourite_clicked)
        header.pack_end(self._favourite_button)
        album = Gtk.Button(icon_name="folder-new-symbolic", tooltip_text="Add to album…")
        album.connect("clicked", lambda *_: window.add_photos_to_album([self._photos[self._index]]))
        header.pack_end(album)
        self._album_button = album
        self._details = Gtk.MenuButton(icon_name="dialog-information-symbolic", tooltip_text="Photo details")
        self._detail_label = Gtk.Label(wrap=True, xalign=0)
        self._detail_label.set_margin_top(16)
        self._detail_label.set_margin_bottom(16)
        self._detail_label.set_margin_start(16)
        self._detail_label.set_margin_end(16)
        self._details.set_popover(Gtk.Popover(child=self._detail_label))
        header.pack_end(self._details)
        download = Gtk.Button(label="Download…")
        download.add_css_class("suggested-action")
        download.connect("clicked", lambda *_: window.download_photos([self._photos[self._index]]))
        header.pack_end(download)
        toolbar.add_top_bar(header)
        self._stack = Gtk.Stack(vexpand=True)
        loading = Adw.StatusPage(title="Loading preview…")
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        loading.set_child(spinner)
        self._stack.add_named(loading, "loading")
        self._picture = Gtk.Picture(content_fit=Gtk.ContentFit.CONTAIN, can_shrink=True)
        self._picture.set_margin_top(16)
        self._picture.set_margin_bottom(16)
        self._picture.set_margin_start(16)
        self._picture.set_margin_end(16)
        scroll = Gtk.ScrolledWindow()
        scroll.set_child(self._picture)
        self._stack.add_named(scroll, "preview")
        self._video = Gtk.Video(autoplay=True, hexpand=True, vexpand=True)
        self._stack.add_named(self._video, "video")
        self._error = Adw.StatusPage(icon_name="image-missing-symbolic", title="Preview unavailable",
                                    description="You can download the original and open it in another application.")
        retry = Gtk.Button(label="Try again", halign=Gtk.Align.CENTER)
        retry.connect("clicked", lambda *_: self._load())
        self._error.set_child(retry)
        self._stack.add_named(self._error, "error")
        toolbar.set_content(self._stack)
        footer = Gtk.Box(spacing=12)
        self._previous = Gtk.Button(icon_name="go-previous-symbolic", tooltip_text="Previous photo")
        self._previous.connect("clicked", lambda *_: self._step(-1))
        footer.append(self._previous)
        self._caption = Gtk.Label(hexpand=True, wrap=True)
        self._caption.add_css_class("dim-label")
        footer.append(self._caption)
        self._cancel_button = Gtk.Button(label="Cancel change", visible=False)
        self._cancel_button.connect("clicked", management.cancel_management)
        footer.append(self._cancel_button)
        self._error_details = Gtk.Button(label="Change details", visible=False)
        self._error_details.connect("clicked", lambda *_: management.show_management_errors())
        footer.append(self._error_details)
        self._play_button = Gtk.Button(label="Play video", visible=False)
        self._play_button.connect("clicked", self._play_video)
        footer.append(self._play_button)
        self._next = Gtk.Button(icon_name="go-next-symbolic", tooltip_text="Next photo")
        self._next.connect("clicked", lambda *_: self._step(1))
        footer.append(self._next)
        PhotosView._margin(footer, 10)
        toolbar.add_bottom_bar(footer)
        keys = Gtk.EventControllerKey()
        keys.connect("key-pressed", self._key_pressed)
        self.add_controller(keys)
        self.set_child(toolbar)
        self._load()

    def reset(self) -> None:
        self._request += 1
        self._metadata_request += 1
        self._release_video()
        if self._video_handler:
            self._client.disconnect(self._video_handler)
            self._video_handler = None
        if self._photos_handler:
            self._client.disconnect(self._photos_handler)
            self._photos_handler = None
        if self._management_handler:
            self._management.disconnect(self._management_handler)
            self._management_handler = None
        self._picture.set_paintable(None)
        self._texture = None

    def _management_changed(self, _view, _busy, _cancellable) -> None:
        self._update_photo_actions()

    def _update_photo_actions(self) -> None:
        photo = self._photos[self._index]
        busy = self._management._management_busy
        available = self._metadata_available and not self._metadata_pending and not busy
        self._favourite_button.set_icon_name("starred-symbolic" if photo.favourite else "non-starred-symbolic")
        self._favourite_button.set_tooltip_text(("Remove from favourites" if photo.favourite else "Add to favourites") if photo.can_favourite else "Favourites can be changed for photos in your own library")
        self._favourite_button.set_sensitive(photo.can_favourite and available)
        self._trash_button.set_sensitive(photo.can_trash and available)
        self._album_button.set_sensitive(available)
        self._cancel_button.set_visible(busy and self._management._management_id is not None)
        self._error_details.set_visible(bool(self._management._management_errors))

    def _favourite_clicked(self, *_args) -> None:
        photo = self._photos[self._index]
        self._window.favourite_photos([photo], not photo.favourite)

    def _library_changed(self, *_args) -> None:
        self._metadata_request += 1
        metadata_request, request = self._metadata_request, self._request
        uid = self._photos[self._index].uid
        self._metadata_pending = True
        self._update_photo_actions()
        def loaded(photo):
            if request != self._request or metadata_request != self._metadata_request: return
            self._metadata_pending = False
            self._metadata_available = True
            self._photos = tuple(photo if p.uid == uid else p for p in self._photos)
            self._update_photo_actions()
            self.set_title(photo.name)
            self._title.set_title(photo.name)
        def failed(message):
            if request != self._request or metadata_request != self._metadata_request: return
            self._metadata_pending = False
            self._metadata_available = False
            self._update_photo_actions()
            self._favourite_button.set_tooltip_text(message)
        self._client.get_photo(uid, loaded, failed)

    def _release_video(self):
        if self._media:
            self._media.pause()
            self._video.set_media_stream(None)
            self._media = None
        if self._video_session:
            self._client.release_video_preview(self._video_session.id)
            self._video_session = None

    def _video_changed(self, _client, preview):
        if self._video_session and preview.id == self._video_session.id and preview.error:
            self._error.set_description(preview.error)
            self._stack.set_visible_child_name("error")
            self._release_video()
            self._play_button.set_sensitive(True)

    def _play_video(self, *_):
        photo = self._photos[self._index]
        if not photo.is_video: return
        self._release_video()
        request = self._request
        self._play_button.set_sensitive(False)
        self._stack.set_visible_child_name("loading")
        def failed(message):
            if request != self._request: return
            self._error.set_description(message)
            self._stack.set_visible_child_name("error")
            self._play_button.set_sensitive(True)
            self._release_video()
        def ready(preview):
            if request != self._request:
                self._client.release_video_preview(preview.id); return
            if not preview.uri:
                self._client.release_video_preview(preview.id)
                failed(preview.error or "Could not start video playback."); return
            self._video_session = preview
            self._media = Gtk.MediaFile.new_for_file(Gio.File.new_for_uri(preview.uri))
            def media_error(media, _property):
                if request == self._request and media.get_error():
                    failed("This video could not be played. Check your system’s media codecs, or download the original to open it in another player.")
            self._media.connect("notify::error", media_error)
            if self._media.get_error():
                media_error(self._media, None); return
            self._video.set_media_stream(self._media)
            self._stack.set_visible_child_name("video")
            self._play_button.set_sensitive(True)
        self._client.start_video_preview(photo.uid, ready, failed)

    def _step(self, delta: int) -> None:
        index = self._index + delta
        if 0 <= index < len(self._photos):
            self._index = index
            self._load()

    def _key_pressed(self, _controller, key, _code, _state) -> bool:
        if key == Gdk.KEY_Left:
            self._step(-1)
        elif key == Gdk.KEY_Right:
            self._step(1)
        elif key == Gdk.KEY_Escape:
            self._window.close_photo()
        else:
            return False
        return True

    def _zoom(self, *_args) -> None:
        self._zoomed = not self._zoomed
        self._picture.set_size_request(self._texture.get_width() if self._zoomed and self._texture else -1,
                                       self._texture.get_height() if self._zoomed and self._texture else -1)

    def _load(self) -> None:
        self._release_video()
        self._request += 1
        request = self._request
        photo = self._photos[self._index]
        self.set_title(photo.name)
        self._album_button.set_sensitive(True)
        self._update_photo_actions()
        self._title.set_title(photo.name)
        self._title.set_subtitle(format_absolute_time(photo.capture_time))
        self._previous.set_sensitive(self._index > 0)
        self._next.set_sensitive(self._index < len(self._photos) - 1)
        self._caption.set_label(f"{self._index + 1} of {len(self._photos)} · " +
                                ("Video. Streamed preview. Download verifies the original." if photo.is_video else "Preview. Download saves the original photo."))
        self._detail_label.set_label(f"{photo.name}\n\nTaken: {format_absolute_time(photo.capture_time)}\n"
                                     f"Size: {format_size(photo.size) if photo.size is not None else 'Unknown'}\n"
                                     f"Type: {photo.media_type or 'Unknown'}\n"
                                     f"Related files: {len(photo.related_uids)}")
        self._zoom_button.set_visible(not photo.is_video)
        self._play_button.set_visible(photo.is_video)
        self._play_button.set_sensitive(True)
        self._zoomed = False
        self._picture.set_size_request(-1, -1)
        self._picture.set_paintable(None)
        self._texture = None
        self._stack.set_visible_child_name("loading")
        def loaded(thumbnails: tuple[PhotoThumbnail, ...]) -> None:
            if request != self._request:
                return
            texture = texture_from_thumbnail(thumbnails[0]) if thumbnails else None
            self._texture = texture
            self._picture.set_paintable(texture)
            self._stack.set_visible_child_name("preview" if texture else "error")
        def error(message: str) -> None:
            if request == self._request:
                self._error.set_description(message)
                self._stack.set_visible_child_name("error")
        self._client.get_photo_thumbnails([photo.uid], loaded, error, preview=True)
        self._library_changed()
