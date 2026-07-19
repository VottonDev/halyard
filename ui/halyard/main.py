"""Halyard — an unofficial two-way sync client for Proton Drive.

Halyard is an independent open-source project. It is not made, endorsed, or
supported by Proton AG.
"""

from __future__ import annotations

import os
import sys

from gi.repository import Adw, Gdk, Gio, GLib, Gtk  # noqa: E402

from .dbus_client import DaemonClient  # noqa: E402
from .models import Notification  # noqa: E402
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
        self._client.start()

    def do_activate(self) -> None:
        if self._window is None:
            self._window = HalyardWindow(self, self._client, self._settings)
            self._window.connect("destroy", self._on_window_destroyed)
        self._window.present()

    def do_handle_local_options(self, options: GLib.VariantDict) -> int:
        if options.contains("version"):
            print("Halyard 0.1.0")
            return 0
        return -1

    def do_shutdown(self) -> None:
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
