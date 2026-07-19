"""Preferences dialog."""

from __future__ import annotations

from gi.repository import Adw, Gtk

from . import daemon_control

from .util import request_autostart

APP_ID = "io.github.votton.Halyard"

AUTOSTART_REASON = ("Halyard syncs your folders in the background, including "
                    "when its window is closed.")


class PreferencesDialog(Adw.PreferencesDialog):
    def __init__(self, client, window, settings) -> None:
        super().__init__()
        self._client = client
        self._window = window
        self._settings = settings
        self._updating = False

        page = Adw.PreferencesPage(
            title="General", icon_name="preferences-system-symbolic"
        )

        startup = Adw.PreferencesGroup(
            title="Startup",
            description=("Syncing only happens while the Halyard service is "
                         "running."),
        )
        self._autostart_row = Adw.SwitchRow(
            title="Start on Login",
            subtitle="Keep folders in sync as soon as you log in",
        )
        self._updating = True
        self._autostart_row.set_active(settings.get_boolean("autostart"))
        self._updating = False
        self._autostart_row.connect("notify::active", self._on_autostart)
        startup.add(self._autostart_row)

        # The window and the service start independently: syncing should keep
        # working whether or not the user wants the window opening at login.
        self._service_row = Adw.SwitchRow(
            title="Start Sync Service on Login",
            subtitle="Sync in the background without opening Halyard",
        )
        self._updating = True
        self._service_row.set_active(daemon_control.is_enabled_at_login())
        self._updating = False
        self._service_row.set_sensitive(
            daemon_control.has_systemd() and daemon_control.unit_installed()
        )
        if not self._service_row.get_sensitive():
            self._service_row.set_subtitle(
                "Set the background service up first, from the main window"
            )
        self._service_row.connect("notify::active", self._on_service_autostart)
        startup.add(self._service_row)
        page.add(startup)

        background = Adw.PreferencesGroup(
            title="Running in the Background",
            description=("Closing the Halyard window does not stop syncing. "
                         "Halyard reports progress through the status icon "
                         "and notifications."),
        )
        self._version_row = Adw.ActionRow(
            title="Sync Service",
            subtitle="Checking…",
        )
        background.add(self._version_row)

        quit_row = Adw.ActionRow(
            title="Stop Syncing Until Next Login",
            subtitle="Shuts down the background service",
        )
        quit_button = Gtk.Button(label="Stop Service", valign=Gtk.Align.CENTER)
        quit_button.add_css_class("destructive-action")
        quit_button.connect("clicked", self._on_quit_daemon)
        quit_row.add_suffix(quit_button)
        background.add(quit_row)
        page.add(background)

        account = Adw.PreferencesGroup(title="Account")
        self._account_row = Adw.ActionRow(
            title="Signed In As",
            subtitle="Not signed in",
        )
        sign_out = Gtk.Button(label="Sign Out", valign=Gtk.Align.CENTER)
        sign_out.connect("clicked", self._on_sign_out)
        self._sign_out_button = sign_out
        self._account_row.add_suffix(sign_out)
        account.add(self._account_row)
        page.add(account)

        self.add(page)
        self._load_version()
        self._load_account()

    # -- data ------------------------------------------------------------

    def _load_version(self) -> None:
        def on_ok(version) -> None:
            self._version_row.set_subtitle(f"Version {version}")

        def on_err(message: str) -> None:
            self._version_row.set_subtitle(message)

        self._client.get_version(on_ok, on_err)

    def _load_account(self) -> None:
        def on_ok(account) -> None:
            if account.logged_in:
                label = account.email or account.display_name or "Signed in"
                self._account_row.set_subtitle(label)
                self._sign_out_button.set_sensitive(True)
            else:
                self._account_row.set_subtitle("Not signed in")
                self._sign_out_button.set_sensitive(False)

        def on_err(message: str) -> None:
            self._account_row.set_subtitle(message)
            self._sign_out_button.set_sensitive(False)

        self._client.get_account(on_ok, on_err)

    # -- actions ---------------------------------------------------------

    def _on_service_autostart(self, row, _param) -> None:
        """Enables or disables the systemd user unit. No elevation involved."""
        if self._updating:
            return
        wanted = row.get_active()
        row.set_sensitive(False)

        def done(ok: bool, message: str) -> None:
            row.set_sensitive(True)
            if ok:
                self._window.toast(
                    "Syncing will start automatically at login"
                    if wanted else "Syncing will no longer start at login"
                )
                return
            # Put the switch back rather than showing a state that is not real.
            self._updating = True
            row.set_active(not wanted)
            self._updating = False
            self._window.toast(message or "Could not change the startup setting")

        daemon_control.set_enabled_at_login(wanted, done)

    def _on_autostart(self, row, _param) -> None:
        if self._updating:
            return
        wanted = row.get_active()
        row.set_sensitive(False)

        def finish(granted: bool) -> None:
            row.set_sensitive(True)
            self._updating = True
            row.set_active(granted)
            self._updating = False
            self._settings.set_boolean("autostart", granted)
            if granted != wanted:
                self._window.toast(
                    "Start on login was not permitted."
                    if wanted else "Start on login is still enabled."
                )

        def on_error(message: str) -> None:
            row.set_sensitive(True)
            self._updating = True
            row.set_active(not wanted)
            self._updating = False
            self._window.toast(message)

        request_autostart(
            wanted, APP_ID, AUTOSTART_REASON, finish, on_error,
        )

    def _on_quit_daemon(self, _button) -> None:
        dialog = Adw.AlertDialog(
            heading="Stop the Sync Service?",
            body=("Your folders will stop syncing until you start Halyard "
                  "again or log back in. Nothing is deleted."),
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("stop", "Stop Service")
        dialog.set_response_appearance(
            "stop", Adw.ResponseAppearance.DESTRUCTIVE
        )
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")

        def on_response(_dialog, response: str) -> None:
            if response == "stop":
                self._client.quit_daemon()
                self._window.toast("Sync service stopped")
                self.close()

        dialog.connect("response", on_response)
        dialog.present(self)

    def _on_sign_out(self, _button) -> None:
        dialog = Adw.AlertDialog(
            heading="Sign Out of Proton Drive?",
            body=("Syncing stops until you sign in again. The files already "
                  "on this computer are left exactly as they are."),
        )
        dialog.add_response("cancel", "Cancel")
        dialog.add_response("signout", "Sign Out")
        dialog.set_response_appearance(
            "signout", Adw.ResponseAppearance.DESTRUCTIVE
        )
        dialog.set_default_response("cancel")
        dialog.set_close_response("cancel")

        def on_response(_dialog, response: str) -> None:
            if response == "signout":
                self._client.logout()
                self.close()

        dialog.connect("response", on_response)
        dialog.present(self)
