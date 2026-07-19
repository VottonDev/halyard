"""Formatting helpers and the XDG Background portal."""

from __future__ import annotations

import os
import time
from typing import Callable

from gi.repository import Gio, GLib

HOME = os.path.expanduser("~")


# -- formatting ----------------------------------------------------------


def tilde_path(path: str) -> str:
    """Shorten a path under the home directory to a leading ``~``."""
    if not path:
        return ""
    if path == HOME:
        return "~"
    if path.startswith(HOME + os.sep):
        return "~" + path[len(HOME):]
    return path


def format_size(num_bytes: int) -> str:
    """Human-readable size, in the SI-ish units GNOME uses."""
    if num_bytes is None:
        return ""
    value = float(max(0, num_bytes))
    if value < 1000:
        return f"{int(value)} B"
    for unit in ("kB", "MB", "GB", "TB", "PB"):
        value /= 1000.0
        if value < 1000:
            precision = 1 if value < 10 else 0
            return f"{value:.{precision}f} {unit}"
    return f"{value:.0f} EB"


def format_count(n: int, singular: str, plural: str | None = None) -> str:
    plural = plural or f"{singular}s"
    return f"{n} {singular if n == 1 else plural}"


def format_relative_time(epoch_ms: int | None) -> str:
    """"5 minutes ago", "yesterday", and so on. Never a bare timestamp."""
    if not epoch_ms:
        return "never"
    seconds = time.time() - (epoch_ms / 1000.0)
    if seconds < 0:
        return "just now"
    if seconds < 45:
        return "just now"
    minutes = seconds / 60
    if minutes < 60:
        return f"{format_count(int(round(minutes)) or 1, 'minute')} ago"
    hours = minutes / 60
    if hours < 24:
        return f"{format_count(int(round(hours)) or 1, 'hour')} ago"
    days = hours / 24
    if days < 2:
        return "yesterday"
    if days < 30:
        return f"{int(days)} days ago"
    dt = GLib.DateTime.new_from_unix_local(int(epoch_ms / 1000))
    return dt.format("%-d %B %Y") or "a long time ago"


def format_absolute_time(epoch_ms: int | None) -> str:
    if not epoch_ms:
        return "unknown"
    dt = GLib.DateTime.new_from_unix_local(int(epoch_ms / 1000))
    return dt.format("%e %b %Y, %H:%M").strip() or "unknown"


def paths_overlap(a: str, b: str) -> bool:
    """True when two directories are the same, or one contains the other."""
    if not a or not b:
        return False
    a = os.path.normpath(a).rstrip(os.sep) or os.sep
    b = os.path.normpath(b).rstrip(os.sep) or os.sep
    if a == b:
        return True
    return a.startswith(b + os.sep) or b.startswith(a + os.sep)


# -- XDG Background portal ----------------------------------------------

PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
PORTAL_BACKGROUND = "org.freedesktop.portal.Background"
PORTAL_REQUEST = "org.freedesktop.portal.Request"


def request_autostart(
    enabled: bool,
    app_id: str,
    reason: str,
    on_result: Callable[[bool], None],
    on_error: Callable[[str], None],
    parent_window_handle: str = "",
) -> None:
    """Ask the Background portal to enable or disable autostart.

    This deliberately goes through the portal rather than writing a
    ``~/.config/autostart`` desktop file by hand: the portal is what asks the
    user for consent, and it works identically inside and outside a sandbox.

    Fully asynchronous. ``on_result`` receives the autostart state the portal
    actually granted, which may differ from what was asked for if the user
    declines.
    """
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as error:
        on_error(error.message or "Could not reach the session bus.")
        return

    unique = bus.get_unique_name() or ""
    token = f"halyard_{GLib.random_int_range(1, 2**31 - 1)}"
    sender = unique.lstrip(":").replace(".", "_")
    request_path = f"{PORTAL_PATH}/request/{sender}/{token}"

    state: dict = {"subscription": 0, "settled": False}

    def settle(fn: Callable[[], None]) -> None:
        if state["settled"]:
            return
        state["settled"] = True
        if state["subscription"]:
            bus.signal_unsubscribe(state["subscription"])
            state["subscription"] = 0
        fn()

    def on_response(conn, sender_name, path, iface, signal, params) -> None:
        try:
            response, results = params.unpack()
        except (ValueError, TypeError):
            settle(lambda: on_error("The portal sent an unexpected reply."))
            return
        if response == 1:
            settle(lambda: on_result(not enabled))  # user cancelled
            return
        if response != 0:
            settle(lambda: on_error(
                "The desktop portal refused the request."
            ))
            return
        granted = bool(results.get("autostart", False))
        settle(lambda: on_result(granted))

    # Subscribe *before* calling, using the path the portal spec says the
    # request will have. Subscribing afterwards would race the response.
    state["subscription"] = bus.signal_subscribe(
        PORTAL_BUS,
        PORTAL_REQUEST,
        "Response",
        request_path,
        None,
        Gio.DBusSignalFlags.NONE,
        on_response,
    )

    options = {
        "handle_token": GLib.Variant("s", token),
        "reason": GLib.Variant("s", reason),
        "autostart": GLib.Variant("b", enabled),
        "commandline": GLib.Variant("as", [app_id, "--gapplication-service"]),
        "dbus-activatable": GLib.Variant("b", False),
    }

    def on_call_done(source, result) -> None:
        try:
            source.call_finish(result)
        except GLib.Error as error:
            message = Gio.dbus_error_strip_remote_error(error).message
            if Gio.dbus_error_get_remote_error(error) in (
                "org.freedesktop.DBus.Error.ServiceUnknown",
                "org.freedesktop.DBus.Error.NameHasNoOwner",
            ):
                message = ("No desktop portal is available, so Halyard cannot "
                           "register itself to start on login.")
            settle(lambda: on_error(
                message or "The desktop portal could not be reached."
            ))

    bus.call(
        PORTAL_BUS,
        PORTAL_PATH,
        PORTAL_BACKGROUND,
        "RequestBackground",
        GLib.Variant("(sa{sv})", [parent_window_handle, options]),
        GLib.VariantType("(o)"),
        Gio.DBusCallFlags.NONE,
        120_000,
        None,
        on_call_done,
    )
