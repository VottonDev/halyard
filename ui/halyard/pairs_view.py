"""The main screen: the list of folder pairs."""

from __future__ import annotations

import os

from gi.repository import Adw, Gio, GLib, GObject, Gtk

from .models import (
    STATUS_ERROR,
    STATUS_IDLE,
    STATUS_PAUSED,
    STATUS_SCANNING,
    STATUS_SETUP,
    STATUS_SYNCING,
    STATUS_WAITING,
    Activity,
    Pair,
    Status,
)
from .util import format_relative_time, format_size, tilde_path

STATUS_LABELS = {
    STATUS_SETUP: "Setting up",
    STATUS_SCANNING: "Checking for changes",
    STATUS_SYNCING: "Syncing",
    STATUS_IDLE: "Up to date",
    STATUS_WAITING: "Waiting for Proton Drive",
    STATUS_PAUSED: "Paused",
    STATUS_ERROR: "Error",
}

STATUS_ICONS = {
    STATUS_IDLE: "object-select-symbolic",
    STATUS_WAITING: "network-offline-symbolic",
    STATUS_PAUSED: "media-playback-pause-symbolic",
    STATUS_ERROR: "dialog-warning-symbolic",
}


def exclusion_summary(pair: Pair) -> list[str]:
    """"2 exclusions", so it is visible that a pair skips part of its folder."""
    count = len(pair.excludes)
    if not count:
        return []
    return [f"{count} exclusion" if count == 1 else f"{count} exclusions"]


class PairRow(Adw.ActionRow):
    """One folder pair, with its status, progress and per-row actions."""

    __gsignals__ = {
        "sync-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "edit-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "remove-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "history-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "enabled-toggled": (GObject.SIGNAL_RUN_FIRST, None, (str, bool)),
    }

    def __init__(self, pair: Pair) -> None:
        super().__init__(activatable=True)
        self.pair_id = pair.id
        self._pair = pair
        self._updating = False

        # Unlimited, so a long error message wraps instead of being clipped.
        self.set_subtitle_lines(0)
        self.set_title_lines(1)

        # Prefix: a status icon, or a spinner while the pair is busy.
        self._icon = Gtk.Image()
        self._spinner = Adw.Spinner()
        self._spinner.set_size_request(16, 16)
        self._prefix_stack = Gtk.Stack(valign=Gtk.Align.CENTER)
        self._prefix_stack.add_named(self._icon, "icon")
        self._prefix_stack.add_named(self._spinner, "spinner")
        self._prefix_stack.set_size_request(20, 20)
        self.add_prefix(self._prefix_stack)

        suffix = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=12,
            valign=Gtk.Align.CENTER,
        )

        self._progress = Gtk.ProgressBar(
            valign=Gtk.Align.CENTER,
            show_text=False,
            visible=False,
        )
        self._progress.set_size_request(120, -1)
        suffix.append(self._progress)

        self._switch = Gtk.Switch(valign=Gtk.Align.CENTER)
        self._switch.set_tooltip_text("Sync this folder pair")
        self._switch.connect("notify::active", self._on_switch_toggled)
        suffix.append(self._switch)

        menu = Gio.Menu()
        menu.append("Sync Now", "row.sync")
        menu.append("Recent Activity", "row.history")
        menu.append("Edit…", "row.edit")
        menu.append("Remove…", "row.remove")

        self._menu_button = Gtk.MenuButton(
            icon_name="view-more-symbolic",
            valign=Gtk.Align.CENTER,
            menu_model=menu,
            tooltip_text="Folder pair options",
        )
        self._menu_button.add_css_class("flat")
        suffix.append(self._menu_button)
        self.add_suffix(suffix)

        actions = Gio.SimpleActionGroup()
        for name, handler in (
            ("sync", lambda *_: self.emit("sync-requested", self.pair_id)),
            ("history", lambda *_: self.emit("history-requested",
                                             self.pair_id)),
            ("edit", lambda *_: self.emit("edit-requested", self.pair_id)),
            ("remove", lambda *_: self.emit("remove-requested", self.pair_id)),
        ):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", handler)
            actions.add_action(action)
        self._actions = actions
        self.insert_action_group("row", actions)

        self.connect("activated", lambda *_: self.emit("edit-requested",
                                                       self.pair_id))
        self.update(pair, None)

    # -- rendering -------------------------------------------------------

    def update(self, pair: Pair, activity: Activity | None) -> None:
        self._pair = pair
        self.pair_id = pair.id

        name = os.path.basename(pair.local_path.rstrip("/")) or pair.local_path
        self.set_title(GLib.markup_escape_text(name))
        self.set_subtitle(
            GLib.markup_escape_text(self._subtitle(pair, activity))
        )

        busy = pair.enabled and pair.status in (
            STATUS_SYNCING, STATUS_SCANNING, STATUS_SETUP
        )
        self._prefix_stack.set_visible_child_name("spinner" if busy else "icon")

        icon_name = STATUS_ICONS.get(pair.status, "folder-symbolic")
        if not pair.enabled:
            icon_name = "media-playback-pause-symbolic"
        self._icon.set_from_icon_name(icon_name)
        for css in ("success", "warning", "error", "dim-label"):
            self._icon.remove_css_class(css)
        if not pair.enabled:
            self._icon.add_css_class("dim-label")
        elif pair.status == STATUS_ERROR:
            self._icon.add_css_class("error")
        elif pair.status == STATUS_IDLE:
            self._icon.add_css_class("success")
        elif pair.status == STATUS_PAUSED:
            self._icon.add_css_class("dim-label")
        elif pair.status == STATUS_WAITING:
            self._icon.add_css_class("warning")

        show_progress = activity is not None and pair.enabled
        self._progress.set_visible(show_progress)
        if show_progress and activity is not None:
            self._progress.set_fraction(activity.fraction)
            self._progress.set_tooltip_text(
                f"{format_size(activity.bytes_done)} of "
                f"{format_size(activity.bytes_total)}"
            )

        self._updating = True
        self._switch.set_active(pair.enabled)
        self._updating = False

        self._actions.lookup_action("sync").set_enabled(pair.enabled)

        if pair.status == STATUS_ERROR and pair.error:
            self.set_tooltip_text(pair.error)
        else:
            self.set_tooltip_text(
                f"{pair.local_path}\n{pair.remote_path}"
            )

    def _subtitle(self, pair: Pair, activity: Activity | None) -> str:
        paths = f"{tilde_path(pair.local_path)}  ⇄  {pair.remote_path}"

        if not pair.enabled:
            bits = ["Syncing turned off"]
            if pair.last_sync_at:
                bits.append(
                    f"Last synced {format_relative_time(pair.last_sync_at)}"
                )
            bits.extend(exclusion_summary(pair))
            return f"{paths}\n" + " · ".join(bits)

        if pair.status == STATUS_ERROR:
            bits = [pair.error or "Sync failed"]
            bits.extend(exclusion_summary(pair))
            return f"{paths}\n" + " · ".join(bits)

        if activity is not None:
            verb = "Uploading" if activity.is_upload else "Downloading"
            name = os.path.basename(activity.path) or activity.path
            percent = int(activity.fraction * 100)
            bits = [f"{verb} {name}",
                    f"{percent}% of {format_size(activity.bytes_total)}"]
            bits.extend(exclusion_summary(pair))
            return f"{paths}\n" + " · ".join(bits)

        label = STATUS_LABELS.get(pair.status, pair.status.capitalize())
        bits = [label]
        if pair.status == STATUS_SYNCING and pair.stats.pending:
            bits[0] = f"Syncing · {pair.stats.pending} files left"
        elif pair.status == STATUS_SCANNING and pair.stats.pending:
            bits[0] = f"Checking for changes · {pair.stats.pending} found"
        if pair.status in (STATUS_IDLE, STATUS_WAITING, STATUS_PAUSED) or not pair.stats.pending:
            bits.append(f"Synced {format_relative_time(pair.last_sync_at)}")
        if pair.stats.conflicts:
            noun = "conflict" if pair.stats.conflicts == 1 else "conflicts"
            bits.append(f"{pair.stats.conflicts} {noun}")
        bits.extend(exclusion_summary(pair))
        return f"{paths}\n" + " · ".join(bits)

    def _on_switch_toggled(self, switch, _param) -> None:
        if self._updating:
            return
        self.emit("enabled-toggled", self.pair_id, switch.get_active())


class PairsView(Gtk.Box):
    """The list of folder pairs, plus its empty state."""

    __gsignals__ = {
        "add-requested": (GObject.SIGNAL_RUN_FIRST, None, ()),
        "edit-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "conflicts-requested": (GObject.SIGNAL_RUN_FIRST, None, ()),
        "sync-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "remove-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "history-requested": (GObject.SIGNAL_RUN_FIRST, None, (str,)),
        "enabled-toggled": (GObject.SIGNAL_RUN_FIRST, None, (str, bool)),
    }

    def __init__(self) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self._rows: dict[str, PairRow] = {}

        self._offline_banner = Adw.Banner(
            title="No connection to Proton Drive. Halyard will retry "
                  "automatically.",
            revealed=False,
        )
        self.append(self._offline_banner)

        self._conflict_banner = Adw.Banner(
            title="Some files need your attention",
            button_label="Review",
            revealed=False,
        )
        self._conflict_banner.connect(
            "button-clicked", lambda *_: self.emit("conflicts-requested")
        )
        self.append(self._conflict_banner)

        self._stack = Gtk.Stack(
            transition_type=Gtk.StackTransitionType.CROSSFADE,
            vexpand=True,
        )
        self.append(self._stack)

        # Empty state
        empty = Adw.StatusPage(
            icon_name="folder-symbolic",
            title="No Folders Synced Yet",
            description=("Choose a folder on this computer and a folder in "
                         "Proton Drive. Halyard keeps them in step, in both "
                         "directions."),
        )
        add_button = Gtk.Button(label="Add Folder Pair", halign=Gtk.Align.CENTER)
        add_button.add_css_class("suggested-action")
        add_button.add_css_class("pill")
        add_button.connect("clicked", lambda *_: self.emit("add-requested"))
        empty.set_child(add_button)
        self._stack.add_named(empty, "empty")

        # Populated state
        page = Adw.PreferencesPage()
        self._group = Adw.PreferencesGroup(
            title="Folder Pairs",
            description="Each pair syncs in both directions.",
        )
        add_icon_button = Gtk.Button(
            icon_name="list-add-symbolic",
            tooltip_text="Add folder pair",
            valign=Gtk.Align.CENTER,
        )
        add_icon_button.add_css_class("flat")
        add_icon_button.connect("clicked", lambda *_: self.emit("add-requested"))
        self._group.set_header_suffix(add_icon_button)
        page.add(self._group)

        footer_group = Adw.PreferencesGroup()
        footer = Gtk.Label(
            label=("Halyard keeps syncing in the background after you close "
                   "this window."),
            wrap=True,
            justify=Gtk.Justification.CENTER,
        )
        footer.add_css_class("dim-label")
        footer.add_css_class("caption")
        footer_group.add(footer)
        page.add(footer_group)

        self._stack.add_named(page, "list")
        self._stack.set_visible_child_name("empty")

    # -- rendering -------------------------------------------------------

    def render(self, status: Status) -> None:
        pairs = list(status.pairs)
        self._offline_banner.set_revealed(not status.online)

        conflicts = status.total_conflicts
        if conflicts:
            noun = "file needs" if conflicts == 1 else "files need"
            self._conflict_banner.set_title(
                f"{conflicts} {noun} your attention. Both copies were kept."
            )
        self._conflict_banner.set_revealed(bool(conflicts))

        if not pairs:
            self._stack.set_visible_child_name("empty")
            for row in self._rows.values():
                self._group.remove(row)
            self._rows.clear()
            return

        self._stack.set_visible_child_name("list")

        seen = set()
        for index, pair in enumerate(pairs):
            seen.add(pair.id)
            row = self._rows.get(pair.id)
            if row is None:
                row = PairRow(pair)
                for signal in ("sync-requested", "edit-requested",
                               "remove-requested", "history-requested"):
                    row.connect(
                        signal,
                        lambda _row, pid, s=signal: self.emit(s, pid),
                    )
                row.connect(
                    "enabled-toggled",
                    lambda _row, pid, on: self.emit("enabled-toggled", pid, on),
                )
                self._rows[pair.id] = row
                self._group.add(row)
            row.update(pair, status.activity_for(pair.id))

        for pair_id in list(self._rows):
            if pair_id not in seen:
                self._group.remove(self._rows.pop(pair_id))
