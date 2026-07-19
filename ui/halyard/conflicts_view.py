"""The conflicts screen.

A conflict is never data loss in Halyard: the daemon has already kept both
copies on disk. Resolving one just tidies up. The screen is written to say
that plainly, because "conflict" reads as "something broke" otherwise.
"""

from __future__ import annotations

import os

from gi.repository import Adw, GLib, GObject, Gtk

from .models import (
    KIND_BOTH_MODIFIED,
    KIND_LOCAL_DELETED,
    KIND_REMOTE_DELETED,
    RESOLVE_DISMISS,
    RESOLVE_KEEP_LOCAL,
    RESOLVE_KEEP_REMOTE,
    Conflict,
    Pair,
)
from .util import format_absolute_time, format_relative_time, tilde_path

KIND_TITLES = {
    KIND_BOTH_MODIFIED: "Changed in both places",
    KIND_LOCAL_DELETED: "Deleted here, changed in Proton Drive",
    KIND_REMOTE_DELETED: "Deleted in Proton Drive, changed here",
}

KIND_EXPLANATIONS = {
    KIND_BOTH_MODIFIED: (
        "This file was edited on this computer and in Proton Drive before "
        "the two could be matched up. Both versions were kept."
    ),
    KIND_LOCAL_DELETED: (
        "This file was deleted on this computer, but changed in Proton Drive. "
        "Rather than lose the change, the Proton Drive version was restored."
    ),
    KIND_REMOTE_DELETED: (
        "This file was deleted in Proton Drive, but changed on this computer. "
        "Rather than lose the change, the local file was left in place."
    ),
}


class ConflictRow(Adw.ExpanderRow):
    def __init__(self, conflict: Conflict, pair: Pair | None,
                 on_resolve) -> None:
        super().__init__()
        self._conflict = conflict
        self._on_resolve = on_resolve

        name = os.path.basename(conflict.path) or conflict.path
        self.set_title(GLib.markup_escape_text(name))
        subtitle = KIND_TITLES.get(conflict.kind, "Needs your attention")
        if pair is not None:
            subtitle += f" · {os.path.basename(pair.local_path)}"
        subtitle += f" · {format_relative_time(conflict.detected_at)}"
        self.set_subtitle(GLib.markup_escape_text(subtitle))
        self.set_subtitle_lines(2)

        icon = Gtk.Image.new_from_icon_name("dialog-warning-symbolic")
        icon.add_css_class("warning")
        self.add_prefix(icon)

        explanation = Adw.ActionRow(
            title="What happened",
            subtitle=GLib.markup_escape_text(
                KIND_EXPLANATIONS.get(
                    conflict.kind,
                    "Both copies of this file were kept.",
                )
            ),
        )
        explanation.set_subtitle_lines(0)
        self.add_row(explanation)

        full_path = conflict.path
        if pair is not None:
            full_path = os.path.join(pair.local_path, conflict.path)
        location = Adw.ActionRow(
            title="Original file",
            subtitle=GLib.markup_escape_text(tilde_path(full_path)),
        )
        location.set_subtitle_lines(0)
        location.add_suffix(self._copy_button(full_path))
        self.add_row(location)

        if conflict.kept_copy_path:
            kept_full = conflict.kept_copy_path
            if pair is not None and not os.path.isabs(kept_full):
                kept_full = os.path.join(pair.local_path,
                                         conflict.kept_copy_path)
            kept = Adw.ActionRow(
                title="Copy that was kept",
                subtitle=GLib.markup_escape_text(tilde_path(kept_full)),
            )
            kept.set_subtitle_lines(0)
            kept.add_suffix(self._copy_button(kept_full))
            self.add_row(kept)

        times = Adw.ActionRow(
            title="Last changed",
            subtitle=GLib.markup_escape_text(
                f"On this computer: "
                f"{format_absolute_time(conflict.local_modified_at)}\n"
                f"In Proton Drive: "
                f"{format_absolute_time(conflict.remote_modified_at)}"
            ),
        )
        times.set_subtitle_lines(0)
        self.add_row(times)

        actions_row = Adw.ActionRow()
        buttons = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=8,
            halign=Gtk.Align.END,
            hexpand=True,
        )
        buttons.set_margin_top(8)
        buttons.set_margin_bottom(8)

        dismiss = Gtk.Button(label="Keep Both")
        dismiss.set_tooltip_text(
            "Leave both files alone and clear this from the list"
        )
        dismiss.connect("clicked", lambda *_: self._resolve(RESOLVE_DISMISS))
        buttons.append(dismiss)

        keep_local = Gtk.Button(label="Keep This Computer’s")
        keep_local.set_tooltip_text(
            "Use the version on this computer everywhere"
        )
        keep_local.connect("clicked",
                           lambda *_: self._resolve(RESOLVE_KEEP_LOCAL))
        buttons.append(keep_local)

        keep_remote = Gtk.Button(label="Keep Proton Drive’s")
        keep_remote.set_tooltip_text(
            "Use the version from Proton Drive everywhere"
        )
        keep_remote.connect("clicked",
                            lambda *_: self._resolve(RESOLVE_KEEP_REMOTE))
        buttons.append(keep_remote)

        actions_row.set_child(buttons)
        self._buttons = [dismiss, keep_local, keep_remote]
        self.add_row(actions_row)

    @staticmethod
    def _copy_button(text: str) -> Gtk.Button:
        button = Gtk.Button(
            icon_name="edit-copy-symbolic",
            valign=Gtk.Align.CENTER,
            tooltip_text="Copy path",
        )
        button.add_css_class("flat")

        def on_click(widget) -> None:
            widget.get_clipboard().set(text)

        button.connect("clicked", on_click)
        return button

    def _resolve(self, resolution: str) -> None:
        for button in self._buttons:
            button.set_sensitive(False)
        self._on_resolve(self._conflict, resolution, self._reenable)

    def _reenable(self) -> None:
        for button in self._buttons:
            button.set_sensitive(True)


class ConflictsPage(Adw.NavigationPage):
    """Lists every conflict across all pairs."""

    __gsignals__ = {
        "resolved": (GObject.SIGNAL_RUN_FIRST, None, ()),
    }

    def __init__(self, client, window) -> None:
        super().__init__(title="Conflicts", tag="conflicts")
        self._client = client
        self._window = window
        self._pairs: list[Pair] = []

        toolbar = Adw.ToolbarView()
        header = Adw.HeaderBar()
        refresh = Gtk.Button(
            icon_name="view-refresh-symbolic",
            tooltip_text="Refresh",
        )
        refresh.connect("clicked", lambda *_: self.reload())
        header.pack_end(refresh)
        toolbar.add_top_bar(header)

        self._stack = Gtk.Stack(vexpand=True)

        loading = Adw.StatusPage(title="Loading…")
        box = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        box.append(spinner)
        loading.set_child(box)
        self._stack.add_named(loading, "loading")

        empty = Adw.StatusPage(
            icon_name="object-select-symbolic",
            title="Nothing Needs Attention",
            description=("When the same file changes in two places at once, "
                         "Halyard keeps both copies and lists them here."),
        )
        self._stack.add_named(empty, "empty")

        error = Adw.StatusPage(
            icon_name="dialog-warning-symbolic",
            title="Could Not Load Conflicts",
        )
        self._error_page = error
        retry = Gtk.Button(label="Try Again", halign=Gtk.Align.CENTER)
        retry.add_css_class("pill")
        retry.connect("clicked", lambda *_: self.reload())
        error.set_child(retry)
        self._stack.add_named(error, "error")

        scrolled = Gtk.ScrolledWindow(
            hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True
        )
        page = Adw.PreferencesPage()
        self._group = Adw.PreferencesGroup(
            title="Files That Need a Decision",
            description=("Nothing has been lost — both copies are already on "
                         "this computer. Choosing an option below just tidies "
                         "up."),
        )
        page.add(self._group)
        scrolled.set_child(page)
        self._stack.add_named(scrolled, "list")

        toolbar.set_content(self._stack)
        self.set_child(toolbar)
        self._rows: list[ConflictRow] = []

    def set_pairs(self, pairs: list[Pair]) -> None:
        self._pairs = pairs

    def reload(self) -> None:
        if not self._rows:
            self._stack.set_visible_child_name("loading")

        def on_ok(conflicts: list[Conflict]) -> None:
            self._render(conflicts)

        def on_err(message: str) -> None:
            self._error_page.set_description(message)
            self._stack.set_visible_child_name("error")

        # An empty pairId asks for conflicts across every pair.
        self._client.list_conflicts("", on_ok, on_err)

    def _render(self, conflicts: list[Conflict]) -> None:
        for row in self._rows:
            self._group.remove(row)
        self._rows.clear()

        if not conflicts:
            self._stack.set_visible_child_name("empty")
            return

        pairs_by_id = {p.id: p for p in self._pairs}
        for conflict in conflicts:
            row = ConflictRow(
                conflict, pairs_by_id.get(conflict.pair_id), self._resolve
            )
            self._rows.append(row)
            self._group.add(row)
        self._stack.set_visible_child_name("list")

    def _resolve(self, conflict: Conflict, resolution: str,
                 on_failure) -> None:
        labels = {
            RESOLVE_KEEP_LOCAL: "Kept the version from this computer",
            RESOLVE_KEEP_REMOTE: "Kept the version from Proton Drive",
            RESOLVE_DISMISS: "Both copies kept",
        }

        def on_ok(_result) -> None:
            self._window.toast(labels.get(resolution, "Conflict resolved"))
            self.emit("resolved")
            self.reload()

        def on_err(message: str) -> None:
            on_failure()
            self._window.toast(message)

        self._client.resolve_conflict(conflict.id, resolution, on_ok, on_err)
