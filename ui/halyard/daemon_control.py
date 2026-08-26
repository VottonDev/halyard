"""Starting and enabling the sync daemon, without ever needing root.

The daemon is a *user* service in every sense: it runs as the user, stores its
session in the user's keyring, writes only under the user's home, and registers
on the session bus. Nothing it does touches a system path, so nothing it does
requires elevation. If a future change appears to need sudo here, that is a
sign the change is wrong, not that a password prompt is missing.

Three ways to get it running, tried in order of how well they survive a reboot:

1. ``systemctl --user start`` — a real unit, and the only option that can also
   be enabled to start at login.
2. D-Bus activation — the session bus starts it on demand from its .service
   file. Works even with no systemd unit enabled.
3. Spawning the bundle directly — the fallback when nothing is installed,
   which is the normal case when running from a git checkout.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Callable

from gi.repository import Gio, GLib

BUS_NAME = os.environ.get("HALYARD_BUS_NAME") or "io.github.votton.Halyard.Daemon"
OBJECT_PATH = "/io/github/votton/Halyard/Daemon"
UNIT_NAME = "halyard-daemon.service"

DATA_HOME = Path(GLib.get_user_data_dir())
CONFIG_HOME = Path(GLib.get_user_config_dir())

DBUS_SERVICE_FILE = DATA_HOME / "dbus-1" / "services" / f"{BUS_NAME}.service"
SYSTEMD_UNIT_FILE = CONFIG_HOME / "systemd" / "user" / UNIT_NAME

#: Where the built daemon might live, most-installed first.
_BUNDLE_CANDIDATES = (
    Path.home() / ".local/lib/halyard/halyard-daemon.cjs",
    DATA_HOME / "halyard/halyard-daemon.cjs",  # pre-0.1 install location
    Path(__file__).resolve().parent.parent.parent / "daemon/dist/halyard-daemon.cjs",
)


def find_bundle() -> Path | None:
    """Locates the built daemon, or None if it has not been built."""
    for candidate in _BUNDLE_CANDIDATES:
        if candidate.is_file():
            return candidate
    return None


def find_node() -> str | None:
    return shutil.which("node")


def service_files_installed() -> bool:
    return DBUS_SERVICE_FILE.is_file()


def unit_installed() -> bool:
    return SYSTEMD_UNIT_FILE.is_file()


def _run(argv: list[str], done: Callable[[bool, str], None]) -> None:
    """Runs a command asynchronously; the UI must never block on this."""
    try:
        proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE)
    except GLib.Error as error:
        done(False, error.message)
        return

    def finished(source: Gio.Subprocess, result: Gio.AsyncResult) -> None:
        try:
            ok, _out, err = source.communicate_utf8_finish(result)
            if ok and source.get_successful():
                done(True, "")
            else:
                done(False, (err or "").strip() or "command failed")
        except GLib.Error as error:
            done(False, error.message)

    proc.communicate_utf8_async(None, None, finished)


def has_systemd() -> bool:
    return shutil.which("systemctl") is not None and Path("/run/systemd/system").exists()


# --------------------------------------------------------------------------- state


def is_running(on_result: Callable[[bool], None]) -> None:
    """Asks the bus whether anyone currently owns the daemon's name."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error:
        on_result(False)
        return

    def finished(source: Gio.DBusConnection, result: Gio.AsyncResult) -> None:
        try:
            owned = source.call_finish(result).unpack()[0]
        except GLib.Error:
            owned = False
        on_result(bool(owned))

    bus.call(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "NameHasOwner", GLib.Variant("(s)", (BUS_NAME,)),
        GLib.VariantType.new("(b)"), Gio.DBusCallFlags.NONE, 5000, None, finished,
    )


def is_enabled_at_login(on_result: Callable[[bool], None]) -> None:
    """Asks systemd whether the unit starts at login; never blocks the UI."""
    if not has_systemd() or not unit_installed():
        on_result(False)
        return
    try:
        proc = Gio.Subprocess.new(
            ["systemctl", "--user", "is-enabled", UNIT_NAME],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        )
    except GLib.Error:
        on_result(False)
        return

    def finished(source: Gio.Subprocess, result: Gio.AsyncResult) -> None:
        try:
            ok, out, _err = source.communicate_utf8_finish(result)
            on_result(bool(ok) and (out or "").strip() == "enabled")
        except GLib.Error:
            on_result(False)

    proc.communicate_utf8_async(None, None, finished)


# --------------------------------------------------------------------------- actions


def start(done: Callable[[bool, str], None]) -> None:
    """Starts the daemon by whichever route is available."""
    if has_systemd() and unit_installed():
        _run(["systemctl", "--user", "start", UNIT_NAME], done)
        return

    if service_files_installed():
        # Any method call activates it; GetVersion is the cheapest and has no
        # side effects.
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error as error:
            done(False, error.message)
            return

        def finished(source: Gio.DBusConnection, result: Gio.AsyncResult) -> None:
            try:
                source.call_finish(result)
                done(True, "")
            except GLib.Error as error:
                done(False, error.message)

        bus.call(
            BUS_NAME, OBJECT_PATH, BUS_NAME, "GetVersion", None,
            GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NONE, 30000, None, finished,
        )
        return

    _spawn_directly(done)


def _spawn_directly(done: Callable[[bool, str], None]) -> None:
    """Last resort: run the bundle detached, for an uninstalled checkout."""
    bundle = find_bundle()
    node = find_node()
    if bundle is None:
        done(False, "The sync service has not been built yet. Run: cd daemon && bun install && node scripts/build.mjs")
        return
    if node is None:
        done(False, "Node.js was not found on PATH. The sync service needs Node 22 or newer.")
        return

    try:
        launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE)
        # Detach so the daemon outlives this window, which is the whole point.
        launcher.setenv("HALYARD_DETACHED", "1", True)
        launcher.spawnv([node, str(bundle)])
        done(True, "")
    except GLib.Error as error:
        done(False, error.message)


def set_enabled_at_login(enabled: bool, done: Callable[[bool, str], None]) -> None:
    if not has_systemd():
        done(False, "systemd user services are not available on this system.")
        return
    if not unit_installed():
        done(False, "The background service is not set up yet.")
        return
    verb = "enable" if enabled else "disable"
    _run(["systemctl", "--user", verb, UNIT_NAME], done)


#: Fallback for when no checkout provides packaging/halyard-daemon.service.in
#: (an installed UI, for instance). Must stay byte-identical to that template:
#: both write the same file, and whichever runs last wins — an earlier version
#: of this inline unit silently dropped the template's whole hardening block.
_UNIT_TEMPLATE_FALLBACK = """\
[Unit]
Description=Halyard — two-way sync for Proton Drive (unofficial)
Documentation=https://github.com/VottonDev/halyard
# The daemon needs the session bus and the keyring to reach the account.
After=graphical-session.target

[Service]
Type=dbus
BusName=io.github.votton.Halyard.Daemon
ExecStart=@NODE@ @DAEMON@
Restart=on-failure
RestartSec=10
# Sync is background work; never let it compete with the desktop for CPU or IO.
Nice=10
IOSchedulingClass=idle

# The daemon only ever needs the user's own files, and hardening a sync tool
# that legitimately writes all over $HOME is mostly about limiting blast radius
# elsewhere on the system.
PrivateTmp=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
NoNewPrivileges=yes
ReadWritePaths=%h

[Install]
WantedBy=default.target
"""

_UNIT_TEMPLATE_FILE = Path(__file__).resolve().parent.parent.parent / "packaging" / "halyard-daemon.service.in"


def _unit_text(node: str, bundle: Path) -> str:
    """The systemd unit, from the packaging template when a checkout has it."""
    try:
        template = _UNIT_TEMPLATE_FILE.read_text()
    except OSError:
        template = _UNIT_TEMPLATE_FALLBACK
    return (
        template.replace("@NODE@", node)
        .replace("@DAEMON@", str(bundle))
        # The template hardcodes the production name; honour HALYARD_BUS_NAME
        # the same way the rest of this module does.
        .replace("BusName=io.github.votton.Halyard.Daemon", f"BusName={BUS_NAME}")
    )


def install_service_files(done: Callable[[bool, str], None]) -> None:
    """
    Writes the D-Bus activation file and systemd unit into the user's own
    config. No elevation: both live under $XDG_DATA_HOME and $XDG_CONFIG_HOME.
    """
    bundle = find_bundle()
    node = find_node()
    if bundle is None:
        done(False, "The sync service has not been built yet. Run: cd daemon && bun install && node scripts/build.mjs")
        return
    if node is None:
        done(False, "Node.js was not found on PATH. The sync service needs Node 22 or newer.")
        return

    try:
        DBUS_SERVICE_FILE.parent.mkdir(parents=True, exist_ok=True)
        DBUS_SERVICE_FILE.write_text(
            "[D-BUS Service]\n"
            f"Name={BUS_NAME}\n"
            f"Exec={node} {bundle}\n"
            f"SystemdService={UNIT_NAME}\n"
        )

        SYSTEMD_UNIT_FILE.parent.mkdir(parents=True, exist_ok=True)
        SYSTEMD_UNIT_FILE.write_text(_unit_text(node, bundle))
    except OSError as error:
        done(False, str(error))
        return

    def reloaded(_ok: bool, _message: str) -> None:
        # The session bus caches its activatable services; without this the
        # first launch fails until the next login.
        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "ReloadConfig", None, None, Gio.DBusCallFlags.NONE, 5000, None,
            )
        except GLib.Error:
            pass
        done(True, "")

    if has_systemd():
        _run(["systemctl", "--user", "daemon-reload"], reloaded)
    else:
        reloaded(True, "")
