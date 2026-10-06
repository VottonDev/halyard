"""On-demand Trash browsing and original-location restore."""

from __future__ import annotations

import uuid

from gi.repository import Adw, GLib, Gtk

from .models import TrashItem
from .util import format_absolute_time, format_size


class TrashPage(Adw.NavigationPage):
    def __init__(self, client, window) -> None:
        super().__init__(title="Trash", tag="trash")
        self._client = client
        self._window = window
        self._listing_id = ""
        self._request = 0
        self._jobs_request = 0
        self._loading = False
        self._starting = False
        self._restoring = False
        self._disposed = False
        self._active = False
        self._cursor = None
        self._items: dict[str, TrashItem] = {}
        self._selected: set[str] = set()
        self._rows = []
        self._job_rows = []
        self._expanded: set[str] = set()
        self._dialog = None

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        self._source = Gtk.DropDown.new_from_strings(["Files and folders", "Photos"])
        self._source.connect("notify::selected", lambda *_: self.reload())
        header.pack_start(self._source)
        self._restore = Gtk.Button(label="Restore", sensitive=False)
        self._restore.add_css_class("suggested-action")
        self._restore.connect("clicked", lambda *_: self._confirm_restore())
        header.pack_end(self._restore)
        refresh = Gtk.Button(icon_name="view-refresh-symbolic", tooltip_text="Refresh Trash")
        refresh.connect("clicked", lambda *_: self.reload())
        header.pack_end(refresh)
        toolbar.add_top_bar(header)

        self._page = Adw.PreferencesPage()
        self._group = Adw.PreferencesGroup(title="Deleted items", description=(
            "Restore items to their original locations in Drive. Files in paired folders will sync normally. "
            "Use Proton Drive on the web for version history."
        ))
        self._page.add(self._group)
        self._message = Gtk.Label(wrap=True, xalign=0, visible=False)
        self._message.add_css_class("error")
        self._group.add(self._message)
        self._loading_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12, halign=Gtk.Align.CENTER, visible=False)
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        self._loading_box.append(spinner)
        cancel = Gtk.Button(label="Cancel loading")
        cancel.connect("clicked", lambda *_: self.deactivate())
        self._loading_box.append(cancel)
        self._group.add(self._loading_box)
        self._empty = Adw.ActionRow(title="Trash is empty", visible=False)
        self._group.add(self._empty)

        more_group = Adw.PreferencesGroup()
        self._more = Gtk.Button(label="Load more", visible=False, halign=Gtk.Align.CENTER)
        self._more.connect("clicked", lambda *_: self._load_more())
        more_group.add(self._more)
        self._page.add(more_group)
        self._jobs_group = Adw.PreferencesGroup(title="Restore results", visible=False, description=(
            "A cancelled request can still have restored items. Unconfirmed results need a Trash refresh before retrying. "
            "If an original parent is missing or a name is taken, restore the parent first or resolve it on the web."
        ))
        self._page.add(self._jobs_group)
        toolbar.set_content(self._page)
        self.set_child(toolbar)
        self._handler = client.connect("trash-restores-changed", self._on_jobs)

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

    def reset(self) -> None:
        self.deactivate()
        self._jobs_request += 1
        if self._dialog: self._dialog.close()
        self._dialog = None
        self._starting = False
        self._restoring = False
        self._expanded.clear()
        self._clear_items()
        self._render_jobs(())
        self._message.set_visible(False)

    def dispose(self) -> None:
        self.reset()
        self._disposed = True
        self._client.disconnect(self._handler)

    def _error(self, message: str) -> None:
        self._message.set_text(message)
        self._message.set_visible(True)

    def _clear_items(self) -> None:
        for row in self._rows: self._group.remove(row)
        self._rows.clear()
        self._items.clear()
        self._selected.clear()
        self._empty.set_visible(False)
        self._update_restore()

    def reload(self) -> None:
        self.deactivate()
        self._clear_items()
        if self._disposed or not self._window.account_logged_in: return
        self._active = True
        self._message.set_visible(False)
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
        self._more.set_sensitive(False)

        def finished(page):
            if request != self._request or self._disposed: return
            self._loading = False
            self._loading_box.set_visible(False)
            self._cursor = page.next_cursor
            for item in page.items:
                if item.uid in self._items: continue
                self._items[item.uid] = item
                self._add_item(item)
            self._more.set_visible(bool(self._cursor))
            self._more.set_sensitive(True)
            self._empty.set_visible(not self._items and not self._cursor)
            self._update_restore()

        def failed(message):
            if request != self._request or self._disposed: return
            self.deactivate()
            self._error(message)

        self._client.list_trash(query, finished, failed)

    def _add_item(self, item: TrashItem) -> None:
        details = [{"file": "File", "folder": "Folder", "photo": "Photo or video", "album": "Album"}.get(item.type, item.type)]
        if item.size is not None: details.append(format_size(item.size))
        if item.trashed_at: details.append(f"Deleted {format_absolute_time(item.trashed_at)}")
        if item.error: details.append(item.error)
        row = Adw.ActionRow(title=GLib.markup_escape_text(item.name), subtitle=GLib.markup_escape_text(" · ".join(details)), subtitle_lines=0)
        check = Gtk.CheckButton(valign=Gtk.Align.CENTER, sensitive=not bool(item.error))
        check.set_tooltip_text(f"Select {item.name}")
        check.connect("toggled", lambda widget, uid=item.uid: self._toggle(widget, uid))
        row.add_prefix(check)
        row.set_activatable_widget(check)
        if item.error: row.add_css_class("warning")
        self._group.add(row)
        self._rows.append(row)

    def _toggle(self, check, uid: str) -> None:
        if check.get_active(): self._selected.add(uid)
        else: self._selected.discard(uid)
        self._update_restore()

    def _update_restore(self) -> None:
        count = len(self._selected)
        self._restore.set_label(f"Restore {count}" if count else "Restore")
        self._restore.set_sensitive(0 < count <= 100 and not self._starting and not self._restoring)
        if count > 100: self._error("Select at most 100 items to restore at once.")

    def _confirm_restore(self) -> None:
        if not self._restore.get_sensitive() or self._dialog or not self._window.account_logged_in: return
        uids = list(self._selected)
        source = self.source
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
            if answer == "restore" and source == self.source and self._window.account_logged_in:
                self._start_restore(source, uids)

        dialog.connect("response", response)
        dialog.present(self._window)

    def _start_restore(self, source: str, uids: list[str]) -> None:
        if self._starting or self._restoring or self._disposed: return
        self._starting = True
        self._update_restore()

        def finished(_job):
            if self._disposed: return
            self._starting = False
            self._load_jobs()
            self._update_restore()

        def failed(message):
            if self._disposed: return
            self._starting = False
            self._error(message)
            self._update_restore()

        self._client.start_trash_restore(source, uids, finished, failed)

    def _load_jobs(self) -> None:
        self._jobs_request += 1
        request = self._jobs_request
        def finished(jobs):
            if request == self._jobs_request and not self._disposed: self._render_jobs(jobs)
        self._client.list_trash_restores(finished, lambda message: self._error(message) if request == self._jobs_request and not self._disposed else None)

    def _on_jobs(self, _client, jobs) -> None:
        self._jobs_request += 1
        was_running = self._restoring
        if self._disposed: return
        self._render_jobs(jobs)
        if was_running and not self._restoring and self._active and self._window.account_logged_in: self.reload()

    def _render_jobs(self, jobs) -> None:
        self._restoring = any(job.status == "running" for job in jobs)
        self._update_restore()
        for row in self._job_rows: self._jobs_group.remove(row)
        self._job_rows.clear()
        self._jobs_group.set_visible(bool(jobs))
        for job in jobs:
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
        button.set_sensitive(False)
        button.set_label("Cancelling…")
        def failed(message):
            button.set_sensitive(True)
            button.set_label("Cancel")
            self._error(message)
        self._client.cancel_trash_restore(uid, lambda _result: self._load_jobs(), failed)
