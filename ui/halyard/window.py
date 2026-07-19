"""The main application window."""

from __future__ import annotations

import os

from gi.repository import Adw, Gio, Gtk

from .conflicts_view import ConflictsPage
from .dbus_client import DaemonClient
from .login_view import LoginView
from .models import STATUS_ERROR, Pair, Status
from .pair_dialog import PairDialog
from .pairs_view import PairsView
from .preferences import PreferencesDialog
from .util import format_size, tilde_path


class HalyardWindow(Adw.ApplicationWindow):
    def __init__(self, application, client: DaemonClient, settings) -> None:
        super().__init__(application=application, title="Halyard")
        self._client = client
        self._settings = settings
        self._status = Status()
        self._account_logged_in: bool | None = None
        self._conflicts_page: ConflictsPage | None = None
        self._last_conflict_count = -1
        self._closing = False

        self.set_default_size(
            settings.get_int("window-width"),
            settings.get_int("window-height"),
        )
        if settings.get_boolean("window-maximized"):
            self.maximize()

        self._toasts = Adw.ToastOverlay()
        self.set_content(self._toasts)

        self._nav = Adw.NavigationView()
        self._toasts.set_child(self._nav)
        self._nav.add(self._build_main_page())

        self._install_actions()

        client.connect("availability-changed", self._on_availability)
        client.connect("status-changed", self._on_status_changed)
        client.connect("login-state-changed", self._on_login_state)

        self.connect("close-request", self._on_close_request)
        self._render()
        if client.available:
            self._refresh_everything()

    # -- construction ----------------------------------------------------

    def _build_main_page(self) -> Adw.NavigationPage:
        page = Adw.NavigationPage(title="Halyard", tag="main")
        toolbar = Adw.ToolbarView()

        header = Adw.HeaderBar()
        self._window_title = Adw.WindowTitle(title="Halyard", subtitle="")
        header.set_title_widget(self._window_title)

        self._pause_button = Gtk.ToggleButton(
            icon_name="media-playback-pause-symbolic",
            tooltip_text="Pause syncing",
        )
        self._pause_handler = self._pause_button.connect(
            "toggled", self._on_pause_toggled
        )
        header.pack_start(self._pause_button)

        self._add_button = Gtk.Button(
            icon_name="list-add-symbolic",
            tooltip_text="Add folder pair",
        )
        self._add_button.connect("clicked", lambda *_: self._open_pair_dialog())
        header.pack_start(self._add_button)

        menu = Gio.Menu()

        sync_section = Gio.Menu()
        sync_section.append("Sync All Now", "win.sync-all")
        sync_section.append("Conflicts", "win.conflicts")
        menu.append_section(None, sync_section)

        app_section = Gio.Menu()
        app_section.append("Preferences", "win.preferences")
        app_section.append("About Halyard", "win.about")
        menu.append_section(None, app_section)

        self._menu_button = Gtk.MenuButton(
            icon_name="open-menu-symbolic",
            menu_model=menu,
            tooltip_text="Main menu",
            primary=True,
        )
        header.pack_end(self._menu_button)

        self._conflicts_button = Gtk.Button(
            icon_name="dialog-warning-symbolic",
            tooltip_text="Files need your attention",
            visible=False,
        )
        self._conflicts_button.add_css_class("warning")
        self._conflicts_button.connect("clicked",
                                       lambda *_: self._show_conflicts())
        header.pack_end(self._conflicts_button)

        toolbar.add_top_bar(header)

        self._stack = Gtk.Stack(
            transition_type=Gtk.StackTransitionType.CROSSFADE,
            vexpand=True,
        )

        self._disconnected_page = self._build_disconnected()
        self._stack.add_named(self._disconnected_page, "disconnected")

        self._stack.add_named(self._build_loading(), "loading")

        self._login_view = LoginView(self._client, self)
        self._stack.add_named(self._login_view, "login")

        self._pairs_view = PairsView()
        self._pairs_view.connect("add-requested",
                                 lambda *_: self._open_pair_dialog())
        self._pairs_view.connect("edit-requested", self._on_edit_pair)
        self._pairs_view.connect("conflicts-requested",
                                 lambda *_: self._show_conflicts())
        self._pairs_view.connect("sync-requested", self._on_sync_pair)
        self._pairs_view.connect("remove-requested", self._on_remove_pair)
        self._pairs_view.connect("enabled-toggled", self._on_toggle_pair)
        self._stack.add_named(self._pairs_view, "pairs")

        self._stack.set_visible_child_name("disconnected")
        toolbar.set_content(self._stack)
        page.set_child(toolbar)
        return page

    def _build_loading(self) -> Gtk.Widget:
        """Shown while the account state is still unknown.

        Without this the window would briefly show the sign-in screen on every
        start, before GetAccount has had a chance to answer.
        """
        box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL,
            halign=Gtk.Align.CENTER,
            valign=Gtk.Align.CENTER,
            spacing=18,
        )
        spinner = Adw.Spinner()
        spinner.set_size_request(48, 48)
        box.append(spinner)
        label = Gtk.Label(label="Connecting to the sync service…")
        label.add_css_class("dim-label")
        box.append(label)
        return box

    def _build_disconnected(self) -> Gtk.Widget:
        status = Adw.StatusPage(
            icon_name="network-offline-symbolic",
            title="Sync Service Not Running",
            description=("Halyard’s background service handles the syncing. "
                         "It will be picked up automatically as soon as it "
                         "starts."),
        )
        box = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL,
            spacing=12,
            halign=Gtk.Align.CENTER,
        )
        retry = Gtk.Button(label="Try Again", halign=Gtk.Align.CENTER)
        retry.add_css_class("pill")
        retry.add_css_class("suggested-action")
        retry.connect("clicked", lambda *_: self._refresh_everything())
        box.append(retry)
        status.set_child(box)
        return status

    def _install_actions(self) -> None:
        for name, handler, accel in (
            ("sync-all", self._on_sync_all, None),
            ("conflicts", lambda *_: self._show_conflicts(), None),
            ("preferences", lambda *_: self._show_preferences(),
             "<Primary>comma"),
            ("about", lambda *_: self._show_about(), None),
            ("add-pair", lambda *_: self._open_pair_dialog(), "<Primary>n"),
            ("refresh", lambda *_: self._refresh_everything(), "F5"),
        ):
            action = Gio.SimpleAction.new(name, None)
            action.connect("activate", handler)
            self.add_action(action)
            if accel:
                app = self.get_application()
                if app is not None:
                    app.set_accels_for_action(f"win.{name}", [accel])

    # -- toast helper ----------------------------------------------------

    def toast(self, message: str) -> None:
        self._toasts.add_toast(Adw.Toast(title=message, timeout=5))

    # -- daemon plumbing -------------------------------------------------

    def _on_availability(self, _client, available: bool) -> None:
        if available:
            self._refresh_everything()
        else:
            self._account_logged_in = None
            self._status = Status()
        self._render()

    def _refresh_everything(self) -> None:
        if not self._client.available:
            self._render()
            return

        def on_status(status: Status) -> None:
            self._status = status
            self._account_logged_in = status.logged_in
            self._render()

        def on_status_err(message: str) -> None:
            self.toast(message)

        self._client.get_status(on_status, on_status_err)

        def on_account(account) -> None:
            self._account_logged_in = account.logged_in
            self._render()

        self._client.get_account(on_account, lambda _m: None)

    def _on_status_changed(self, _client, status: Status) -> None:
        self._status = status
        self._account_logged_in = status.logged_in
        self._render()

    def _on_login_state(self, _client, state) -> None:
        self._login_view.on_login_state(state)
        if state.state == "success":
            self.toast("Signed in to Proton Drive")
            self._refresh_everything()
        # A failure is already shown persistently in the login view's banner,
        # so it deliberately does not also raise a toast.

    # -- rendering -------------------------------------------------------

    def _render(self) -> None:
        available = self._client.available

        if not available:
            view = "disconnected"
        elif self._account_logged_in is None:
            # Account state not known yet — neither signed in nor signed out.
            view = "loading"
        elif not self._account_logged_in:
            view = "login"
        else:
            view = "pairs"

        if self._stack.get_visible_child_name() != view:
            self._stack.set_visible_child_name(view)
            if view == "login":
                self._login_view.reset()

        show_controls = view == "pairs"
        self._pause_button.set_visible(show_controls)
        self._add_button.set_visible(show_controls)

        status = self._status
        conflicts = status.total_conflicts
        self._conflicts_button.set_visible(show_controls and conflicts > 0)
        if conflicts:
            noun = "file needs" if conflicts == 1 else "files need"
            self._conflicts_button.set_tooltip_text(
                f"{conflicts} {noun} your attention"
            )

        self._pause_button.handler_block(self._pause_handler)
        self._pause_button.set_active(status.paused)
        self._pause_button.handler_unblock(self._pause_handler)
        self._pause_button.set_icon_name(
            "media-playback-start-symbolic" if status.paused
            else "media-playback-pause-symbolic"
        )
        self._pause_button.set_tooltip_text(
            "Resume syncing" if status.paused else "Pause syncing"
        )

        self._window_title.set_subtitle(self._summary(view, status))

        if view == "pairs":
            self._pairs_view.render(status)

        if conflicts != self._last_conflict_count:
            self._last_conflict_count = conflicts
            if self._conflicts_page is not None:
                self._conflicts_page.set_pairs(list(status.pairs))
                self._conflicts_page.reload()

    def _summary(self, view: str, status: Status) -> str:
        if view == "disconnected":
            return "Sync service unavailable"
        if view == "loading":
            return "Connecting…"
        if view == "login":
            return "Not signed in"
        if status.paused:
            return "Syncing paused"
        if not status.online:
            return "Waiting for a connection"

        activity = status.activity
        if activity is not None and activity.bytes_total:
            verb = "Uploading" if activity.is_upload else "Downloading"
            name = os.path.basename(activity.path) or activity.path
            return (f"{verb} {name} · {int(activity.fraction * 100)}% of "
                    f"{format_size(activity.bytes_total)}")

        errored = [p for p in status.pairs if p.status == STATUS_ERROR]
        if errored:
            phrase = ("1 folder needs" if len(errored) == 1
                      else f"{len(errored)} folders need")
            return f"{phrase} attention"

        pending = status.total_pending
        if pending:
            noun = "file" if pending == 1 else "files"
            return f"{pending} {noun} left to sync"

        if not status.pairs:
            return "No folders synced"
        return "All folders up to date"

    # -- pair actions ----------------------------------------------------

    def _find_pair(self, pair_id: str) -> Pair | None:
        return next((p for p in self._status.pairs if p.id == pair_id), None)

    def _open_pair_dialog(self, pair: Pair | None = None) -> None:
        if not self._client.available:
            self.toast("The sync service is not running.")
            return
        dialog = PairDialog(self._client, self, list(self._status.pairs), pair)
        dialog.connect(
            "saved",
            lambda *_: (
                self.toast("Folder pair saved" if pair
                           else "Folder pair added"),
                self._refresh_everything(),
            ),
        )
        dialog.present(self)

    def _on_edit_pair(self, _view, pair_id: str) -> None:
        pair = self._find_pair(pair_id)
        if pair is not None:
            self._open_pair_dialog(pair)

    def _on_sync_pair(self, _view, pair_id: str) -> None:
        pair = self._find_pair(pair_id)
        name = os.path.basename(pair.local_path) if pair else "folder"
        self._client.sync_now(
            pair_id,
            lambda _r: self.toast(f"Syncing {name}"),
            lambda message: self.toast(message),
        )

    def _on_sync_all(self, *_args) -> None:
        self._client.sync_now(
            "",
            lambda _r: self.toast("Syncing all folders"),
            lambda message: self.toast(message),
        )

    def _on_toggle_pair(self, _view, pair_id: str, enabled: bool) -> None:
        self._client.set_pair_enabled(
            pair_id, enabled,
            lambda _p: self._render(),
            lambda message: (self.toast(message), self._render()),
        )

    def _on_remove_pair(self, _view, pair_id: str) -> None:
        pair = self._find_pair(pair_id)
        if pair is None:
            return
        name = os.path.basename(pair.local_path) or pair.local_path

        dialog = Adw.AlertDialog(
            heading=f"Stop Syncing “{name}”?",
            body=(f"{tilde_path(pair.local_path)} and {pair.remote_path} will "
                  "stop syncing with each other.\n\nYour files are not "
                  "deleted — both folders are left exactly as they are now."),
        )
        check = Gtk.CheckButton(
            label="Also forget this folder’s sync history",
        )
        check.set_tooltip_text(
            "Discards Halyard's own record of what has been synced. "
            "Your files are untouched."
        )
        dialog.set_extra_child(check)
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("remove", "Stop Syncing")
        dialog.set_response_appearance(
            "remove", Adw.ResponseAppearance.DESTRUCTIVE
        )
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")

        def on_response(_dialog, response: str) -> None:
            if response != "remove":
                return
            self._client.remove_pair(
                pair_id, check.get_active(),
                lambda _r: (self.toast(f"Stopped syncing {name}"),
                            self._refresh_everything()),
                lambda message: self.toast(message),
            )

        dialog.connect("response", on_response)
        dialog.present(self)

    def _on_pause_toggled(self, button) -> None:
        paused = button.get_active()

        def on_err(message: str) -> None:
            self.toast(message)
            self._render()

        self._client.set_paused(
            paused,
            lambda _r: self.toast(
                "Syncing paused" if paused else "Syncing resumed"
            ),
            on_err,
        )

    # -- navigation ------------------------------------------------------

    def _show_conflicts(self) -> None:
        if not self._client.available:
            self.toast("The sync service is not running.")
            return
        if self._conflicts_page is None:
            self._conflicts_page = ConflictsPage(self._client, self)
            self._nav.add(self._conflicts_page)
        self._conflicts_page.set_pairs(list(self._status.pairs))
        if self._nav.get_visible_page() is not self._conflicts_page:
            self._nav.push(self._conflicts_page)
        self._conflicts_page.reload()

    def _show_preferences(self) -> None:
        PreferencesDialog(self._client, self, self._settings).present(self)

    def _show_about(self) -> None:
        about = Adw.AboutDialog(
            application_name="Halyard",
            application_icon="io.github.votton.Halyard",
            developer_name="The Halyard contributors",
            version=self._status.version or "0.1.0",
            website="https://github.com/votton/halyard",
            issue_url="https://github.com/votton/halyard/issues",
            license_type=Gtk.License.GPL_3_0,
            comments=(
                "Two-way folder sync for Proton Drive.\n\n"
                "Halyard is an unofficial, independent open-source client. "
                "It is not made, endorsed, or supported by Proton AG. "
                "“Proton” and “Proton Drive” are trademarks of Proton AG, "
                "used here only to describe what this application connects to."
            ),
        )
        about.set_copyright("© 2026 The Halyard contributors")
        about.add_legal_section(
            "Third-Party Notice",
            None,
            Gtk.License.CUSTOM,
            "This is a third-party application not officially supported by "
            "Proton.",
        )
        about.present(self)

    # -- closing ---------------------------------------------------------

    def _on_close_request(self, _window) -> bool:
        self._save_window_state()

        if self._closing or self._settings.get_boolean("close-notice-shown"):
            return False
        if not self._client.available or not self._account_logged_in:
            return False

        self._settings.set_boolean("close-notice-shown", True)

        dialog = Adw.AlertDialog(
            heading="Halyard Keeps Syncing",
            body=("Closing this window leaves the background service running, "
                  "so your folders stay in sync.\n\nGNOME has no system tray, "
                  "so Halyard will let you know about anything that needs you "
                  "through notifications. Open Halyard again any time to see "
                  "progress."),
        )
        dialog.add_response("stop", "Stop Syncing Too")
        dialog.add_response("close", "Close Window")
        dialog.set_response_appearance(
            "close", Adw.ResponseAppearance.SUGGESTED
        )
        dialog.set_default_response("close")
        dialog.set_close_response("close")

        def on_response(_dialog, response: str) -> None:
            if response == "stop":
                self._client.quit_daemon()
            self._closing = True
            self.close()

        dialog.connect("response", on_response)
        dialog.present(self)
        return True  # hold the window open until the user answers

    def _save_window_state(self) -> None:
        if self.is_maximized():
            self._settings.set_boolean("window-maximized", True)
            return
        self._settings.set_boolean("window-maximized", False)
        width, height = self.get_default_size()
        if width > 0 and height > 0:
            self._settings.set_int("window-width", width)
            self._settings.set_int("window-height", height)
