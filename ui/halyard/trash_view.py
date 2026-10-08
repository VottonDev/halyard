"""On-demand Trash browsing and original-location restore."""

from __future__ import annotations

import uuid

from gi.repository import Adw, Gio, GLib, GObject, Gtk, Pango

from .models import TrashItem
from .util import format_absolute_time, format_size


class TrashEntry(GObject.Object):
    """GTK list wrapper around the daemon's immutable item."""

    def __init__(self, item: TrashItem) -> None:
        super().__init__()
        self.item = item
        self.name_key = (GLib.utf8_collate_key_for_filename(item.name.casefold(), -1), item.uid)


def _compare(left, right):
    return Gtk.Ordering.SMALLER if left < right else Gtk.Ordering.LARGER if left > right else Gtk.Ordering.EQUAL


class TrashPage(Adw.NavigationPage):
    def __init__(self, client, window) -> None:
        super().__init__(title="Trash", tag="trash")
        self._client = client
        self._window = window
        self._listing_id = ""
        self._request = 0
        self._jobs_request = 0
        self._account_generation = 0
        self._loading = False
        self._starting = False
        self._restoring = False
        self._disposed = False
        self._active = False
        self._cursor = None
        self._items: dict[str, TrashItem] = {}
        self._selected: set[str] = set()
        self._job_rows = []
        self._expanded: set[str] = set()
        self._dialog = None
        self._results_dialog = None
        self._jobs_group = None
        self._jobs = ()
        self._changing_selection = False

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh Trash")
        refresh.connect("clicked", lambda *_: self.reload())
        header.pack_end(refresh)
        toolbar.add_top_bar(header)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self._message = Adw.Banner(button_label="Reload")
        self._message.connect("button-clicked", lambda *_: self.reload())
        outer.append(self._message)
        content = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12,
                          margin_top=12, margin_bottom=16, margin_start=16, margin_end=16)
        outer.append(content)

        controls = Gtk.Box(spacing=12)
        self._source = Gtk.DropDown.new_from_strings(["Files and folders", "Photos"])
        self._source.set_tooltip_text("Choose which Trash to browse")
        self._source.connect("notify::selected", lambda *_: self.reload())
        controls.append(self._source)
        self._count = Gtk.Label(xalign=1, hexpand=True)
        self._count.add_css_class("dim-label")
        controls.append(self._count)
        content.append(controls)

        self._store = Gio.ListStore.new(TrashEntry)
        self._sorted = Gtk.SortListModel.new(self._store, None)
        self._selection = Gtk.MultiSelection.new(self._sorted)
        self._selection.connect("selection-changed", self._selection_changed)
        self._table = Gtk.ColumnView.new(self._selection)
        self._table.set_show_row_separators(True)
        name_sorter = Gtk.CustomSorter.new(lambda a, b, *_: _compare(a.name_key, b.name_key))
        self._name_column = Gtk.ColumnViewColumn.new("Name", self._name_factory())
        self._name_column.set_sorter(name_sorter)
        self._name_column.set_expand(True)
        self._name_column.set_resizable(True)
        self._name_column.set_fixed_width(220)
        self._table.append_column(self._name_column)
        self._date_column = Gtk.ColumnViewColumn.new("Deleted", self._metadata_factory("date"))
        self._date_column.set_sorter(Gtk.CustomSorter.new(lambda a, b, *_: _compare(
            a.item.trashed_at if a.item.trashed_at is not None else -1,
            b.item.trashed_at if b.item.trashed_at is not None else -1)))
        self._date_column.set_fixed_width(140)
        self._table.append_column(self._date_column)
        size_column = Gtk.ColumnViewColumn.new("Size", self._metadata_factory("size"))
        size_column.set_sorter(Gtk.CustomSorter.new(lambda a, b, *_: _compare(
            a.item.size if a.item.size is not None else -1,
            b.item.size if b.item.size is not None else -1)))
        size_column.set_fixed_width(115)
        size_column.set_resizable(True)
        self._table.append_column(size_column)
        # The SDK pages are unordered. Sort the loaded objects without changing
        # the daemon cursor or the selection's association with those objects.
        sorter = Gtk.MultiSorter.new()
        sorter.append(self._table.get_sorter())
        sorter.append(name_sorter)
        self._sorted.set_sorter(sorter)
        self._table.sort_by_column(self._date_column, Gtk.SortType.DESCENDING)
        self._scrolled = Gtk.ScrolledWindow(vexpand=True, hscrollbar_policy=Gtk.PolicyType.AUTOMATIC)
        self._scrolled.set_child(self._table)
        frame = Gtk.Frame(child=self._scrolled)
        self._stack = Gtk.Stack(vexpand=True, hhomogeneous=False, vhomogeneous=False)
        self._stack.add_named(frame, "list")
        self._empty = Adw.StatusPage(icon_name="user-trash-symbolic", title="Trash is empty")
        self._stack.add_named(self._empty, "empty")
        self._placeholder = Adw.StatusPage(icon_name="user-trash-symbolic", title="Loading Trash…")
        self._stack.add_named(self._placeholder, "loading")
        content.append(self._stack)

        self._job_bar = Gtk.Box(spacing=8, visible=False)
        self._job_icon = Gtk.Image(icon_name="object-select-symbolic")
        self._job_bar.append(self._job_icon)
        self._job_status = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self._job_bar.append(self._job_status)
        self._cancel_job = Gtk.Button(label="Cancel", visible=False)
        self._cancel_job.connect("clicked", lambda button: self._cancel_restore(button, self._jobs[0].id) if self._jobs else None)
        self._job_bar.append(self._cancel_job)
        details = Gtk.Button(label="Details")
        details.connect("clicked", lambda *_: self._show_results())
        self._job_bar.append(details)
        content.append(self._job_bar)

        self._footer = Gtk.Box(spacing=8)
        self._selection_label = Gtk.Label(label="Select items to restore", xalign=0,
                                        hexpand=True, ellipsize=Pango.EllipsizeMode.END)
        self._selection_label.add_css_class("dim-label")
        self._footer.append(self._selection_label)
        self._loading_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, halign=Gtk.Align.CENTER, visible=False)
        spinner = Adw.Spinner()
        spinner.set_size_request(20, 20)
        self._loading_box.append(spinner)
        cancel = Gtk.Button(icon_name="process-stop-symbolic", tooltip_text="Cancel loading")
        cancel.add_css_class("flat")
        cancel.connect("clicked", lambda *_: self._cancel_loading())
        self._loading_box.append(cancel)
        self._footer.append(self._loading_box)
        self._more = Gtk.Button(label="Load more", visible=False)
        self._more.set_tooltip_text("Load more deleted items and include them in the current sort")
        self._more.connect("clicked", lambda *_: self._load_more() if self._listing_id else self.reload())
        self._footer.append(self._more)
        self._restore = Gtk.Button(label="Restore", sensitive=False)
        self._restore.add_css_class("suggested-action")
        self._restore.set_tooltip_text("Restore selected items to their original locations")
        self._restore.connect("clicked", lambda *_: self._confirm_restore())
        self._footer.append(self._restore)
        content.append(self._footer)
        toolbar.set_content(outer)
        self.set_child(toolbar)
        self._handler = client.connect("trash-restores-changed", self._on_jobs)

    def _name_factory(self):
        factory = Gtk.SignalListItemFactory()
        def setup(_factory, cell):
            box = Gtk.Box(spacing=10, margin_start=10, margin_end=10)
            check = Gtk.CheckButton(valign=Gtk.Align.CENTER)
            icon = Gtk.Image(pixel_size=20)
            name = Gtk.Label(xalign=0, hexpand=True, ellipsize=Pango.EllipsizeMode.MIDDLE)
            box.append(check); box.append(icon); box.append(name)
            cell.set_child(box)
            check.connect("toggled", self._toggle_cell, cell)
            cell.connect("notify::selected", lambda item, _spec: check.set_active(item.get_selected()))
        def bind(_factory, cell):
            entry = cell.get_item().item
            box = cell.get_child()
            check = box.get_first_child()
            icon = check.get_next_sibling()
            name = icon.get_next_sibling()
            check.set_sensitive(not bool(entry.error))
            check.set_tooltip_text(entry.error or f"Select {entry.name}")
            check.set_active(cell.get_selected())
            name.set_text(entry.name)
            box.set_tooltip_text(entry.error or entry.name)
            if entry.error:
                icon.set_from_icon_name("dialog-warning-symbolic")
                icon.add_css_class("warning")
            else:
                icon.remove_css_class("warning")
                if entry.type in ("folder", "album"):
                    icon.set_from_icon_name("folder-symbolic" if entry.type == "folder" else "folder-pictures-symbolic")
                else:
                    content_type, _ = Gio.content_type_guess(entry.name, None)
                    icon.set_from_gicon(Gio.content_type_get_symbolic_icon(content_type))
        factory.connect("setup", setup)
        factory.connect("bind", bind)
        return factory

    def _metadata_factory(self, field):
        factory = Gtk.SignalListItemFactory()
        def setup(_factory, cell):
            label = Gtk.Label(xalign=1 if field == "size" else 0,
                              ellipsize=Pango.EllipsizeMode.NONE if field == "size" else Pango.EllipsizeMode.END,
                              margin_start=10, margin_end=10)
            label.add_css_class("dim-label")
            cell.set_child(label)
        def bind(_factory, cell):
            item = cell.get_item().item
            label = cell.get_child()
            if field == "size":
                label.set_text(format_size(item.size) if item.size is not None else "—")
                label.set_tooltip_text(label.get_text())
            else:
                when = GLib.DateTime.new_from_unix_local(int(item.trashed_at / 1000)) if item.trashed_at else None
                label.set_text(when.format("%-d %b %Y") if when else "—")
                label.set_tooltip_text(format_absolute_time(item.trashed_at))
        factory.connect("setup", setup)
        factory.connect("bind", bind)
        return factory

    def _toggle_cell(self, check, cell):
        if cell.get_item() is None or check.get_active() == cell.get_selected(): return
        if check.get_active(): self._selection.select_item(cell.get_position(), False)
        else: self._selection.unselect_item(cell.get_position())

    def _selection_changed(self, *_):
        if self._changing_selection: return
        self._changing_selection = True
        try:
            selected = self._selection.get_selection()
            self._selected.clear()
            for n in range(selected.get_size()):
                position = selected.get_nth(n)
                item = self._sorted.get_item(position).item
                if item.error:
                    self._selection.unselect_item(position)
                    continue
                self._selected.add(item.uid)
        finally: self._changing_selection = False
        self._update_restore()

    @property
    def source(self) -> str:
        return "photos" if self._source.get_selected() == 1 else "drive"

    def activate(self) -> None:
        self._load_jobs()
        self.reload()

    def deactivate(self) -> None:
        self._active = False
        self._request += 1
        if self._listing_id:
            self._client.cancel_trash_listing(self._listing_id)
            self._listing_id = ""
        self._loading = False
        self._loading_box.set_visible(False)
        self._cursor = None
        self._more.set_visible(False)
        self._update_restore()

    def _cancel_loading(self) -> None:
        self.deactivate()
        self._active = True
        self._more.set_label("Reload")
        self._more.set_visible(True)
        self._more.set_sensitive(True)
        if not self._items:
            self._placeholder.set_title("Loading cancelled")
            self._placeholder.set_description("Refresh Trash to try again.")
            self._stack.set_visible_child_name("loading")

    def reset(self) -> None:
        self._account_generation += 1
        self.deactivate()
        self._jobs_request += 1
        if self._dialog: self._dialog.close()
        self._dialog = None
        if self._results_dialog: self._results_dialog.close()
        self._starting = False
        self._restoring = False
        self._expanded.clear()
        self._clear_items()
        self._render_jobs(())
        self._message.set_revealed(False)

    def dispose(self) -> None:
        self.reset()
        self._disposed = True
        self._client.disconnect(self._handler)

    def _error(self, message: str) -> None:
        self._message.set_title(message)
        self._message.set_tooltip_text(message)
        self._message.set_revealed(True)

    def _clear_items(self) -> None:
        self._store.remove_all()
        self._items.clear()
        self._selected.clear()
        self._count.set_text("")
        self._update_restore()

    def reload(self) -> None:
        self.deactivate()
        self._clear_items()
        if self._disposed or not self._window.account_logged_in: return
        self._active = True
        self._message.set_revealed(False)
        self._listing_id = uuid.uuid4().hex
        self._load_more()

    def _load_more(self) -> None:
        if self._loading or not self._listing_id: return
        self._request += 1
        request = self._request
        query = {"source": self.source, "requestId": self._listing_id}
        if self._cursor: query["cursor"] = self._cursor
        self._loading = True
        self._loading_box.set_visible(True)
        self._more.set_label("Loading…")
        self._more.set_sensitive(False)
        if not self._items:
            self._placeholder.set_title("Loading Trash…")
            self._placeholder.set_description("Fetching deleted photos and albums." if self.source == "photos" else "Fetching deleted files and folders.")
            self._stack.set_visible_child_name("loading")

        def finished(page):
            if request != self._request or self._disposed: return
            self._loading = False
            self._loading_box.set_visible(False)
            self._cursor = page.next_cursor
            for item in page.items:
                if item.uid in self._items: continue
                self._items[item.uid] = item
                self._add_item(item)
            self._more.set_label("Load more")
            self._more.set_visible(bool(self._cursor))
            self._more.set_sensitive(True)
            count = len(self._items)
            self._count.set_text(f"{count} {'item' if count == 1 else 'items'}{' loaded' if self._cursor else ''}")
            self._count.set_tooltip_text("Only loaded items are sorted. Load more to include additional deleted items." if self._cursor else "All available items are loaded.")
            self._empty.set_description("Deleted photos and albums will appear here." if self.source == "photos" else "Deleted files and folders will appear here.")
            self._stack.set_visible_child_name("list" if self._items else "empty")
            self._update_restore()

        def failed(message):
            if request != self._request or self._disposed: return
            self.deactivate()
            self._active = True
            self._error(message)
            if not self._items:
                self._placeholder.set_title("Could not load Trash")
                self._placeholder.set_description("Refresh Trash to try again.")
                self._stack.set_visible_child_name("loading")

        self._client.list_trash(query, finished, failed)

    def _add_item(self, item: TrashItem) -> None:
        self._store.append(TrashEntry(item))

    def _update_restore(self) -> None:
        count = len(self._selected)
        self._restore.set_label(f"Restore {count}" if count else "Restore")
        self._restore.set_sensitive(0 < count <= 100 and not self._starting and not self._restoring)
        self._selection_label.set_text("Select up to 100 items" if count > 100 else f"{count} selected" if count else "Select items to restore")

    def _confirm_restore(self) -> None:
        if not self._restore.get_sensitive() or self._dialog or not self._window.account_logged_in: return
        uids = list(self._selected)
        source = self.source
        generation = self._account_generation
        dialog = Adw.AlertDialog(heading="Restore selected items?", body=(
            f"Restore {len(uids)} selected {'item' if len(uids) == 1 else 'items'} to their original locations in Drive?\n\n"
            "Restored folders include their contents. Photos include related image and video assets where available. "
            "Files in paired folders will sync; conflicting local edits are kept as conflict copies.\n\n"
            "If a parent folder is missing or a name is taken, some items may need attention."
        ))
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("restore", "Restore")
        dialog.set_response_appearance("restore", Adw.ResponseAppearance.SUGGESTED)
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")
        self._dialog = dialog

        def response(_dialog, answer):
            self._dialog = None
            if answer == "restore" and source == self.source and generation == self._account_generation and self._window.account_logged_in:
                self._start_restore(source, uids)

        dialog.connect("response", response)
        dialog.present(self._window)

    def _start_restore(self, source: str, uids: list[str]) -> None:
        if self._starting or self._restoring or self._disposed: return
        generation = self._account_generation
        self._starting = True
        self._update_restore()

        def finished(_job):
            if self._disposed or generation != self._account_generation: return
            self._starting = False
            self._load_jobs()
            self._update_restore()

        def failed(message):
            if self._disposed or generation != self._account_generation: return
            self._starting = False
            self._error(message)
            self._update_restore()

        self._client.start_trash_restore(source, uids, finished, failed)

    def _load_jobs(self) -> None:
        if self._disposed or not self._window.account_logged_in: return
        self._jobs_request += 1
        request = self._jobs_request
        def finished(jobs):
            if request == self._jobs_request and not self._disposed: self._render_jobs(jobs)
        self._client.list_trash_restores(finished, lambda message: self._error(message) if request == self._jobs_request and not self._disposed else None)

    def _on_jobs(self, _client, jobs) -> None:
        self._jobs_request += 1
        was_running = self._restoring
        if self._disposed or not self._window.account_logged_in: return
        self._render_jobs(jobs)
        if was_running and not self._restoring and self._active and self._window.account_logged_in: self.reload()

    def _render_jobs(self, jobs) -> None:
        self._jobs = jobs
        self._restoring = any(job.status == "running" for job in jobs)
        self._update_restore()
        self._job_bar.set_visible(bool(jobs))
        if jobs:
            job = jobs[0]
            restored = sum(result.status == "restored" for result in job.results)
            problems = sum(result.status in ("failed", "unknown") for result in job.results)
            title = "Restoring…" if job.status == "running" else "Restore cancelled" if job.status == "cancelled" else "Restore finished"
            summary = f"{title} · {restored} restored" + (f" · {problems} need attention" if problems else "")
            if job.refresh_error: summary += " · refresh needed"
            self._job_status.set_text(summary)
            self._job_status.set_tooltip_text(summary)
            self._job_icon.set_from_icon_name("dialog-warning-symbolic" if problems or job.refresh_error else "document-revert-symbolic" if job.status == "running" else "object-select-symbolic")
            self._cancel_job.set_visible(job.status == "running")
            self._cancel_job.set_sensitive(True)
            self._cancel_job.set_label("Cancel")
        if self._results_dialog: self._render_job_details()

    def _show_results(self) -> None:
        if self._results_dialog:
            self._results_dialog.present(self._window)
            return
        if not self._jobs: return
        dialog = Adw.Dialog(title="Restore results", content_width=560, content_height=480)
        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(Adw.HeaderBar())
        page = Adw.PreferencesPage()
        self._jobs_group = Adw.PreferencesGroup(description=(
            "Unconfirmed items need a Trash refresh before retrying. "
            "If a parent is missing or a name is taken, restore the parent first or resolve it on the web."
        ))
        page.add(self._jobs_group)
        toolbar.set_content(page)
        dialog.set_child(toolbar)
        self._results_dialog = dialog
        def closed(current):
            if self._results_dialog is current:
                self._results_dialog = None
                self._jobs_group = None
                self._job_rows.clear()
        dialog.connect("closed", closed)
        self._render_job_details()
        dialog.present(self._window)

    def _render_job_details(self) -> None:
        for row in self._job_rows: self._jobs_group.remove(row)
        self._job_rows.clear()
        for job in self._jobs:
            restored = sum(result.status == "restored" for result in job.results)
            problems = sum(result.status in ("failed", "unknown") for result in job.results)
            title = "Restoring…" if job.status == "running" else "Restore cancelled" if job.status == "cancelled" else "Restore finished"
            row = Adw.ExpanderRow(title=title, subtitle=f"{restored} restored · {problems} need attention · {format_absolute_time(job.created_at)}")
            if job.status == "running":
                cancel = Gtk.Button(label="Cancel", valign=Gtk.Align.CENTER)
                cancel.connect("clicked", lambda button, uid=job.id: self._cancel_restore(button, uid))
                row.add_suffix(cancel)
            # Related photo assets can make large result sets. Build detail
            # rows only when opened, preserving expansion across signals.
            row.connect("notify::expanded", self._expand_result, job, [])
            if job.id in self._expanded: row.set_expanded(True)
            self._jobs_group.add(row)
            self._job_rows.append(row)

    def _expand_result(self, row, _spec, job, populated) -> None:
        if not row.get_expanded():
            self._expanded.discard(job.id)
            return
        self._expanded.add(job.id)
        if populated: return
        populated.append(True)
        if job.refresh_error:
            row.add_row(Adw.ActionRow(title="Refresh needed", subtitle=GLib.markup_escape_text(job.refresh_error), subtitle_lines=0))
        for result in job.results:
            detail = {"pending": "Waiting to restore", "restored": "Restored to Drive", "alreadyRestored": "Already out of Trash",
                      "cancelled": "Cancelled before submission", "failed": "Restore failed", "unknown": "Restore outcome unconfirmed"}.get(result.status, "Restore outcome unconfirmed")
            if result.item.error: detail += f" · {result.item.error}"
            entry = Adw.ActionRow(title=GLib.markup_escape_text(result.item.name), subtitle=GLib.markup_escape_text(detail), subtitle_lines=0)
            if result.status in ("failed", "unknown"): entry.add_css_class("warning")
            row.add_row(entry)

    def _cancel_restore(self, button, uid: str) -> None:
        generation = self._account_generation
        button.set_sensitive(False)
        button.set_label("Cancelling…")
        def finished(_result):
            if self._disposed or generation != self._account_generation: return
            self._load_jobs()
        def failed(message):
            if self._disposed or generation != self._account_generation: return
            button.set_sensitive(True)
            button.set_label("Cancel")
            self._error(message)
        self._client.cancel_trash_restore(uid, finished, failed)
