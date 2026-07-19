"""The activity screen — a plain-language record of what sync has done.

Sync is otherwise invisible. Files appear, change and disappear on their own,
and when a file goes missing there is no way for someone to work out whether
Halyard removed it, why, or whether it is recoverable. The log file answers
that, but nobody reads log files.

So every row here is written as cause and effect: not "deleteLocal
notes/todo.md", but "Deleted from this computer — it was removed from Proton
Drive, so it was removed here to match", followed by where it went and how to
get it back.
"""

from __future__ import annotations

import os

from gi.repository import Adw, Gio, GLib, Gtk

from .models import (
    ACTION_CREATED_LOCAL_FOLDER,
    ACTION_CREATED_REMOTE_FOLDER,
    ACTION_DELETED_LOCAL,
    ACTION_DOWNLOADED,
    ACTION_MOVED_LOCAL,
    ACTION_MOVED_REMOTE,
    ACTION_TRASHED_REMOTE,
    ACTION_UPDATED_LOCAL,
    ACTION_UPDATED_REMOTE,
    ACTION_UPLOADED,
    ACTIONS_ADDED,
    ACTIONS_MOVED,
    ACTIONS_REMOVED,
    ACTIONS_UPDATED,
    OUTCOME_FAILED,
    HistoryEntry,
    Pair,
)
from .util import (
    format_absolute_time,
    format_relative_time,
    format_size,
    tilde_path,
)

#: How many entries a page holds. Enough to fill a tall window twice over, so
#: "Load Older" is rarely the first thing someone has to click.
PAGE_SIZE = 100

#: Title and cause for each action. The second half always explains *why*,
#: because that is the question that brings someone to this screen.
ACTION_TEXT: dict[str, tuple[str, str]] = {
    ACTION_DOWNLOADED: (
        "Added to this computer",
        "It appeared in Proton Drive, so a copy was made here.",
    ),
    ACTION_UPDATED_LOCAL: (
        "Updated on this computer",
        "It changed in Proton Drive, so the copy here was brought up to date.",
    ),
    ACTION_UPLOADED: (
        "Added to Proton Drive",
        "It appeared on this computer, so a copy was made in Proton Drive.",
    ),
    ACTION_UPDATED_REMOTE: (
        "Updated in Proton Drive",
        "It changed on this computer, so Proton Drive was brought up to date.",
    ),
    ACTION_DELETED_LOCAL: (
        "Deleted from this computer",
        "It was removed from Proton Drive, so it was removed here to match. "
        "It can still be restored from the Trash in Proton Drive.",
    ),
    ACTION_TRASHED_REMOTE: (
        "Moved to the Trash in Proton Drive",
        "It was deleted on this computer, so it was moved to the Trash in "
        "Proton Drive. It can still be restored from there.",
    ),
    ACTION_MOVED_LOCAL: (
        "Moved on this computer",
        "It was moved or renamed in Proton Drive, so it was moved here to "
        "match. Nothing was re-downloaded.",
    ),
    ACTION_MOVED_REMOTE: (
        "Moved in Proton Drive",
        "It was moved or renamed on this computer, so Proton Drive was "
        "updated to match. Nothing was re-uploaded.",
    ),
    ACTION_CREATED_LOCAL_FOLDER: (
        "Folder added to this computer",
        "The folder appeared in Proton Drive, so it was created here.",
    ),
    ACTION_CREATED_REMOTE_FOLDER: (
        "Folder added to Proton Drive",
        "The folder appeared on this computer, so it was created in "
        "Proton Drive.",
    ),
}

#: Down means "arrived on this computer", up means "went to Proton Drive".
#: Deliberately a symmetric arrow pair — `folder-upload-symbolic` does not
#: exist in Adwaita, so pairing it with `folder-download-symbolic` silently
#: fell back to a generic icon and the two directions stopped being telling
#: apart at a glance.
ACTION_ICONS: dict[str, str] = {
    ACTION_DOWNLOADED: "go-down-symbolic",
    ACTION_UPDATED_LOCAL: "go-down-symbolic",
    ACTION_UPLOADED: "go-up-symbolic",
    ACTION_UPDATED_REMOTE: "go-up-symbolic",
    ACTION_DELETED_LOCAL: "user-trash-symbolic",
    ACTION_TRASHED_REMOTE: "user-trash-symbolic",
    ACTION_MOVED_LOCAL: "go-jump-symbolic",
    ACTION_MOVED_REMOTE: "go-jump-symbolic",
    ACTION_CREATED_LOCAL_FOLDER: "folder-new-symbolic",
    ACTION_CREATED_REMOTE_FOLDER: "folder-new-symbolic",
}

#: (label, actions, outcome) for the "Show" filter. A None means "do not
#: narrow on this", which is what the daemon expects for an omitted field.
FILTERS: tuple[tuple[str, tuple[str, ...] | None, str | None], ...] = (
    ("Everything", None, None),
    ("Deleted", ACTIONS_REMOVED, None),
    ("Added", ACTIONS_ADDED, None),
    ("Updated", ACTIONS_UPDATED, None),
    ("Moved or renamed", ACTIONS_MOVED, None),
    ("Didn’t work", None, OUTCOME_FAILED),
)


def _day_heading(epoch_ms: int | None) -> str:
    """"Today", "Yesterday", or a date — the way someone thinks about when."""
    if not epoch_ms:
        return "Earlier"
    when = GLib.DateTime.new_from_unix_local(int(epoch_ms / 1000))
    today = GLib.DateTime.new_now_local()

    def same_day(a, b) -> bool:
        return (a.get_year(), a.get_day_of_year()) == (
            b.get_year(), b.get_day_of_year()
        )

    if same_day(when, today):
        return "Today"
    if same_day(when, today.add_days(-1)):
        return "Yesterday"
    if when.get_year() == today.get_year():
        return when.format("%A, %-d %B") or "Earlier"
    return when.format("%-d %B %Y") or "Earlier"


class HistoryRow(Adw.ExpanderRow):
    """One event, collapsed to a headline and expandable to the full story."""

    def __init__(self, entry: HistoryEntry, pair: Pair | None) -> None:
        super().__init__()
        self._entry = entry

        title, explanation = ACTION_TEXT.get(
            entry.action, ("Changed", "Halyard changed this file.")
        )

        self.set_title(GLib.markup_escape_text(entry.name))
        self.set_title_lines(1)

        subtitle = title
        if pair is not None:
            subtitle += f" · {os.path.basename(pair.local_path)}"
        subtitle += f" · {format_relative_time(entry.at)}"
        if entry.size:
            subtitle += f" · {format_size(entry.size)}"
        self.set_subtitle(GLib.markup_escape_text(subtitle))
        self.set_subtitle_lines(2)

        icon = Gtk.Image.new_from_icon_name(
            "dialog-warning-symbolic" if entry.failed
            else ACTION_ICONS.get(entry.action, "document-properties-symbolic")
        )
        if entry.failed:
            icon.add_css_class("error")
        elif entry.action in (ACTION_DELETED_LOCAL, ACTION_TRASHED_REMOTE):
            # Deletions are the rows people come here to find. Dimming
            # everything else would be noisy, so lift these instead.
            icon.add_css_class("accent")
        self.add_prefix(icon)

        if entry.failed:
            failure = Adw.ActionRow(
                title="This did not work",
                subtitle=GLib.markup_escape_text(
                    entry.error or "Halyard could not complete this change."
                ),
            )
            failure.set_subtitle_lines(0)
            failure.add_css_class("error")
            self.add_row(failure)
            reason = Adw.ActionRow(
                title="What was meant to happen",
                subtitle=GLib.markup_escape_text(explanation),
            )
        else:
            reason = Adw.ActionRow(
                title="Why this happened",
                subtitle=GLib.markup_escape_text(explanation),
            )
        reason.set_subtitle_lines(0)
        self.add_row(reason)

        local_root = pair.local_path if pair is not None else ""
        if entry.to_path:
            self._add_path_row("Moved from", entry.path, local_root,
                               openable=False)
            self._add_path_row("Moved to", entry.to_path, local_root)
        else:
            label = ("Where it was" if entry.action == ACTION_DELETED_LOCAL
                     else "Where it is")
            self._add_path_row(label, entry.path, local_root)

        when = Adw.ActionRow(
            title="When",
            subtitle=GLib.markup_escape_text(format_absolute_time(entry.at)),
        )
        when.set_subtitle_lines(0)
        self.add_row(when)

    def _add_path_row(self, title: str, relative: str, local_root: str,
                      openable: bool = True) -> None:
        full = os.path.join(local_root, relative) if local_root else relative
        row = Adw.ActionRow(
            title=title,
            subtitle=GLib.markup_escape_text(tilde_path(full)),
        )
        row.set_subtitle_lines(0)

        copy = Gtk.Button(
            icon_name="edit-copy-symbolic",
            valign=Gtk.Align.CENTER,
            tooltip_text="Copy path",
        )
        copy.add_css_class("flat")
        copy.connect("clicked", lambda widget: widget.get_clipboard().set(full))
        row.add_suffix(copy)

        # Offered only when there is something to open: after a deletion the
        # file is gone, but its folder usually is not.
        folder = full if os.path.isdir(full) else os.path.dirname(full)
        if openable and folder and os.path.isdir(folder):
            reveal = Gtk.Button(
                icon_name="folder-symbolic",
                valign=Gtk.Align.CENTER,
                tooltip_text="Open containing folder",
            )
            reveal.add_css_class("flat")
            reveal.connect("clicked", lambda *_: self._open(folder))
            row.add_suffix(reveal)

        self.add_row(row)

    @staticmethod
    def _open(folder: str) -> None:
        launcher = Gtk.FileLauncher.new(Gio.File.new_for_path(folder))
        launcher.launch(None, None, None)


class HistoryPage(Adw.NavigationPage):
    """The activity log, filtered and paged."""

    def __init__(self, client, window) -> None:
        super().__init__(title="Activity", tag="activity")
        self._client = client
        self._window = window
        self._pairs: list[Pair] = []
        self._entries: list[HistoryEntry] = []
        self._groups: list[Adw.PreferencesGroup] = []
        self._more_shown = False
        self._exhausted = False
        self._loading = False
        #: Bumped per request so a reply that has been superseded by a newer
        #: filter is discarded rather than painted over the current one.
        self._request = 0
        self._search_timeout = 0
        #: Set while the dropdowns are being populated programmatically, so
        #: rebuilding them does not fire a request per widget change.
        self._suspend_reload = False

        toolbar = Adw.ToolbarView()
        toolbar.add_top_bar(self._build_header())
        toolbar.add_top_bar(self._build_search_bar())
        toolbar.add_top_bar(self._build_filter_bar())
        toolbar.set_content(self._build_content())
        self.set_child(toolbar)

    # -- construction ----------------------------------------------------

    def _build_header(self) -> Adw.HeaderBar:
        header = Adw.HeaderBar()

        self._search_button = Gtk.ToggleButton(
            icon_name="system-search-symbolic",
            tooltip_text="Search by file name",
        )
        self._search_button.connect("toggled", self._on_search_toggled)
        header.pack_start(self._search_button)

        refresh = Gtk.Button(
            icon_name="view-refresh-symbolic", tooltip_text="Refresh"
        )
        refresh.connect("clicked", lambda *_: self.reload())
        header.pack_end(refresh)

        menu = Gio.Menu()
        menu.append("Clear Activity", "activity.clear")
        header.pack_end(Gtk.MenuButton(
            icon_name="view-more-symbolic",
            menu_model=menu,
            tooltip_text="Activity options",
        ))

        actions = Gio.SimpleActionGroup()
        clear = Gio.SimpleAction.new("clear", None)
        clear.connect("activate", lambda *_: self._confirm_clear())
        actions.add_action(clear)
        self.insert_action_group("activity", actions)

        return header

    def _build_search_bar(self) -> Gtk.SearchBar:
        self._search_entry = Gtk.SearchEntry(
            placeholder_text="Search by file name", hexpand=True
        )
        self._search_entry.connect("search-changed", self._on_search_changed)

        clamp = Adw.Clamp(maximum_size=600, child=self._search_entry)
        self._search_bar = Gtk.SearchBar(child=clamp)
        self._search_bar.connect_entry(self._search_entry)
        self._search_bar.set_key_capture_widget(self)
        return self._search_bar

    def _build_filter_bar(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.set_margin_top(6)
        box.set_margin_bottom(6)
        box.set_margin_start(12)
        box.set_margin_end(12)

        self._kind_dropdown = Gtk.DropDown.new_from_strings(
            [label for label, _actions, _outcome in FILTERS]
        )
        self._kind_dropdown.set_tooltip_text("Show only certain changes")
        self._kind_dropdown.connect("notify::selected", self._on_filter_changed)
        box.append(self._kind_dropdown)

        self._pair_dropdown = Gtk.DropDown.new_from_strings(["All folders"])
        self._pair_dropdown.set_tooltip_text("Show only one folder")
        self._pair_dropdown.connect("notify::selected", self._on_filter_changed)
        box.append(self._pair_dropdown)

        clamp = Adw.Clamp(maximum_size=900, child=box)
        return clamp

    def _build_content(self) -> Gtk.Widget:
        self._stack = Gtk.Stack(vexpand=True)

        loading = Adw.StatusPage(title="Loading…")
        spinner_box = Gtk.Box(halign=Gtk.Align.CENTER, valign=Gtk.Align.CENTER)
        spinner = Adw.Spinner()
        spinner.set_size_request(32, 32)
        spinner_box.append(spinner)
        loading.set_child(spinner_box)
        self._stack.add_named(loading, "loading")

        self._empty_page = Adw.StatusPage(
            icon_name="document-open-recent-symbolic",
            title="Nothing Here Yet",
            description=("Once Halyard starts syncing, every file it adds, "
                         "updates or removes is listed here."),
        )
        self._stack.add_named(self._empty_page, "empty")

        self._error_page = Adw.StatusPage(
            icon_name="dialog-warning-symbolic",
            title="Could Not Load Activity",
        )
        retry = Gtk.Button(label="Try Again", halign=Gtk.Align.CENTER)
        retry.add_css_class("pill")
        retry.connect("clicked", lambda *_: self.reload())
        self._error_page.set_child(retry)
        self._stack.add_named(self._error_page, "error")

        scrolled = Gtk.ScrolledWindow(
            hscrollbar_policy=Gtk.PolicyType.NEVER, vexpand=True
        )
        self._page = Adw.PreferencesPage()

        self._more_group = Adw.PreferencesGroup()
        self._more_button = Gtk.Button(
            label="Load Older Activity", halign=Gtk.Align.CENTER
        )
        self._more_button.add_css_class("pill")
        self._more_button.connect("clicked", lambda *_: self._load(more=True))
        self._more_group.add(self._more_button)

        scrolled.set_child(self._page)
        self._stack.add_named(scrolled, "list")

        return self._stack

    # -- state -----------------------------------------------------------

    def _on_filter_changed(self, *_args) -> None:
        if self._suspend_reload:
            return
        self.reload()

    def set_pairs(self, pairs: list[Pair]) -> None:
        """Refresh the folder filter, keeping the current choice if it lives."""
        if pairs == self._pairs:
            return
        selected_id = self._selected_pair_id()
        self._pairs = pairs

        model = Gtk.StringList.new(
            ["All folders"]
            + [os.path.basename(p.local_path) or p.local_path for p in pairs]
        )
        index = next(
            (i for i, p in enumerate(pairs) if p.id == selected_id), -1
        )

        # Rebuilding the model resets the selection, which would otherwise
        # fire a request that the caller's own reload immediately supersedes.
        self._suspend_reload = True
        try:
            self._pair_dropdown.set_model(model)
            self._pair_dropdown.set_selected(index + 1 if index >= 0 else 0)
        finally:
            self._suspend_reload = False

    def select_pair(self, pair_id: str) -> None:
        """Narrow to one folder, or to all of them when given "".

        Call after ``set_pairs``; the caller does not have to know the
        dropdown's index scheme. Callers follow this with ``reload``, so the
        change deliberately does not fetch on its own.
        """
        index = next(
            (i for i, p in enumerate(self._pairs) if p.id == pair_id), -1
        ) if pair_id else -1

        self._suspend_reload = True
        try:
            self._pair_dropdown.set_selected(index + 1 if index >= 0 else 0)
        finally:
            self._suspend_reload = False

    def _selected_pair_id(self) -> str:
        index = self._pair_dropdown.get_selected()
        if index in (0, Gtk.INVALID_LIST_POSITION):
            return ""
        pair_index = index - 1
        if 0 <= pair_index < len(self._pairs):
            return self._pairs[pair_index].id
        return ""

    def _selected_filter(self) -> tuple[tuple[str, ...] | None, str | None]:
        index = self._kind_dropdown.get_selected()
        if index == Gtk.INVALID_LIST_POSITION or index >= len(FILTERS):
            return None, None
        _label, actions, outcome = FILTERS[index]
        return actions, outcome

    # -- loading ---------------------------------------------------------

    def reload(self) -> None:
        self._entries = []
        self._exhausted = False
        self._load(more=False)

    def _load(self, *, more: bool) -> None:
        # Paging twice at once would duplicate rows, so that is worth
        # dropping. A filter or search change never is: ignoring it leaves the
        # list showing one thing while the controls claim another.
        if more and self._loading:
            return
        self._request += 1
        token = self._request
        self._loading = True

        if not more and not self._entries:
            self._stack.set_visible_child_name("loading")
        if more:
            self._more_button.set_sensitive(False)
            self._more_button.set_label("Loading…")

        actions, outcome = self._selected_filter()
        before_id = self._entries[-1].id if more and self._entries else None

        def on_ok(entries: list[HistoryEntry]) -> None:
            if token != self._request:
                return
            self._loading = False
            self._more_button.set_sensitive(True)
            self._more_button.set_label("Load Older Activity")
            # A short page means the daemon has nothing older to give.
            self._exhausted = len(entries) < PAGE_SIZE
            if more:
                self._entries.extend(entries)
            else:
                self._entries = list(entries)
            self._render()

        def on_err(message: str) -> None:
            if token != self._request:
                return
            self._loading = False
            self._more_button.set_sensitive(True)
            self._more_button.set_label("Load Older Activity")
            if self._entries:
                self._window.toast(message)
                return
            self._error_page.set_description(message)
            self._stack.set_visible_child_name("error")

        self._client.list_history(
            on_ok, on_err,
            pair_id=self._selected_pair_id(),
            actions=list(actions) if actions else None,
            outcome=outcome or "",
            search=self._search_entry.get_text().strip(),
            before_id=before_id,
            limit=PAGE_SIZE,
        )

    # -- rendering -------------------------------------------------------

    def _render(self) -> None:
        for group in self._groups:
            self._page.remove(group)
        self._groups.clear()
        if self._more_shown:
            self._page.remove(self._more_group)
            self._more_shown = False

        if not self._entries:
            self._empty_page.set_description(self._empty_description())
            self._stack.set_visible_child_name("empty")
            return

        pairs_by_id = {p.id: p for p in self._pairs}

        # Entries arrive newest-first, so days come out in order simply by
        # starting a new group whenever the heading changes.
        current_heading: str | None = None
        group: Adw.PreferencesGroup | None = None
        for entry in self._entries:
            heading = _day_heading(entry.at)
            if heading != current_heading:
                current_heading = heading
                group = Adw.PreferencesGroup(title=heading)
                self._groups.append(group)
                self._page.add(group)
            if group is not None:
                group.add(HistoryRow(entry, pairs_by_id.get(entry.pair_id)))

        if not self._exhausted:
            self._page.add(self._more_group)
            self._more_shown = True

        self._stack.set_visible_child_name("list")

    def _empty_description(self) -> str:
        """Says whether the log is empty or just the filters are too narrow."""
        searching = bool(self._search_entry.get_text().strip())
        actions, outcome = self._selected_filter()
        if searching:
            return "No files match that search."
        if outcome == OUTCOME_FAILED:
            return "Nothing has failed to sync. That is the good outcome."
        if actions or self._selected_pair_id():
            return "Nothing matches these filters yet."
        return ("Once Halyard starts syncing, every file it adds, updates or "
                "removes is listed here.")

    # -- search ----------------------------------------------------------

    def _on_search_toggled(self, button: Gtk.ToggleButton) -> None:
        self._search_bar.set_search_mode(button.get_active())
        if not button.get_active() and self._search_entry.get_text():
            self._search_entry.set_text("")

    def _on_search_changed(self, _entry) -> None:
        # Debounced: each keystroke would otherwise be a round trip to the
        # daemon and a full rebuild of the list.
        if self._search_timeout:
            GLib.source_remove(self._search_timeout)

        def fire() -> bool:
            self._search_timeout = 0
            self.reload()
            return False

        self._search_timeout = GLib.timeout_add(250, fire)

    # -- clearing --------------------------------------------------------

    def _confirm_clear(self) -> None:
        dialog = Adw.AlertDialog(
            heading="Clear Activity?",
            body=("Halyard will forget its record of what it has synced so "
                  "far.\n\nYour files are not touched — this only clears this "
                  "list."),
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("clear", "Clear")
        dialog.set_response_appearance(
            "clear", Adw.ResponseAppearance.DESTRUCTIVE
        )
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")

        def on_response(_dialog, response: str) -> None:
            if response != "clear":
                return
            self._client.clear_history(
                "",
                lambda _r: (self._window.toast("Activity cleared"),
                            self.reload()),
                lambda message: self._window.toast(message),
            )

        dialog.connect("response", on_response)
        dialog.present(self)
