"""Halyard — an unofficial two-way sync client for Proton Drive.

Halyard is an independent open-source project. It is not made, endorsed, or
supported by Proton AG.
"""

from __future__ import annotations

import os
import sys

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from . import __version__  # noqa: E402
from .dbus_client import DaemonClient  # noqa: E402
from .models import Notification, Status  # noqa: E402
from .tray import TrayIcon  # noqa: E402
from .window import HalyardWindow  # noqa: E402

APP_ID = "io.github.votton.Halyard"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

SETTINGS_DEFAULTS = {
    "window-width": 900,
    "window-height": 640,
    "window-maximized": False,
    "close-notice-shown": False,
    "autostart": False,
}


class _FallbackSettings:
    """In-memory stand-in used when the GSettings schema is not installed.

    Keeps the app fully usable when it is run straight from a source
    checkout without compiling schemas; preferences simply do not persist.
    """

    def __init__(self) -> None:
        self._values = dict(SETTINGS_DEFAULTS)

    def get_int(self, key: str) -> int:
        return int(self._values.get(key, 0))

    def set_int(self, key: str, value: int) -> None:
        self._values[key] = int(value)

    def get_boolean(self, key: str) -> bool:
        return bool(self._values.get(key, False))

    def set_boolean(self, key: str, value: bool) -> None:
        self._values[key] = bool(value)


def load_settings():
    """Return a Gio.Settings if the schema is installed, else a shim."""
    try:
        source = Gio.SettingsSchemaSource.get_default()
        if source is not None and source.lookup(APP_ID, True) is not None:
            return Gio.Settings.new(APP_ID)
    except GLib.Error:
        pass
    return _FallbackSettings()


class HalyardApplication(Adw.Application):
    def __init__(self) -> None:
        super().__init__(
            application_id=APP_ID,
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS,
        )
        self._client = DaemonClient()
        self._settings = load_settings()
        self._window: HalyardWindow | None = None
        self._notification_serial = 0
        self._tray: TrayIcon | None = None
        self._status = Status()
        self._logged_in = False

        self.add_main_option(
            "version", ord("v"), GLib.OptionFlags.NONE,
            GLib.OptionArg.NONE, "Show the version and exit", None,
        )

    # -- lifecycle -------------------------------------------------------

    def do_startup(self) -> None:
        Adw.Application.do_startup(self)
        self._load_styles()
        self._register_icons()

        quit_action = Gio.SimpleAction.new("quit", None)
        quit_action.connect("activate", lambda *_: self._quit_window())
        self.add_action(quit_action)
        self.set_accels_for_action("app.quit", ["<Primary>q", "<Primary>w"])

        # Target of the default action on desktop notifications: clicking one
        # brings the window back, creating it again if it was closed.
        show_action = Gio.SimpleAction.new("show-window", None)
        show_action.connect("activate", lambda *_: self.activate())
        self.add_action(show_action)

        self._client.connect("notification", self._on_notification)
        self._client.connect("status-changed", self._on_status_changed)
        self._client.connect("availability-changed", self._on_daemon_available)
        self._client.start()
        self._start_tray()

    def do_activate(self) -> None:
        if self._window is None:
            self._window = HalyardWindow(self, self._client, self._settings)
            self._window.connect("destroy", self._on_window_destroyed)
            self._window.set_tray_available(self.tray_available)
        self._window.set_visible(True)
        self._window.present()

    def do_handle_local_options(self, options: GLib.VariantDict) -> int:
        if options.contains("version"):
            print(f"Halyard {__version__}")
            return 0
        return -1

    def do_shutdown(self) -> None:
        if self._tray is not None:
            self._tray.stop()
        self._client.stop()
        Adw.Application.do_shutdown(self)

    def _on_window_destroyed(self, _window) -> None:
        self._window = None

    def _quit_window(self) -> None:
        """Close the UI. The sync service deliberately keeps running."""
        if self._window is not None:
            self._window.close()
        else:
            self.quit()

    # -- tray ------------------------------------------------------------

    def _start_tray(self) -> None:
        connection = self.get_dbus_connection()
        if connection is None:
            return
        tray = TrayIcon(connection)
        tray.connect("activate-requested", lambda _t: self._present_window())
        tray.connect("menu-action", self._on_tray_action)
        tray.connect("availability-changed", self._on_tray_availability)
        self._tray = tray
        tray.start()
        self._sync_tray()

    @property
    def tray_available(self) -> bool:
        return self._tray is not None and self._tray.available

    def _on_status_changed(self, _client, status: Status) -> None:
        self._status = status
        self._logged_in = status.logged_in
        self._sync_tray()

    def _on_daemon_available(self, _client, available: bool) -> None:
        if not available:
            self._status = Status()
            self._logged_in = False
            self._sync_tray()
            return
        # Seed from a real call rather than waiting for the next signal, which
        # may not arrive for a while on an idle daemon.
        self._client.get_status(
            lambda status: self._on_status_changed(None, status),
            lambda _message: self._sync_tray(),
        )

    def _sync_tray(self) -> None:
        if self._tray is None:
            return
        self._tray.update(
            self._status, self._logged_in, self._client.available
        )

    def _on_tray_availability(self, _tray, available: bool) -> None:
        if self._window is not None:
            self._window.set_tray_available(available)
        if not available and self._window is not None \
                and not self._window.get_visible():
            # The tray was the only way back to a hidden window. Rather than
            # strand the user with an invisible process, show it again.
            self._present_window()

    def _present_window(self) -> None:
        self.activate()
        if self._window is not None:
            self._window.set_visible(True)
            self._window.present()

    def _on_tray_action(self, _tray, action: str) -> None:
        if action == "sync":
            self._client.sync_now("")
        elif action == "pause":
            self._client.set_paused(True)
        elif action == "resume":
            self._client.set_paused(False)
        elif action == "quit":
            # Quits this UI process only; the daemon keeps syncing.
            self.quit()

    # -- chrome ----------------------------------------------------------

    def _load_styles(self) -> None:
        css_path = os.path.join(DATA_DIR, "style.css")
        if not os.path.exists(css_path):
            return
        display = Gdk.Display.get_default()
        if display is None:
            return
        provider = Gtk.CssProvider()
        provider.load_from_path(css_path)
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

    def _register_icons(self) -> None:
        display = Gdk.Display.get_default()
        if display is None:
            return
        icons_dir = os.path.join(DATA_DIR, "icons")
        if os.path.isdir(icons_dir):
            theme = Gtk.IconTheme.get_for_display(display)
            theme.add_search_path(icons_dir)

    # -- daemon notifications --------------------------------------------

    def _on_notification(self, _client, note: Notification) -> None:
        """Render a daemon Notify as a desktop notification.

        Deliberately uses Gio.Application.send_notification rather than
        libnotify, so the UI has no extra dependency and notifications are
        correctly attributed to the application.
        """
        if not note.title and not note.body:
            return

        notification = Gio.Notification.new(note.title or "Halyard")
        if note.body:
            notification.set_body(note.body)

        if note.kind == "error":
            notification.set_priority(Gio.NotificationPriority.URGENT)
            notification.set_icon(
                Gio.ThemedIcon.new("dialog-error-symbolic")
            )
        elif note.kind == "warning":
            notification.set_priority(Gio.NotificationPriority.HIGH)
            notification.set_icon(
                Gio.ThemedIcon.new("dialog-warning-symbolic")
            )
        else:
            notification.set_priority(Gio.NotificationPriority.NORMAL)

        notification.set_default_action("app.show-window")

        # A stable id per kind coalesces repeats instead of stacking them up.
        self.send_notification(f"halyard-{note.kind}", notification)


def main(argv: list[str] | None = None) -> int:
    app = HalyardApplication()
    return app.run(argv if argv is not None else sys.argv)


if __name__ == "__main__":
    sys.exit(main())
