"""The signed-out screen.

Sign-in is a browser hand-off: the daemon returns a URL, the UI opens it, and
the daemon reports the outcome through LoginStateChanged. Halyard never sees
the password, and this screen says so.
"""

from __future__ import annotations

from gi.repository import Adw, GLib, Gtk

from .models import LoginState

# Required disclosure. Proton's SDK terms require this wherever account access
# is requested, so it must remain visible on this screen. Do not move it to a
# tooltip or hide it behind a dialog.
DISCLOSURE = ("This is a third-party application not officially supported "
              "by Proton.")


class LoginView(Gtk.Box):
    """Signed-out state, with its own idle / waiting / failed sub-states."""

    def __init__(self, client, window) -> None:
        super().__init__(orientation=Gtk.Orientation.VERTICAL)
        self._client = client
        self._window = window
        self._waiting = False

        self._banner = Adw.Banner(revealed=False)
        self._banner.set_use_markup(False)
        self.append(self._banner)

        status = Adw.StatusPage(
            icon_name="folder-remote-symbolic",
            title="Sync with Proton Drive",
            description=(
                "Halyard keeps folders on this computer in step with your "
                "Proton Drive."
            ),
            vexpand=True,
        )
        status.add_css_class("compact")
        self.append(status)

        content = Gtk.Box(
            orientation=Gtk.Orientation.VERTICAL,
            spacing=24,
            halign=Gtk.Align.CENTER,
        )
        content.set_size_request(360, -1)

        self._stack = Gtk.Stack(
            transition_type=Gtk.StackTransitionType.CROSSFADE,
            vhomogeneous=False,
        )
        self._stack.add_named(self._build_idle(), "idle")
        self._stack.add_named(self._build_waiting(), "waiting")
        content.append(self._stack)

        content.append(self._build_disclosure())
        status.set_child(content)

    # -- sub-states ------------------------------------------------------

    def _build_idle(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)

        self._sign_in_button = Gtk.Button(
            label="Sign In with Proton",
            halign=Gtk.Align.CENTER,
        )
        self._sign_in_button.add_css_class("suggested-action")
        self._sign_in_button.add_css_class("pill")
        self._sign_in_button.connect("clicked", self._on_sign_in_clicked)
        box.append(self._sign_in_button)

        hint = Gtk.Label(
            label=("Sign-in opens in your web browser. Halyard never sees "
                   "your password, and two-factor authentication is handled "
                   "by Proton."),
            wrap=True,
            justify=Gtk.Justification.CENTER,
            max_width_chars=44,
        )
        hint.add_css_class("dim-label")
        hint.add_css_class("caption")
        box.append(hint)
        return box

    def _build_waiting(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)

        row = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=12,
            halign=Gtk.Align.CENTER,
        )
        spinner = Adw.Spinner()
        spinner.set_size_request(24, 24)
        row.append(spinner)
        label = Gtk.Label(label="Waiting for your browser…")
        label.add_css_class("heading")
        row.append(label)
        box.append(row)

        hint = Gtk.Label(
            label=("Finish signing in on the page that opened. This window "
                   "will continue on its own."),
            wrap=True,
            justify=Gtk.Justification.CENTER,
            max_width_chars=44,
        )
        hint.add_css_class("dim-label")
        hint.add_css_class("caption")
        box.append(hint)

        buttons = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=8,
            halign=Gtk.Align.CENTER,
        )
        cancel = Gtk.Button(label="Cancel")
        cancel.add_css_class("pill")
        cancel.connect("clicked", self._on_cancel_clicked)
        buttons.append(cancel)

        reopen = Gtk.Button(label="Open Page Again")
        reopen.add_css_class("pill")
        reopen.connect("clicked", self._on_reopen_clicked)
        buttons.append(reopen)
        box.append(buttons)
        return box

    def _build_disclosure(self) -> Gtk.Widget:
        """The mandatory third-party disclosure. Always visible."""
        frame = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL,
            spacing=12,
        )
        frame.add_css_class("card")
        frame.add_css_class("halyard-disclosure")
        frame.set_margin_top(8)

        icon = Gtk.Image.new_from_icon_name("dialog-information-symbolic")
        icon.set_valign(Gtk.Align.START)
        icon.add_css_class("halyard-disclosure-icon")
        frame.append(icon)

        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        headline = Gtk.Label(
            label=DISCLOSURE,
            wrap=True,
            xalign=0.0,
            max_width_chars=40,
        )
        headline.add_css_class("heading")
        text.append(headline)

        detail = Gtk.Label(
            label=("Halyard is an independent open-source client. It is not "
                   "made, endorsed, or supported by Proton AG."),
            wrap=True,
            xalign=0.0,
            max_width_chars=40,
        )
        detail.add_css_class("dim-label")
        detail.add_css_class("caption")
        text.append(detail)

        frame.append(text)
        return frame

    # -- actions ---------------------------------------------------------

    def _set_waiting(self, waiting: bool) -> None:
        self._waiting = waiting
        self._stack.set_visible_child_name("waiting" if waiting else "idle")

    def reset(self) -> None:
        self._set_waiting(False)
        self._banner.set_revealed(False)
        self._sign_in_button.set_sensitive(True)
        self._sign_in_url = ""

    _sign_in_url = ""

    def _on_sign_in_clicked(self, _button) -> None:
        self._banner.set_revealed(False)
        self._sign_in_button.set_sensitive(False)

        def on_ok(url: str) -> None:
            self._sign_in_button.set_sensitive(True)
            self._sign_in_url = url
            self._set_waiting(True)
            self._open_url(url)

        def on_err(message: str) -> None:
            self._sign_in_button.set_sensitive(True)
            self._set_waiting(False)
            self._show_error(message)

        self._client.begin_login(on_ok, on_err)

    def _open_url(self, url: str) -> None:
        launcher = Gtk.UriLauncher.new(url)

        def done(source, result) -> None:
            try:
                source.launch_finish(result)
            except GLib.Error as error:
                # Not fatal: the user can still copy the link.
                self._show_error(
                    f"Could not open your browser: {error.message}. "
                    "Copy the sign-in link instead.",
                    copy_url=url,
                )

        launcher.launch(self._window, None, done)

    def _on_reopen_clicked(self, _button) -> None:
        if self._sign_in_url:
            self._open_url(self._sign_in_url)

    def _on_cancel_clicked(self, _button) -> None:
        self._set_waiting(False)
        self._client.cancel_login()

    def _show_error(self, message: str, copy_url: str = "") -> None:
        self._banner.set_title(message)
        if copy_url:
            self._banner.set_button_label("Copy Link")

            def on_clicked(_banner) -> None:
                clipboard = self.get_clipboard()
                clipboard.set(copy_url)

            self._banner.connect("button-clicked", on_clicked)
        else:
            self._banner.set_button_label("")
        self._banner.set_revealed(True)

    # -- daemon feedback -------------------------------------------------

    def on_login_state(self, state: LoginState) -> None:
        if state.state == "pending":
            self._set_waiting(True)
        elif state.state == "success":
            self._set_waiting(False)
            self._banner.set_revealed(False)
        elif state.state == "cancelled":
            self._set_waiting(False)
        elif state.state == "failed":
            self._set_waiting(False)
            self._show_error(state.error or "Sign-in failed. Please try again.")
