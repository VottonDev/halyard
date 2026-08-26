#!/usr/bin/env bash
# Installs Halyard for the current user under ~/.local and ~/.config.
# Root access is not required.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$REPO_ROOT/daemon"
UI_DIR="$REPO_ROOT/ui"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

DBUS_SERVICE_DIR="$DATA_HOME/dbus-1/services"
SYSTEMD_USER_DIR="$CONFIG_HOME/systemd/user"
DOC_DIR="$DATA_HOME/doc/halyard"
# Installed code goes under lib, not $DATA_HOME/halyard. The latter holds the
# sync database, and mixing program files with user data makes
# "delete the app" and "delete my sync state" the same command.
LIBEXEC_DIR="$HOME/.local/lib/halyard"

say() { printf '\033[1m==>\033[0m %s\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "node is required but not on PATH"
NODE_BIN="$(command -v node)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
    die "Node 22 or newer is required (found $(node -v)); the daemon uses the built-in node:sqlite module"
fi

# ------------------------------------------------------------ proton sdk
# The daemon builds against Proton's Drive SDK, pinned as a git submodule at
# proton-sdk/. Fetch it if this checkout skipped --recurse-submodules, and build
# it once so the daemon has dist/ to bundle.
command -v bun >/dev/null || die "bun is required to install dependencies (the Proton crypto package needs a patch that only bun applies)"

SDK_DIR="$REPO_ROOT/proton-sdk/client/js"
if [ ! -f "$SDK_DIR/package.json" ]; then
    if [ -f "$REPO_ROOT/.gitmodules" ] && command -v git >/dev/null; then
        say "Fetching the Proton SDK submodule"
        (cd "$REPO_ROOT" && git submodule update --init proton-sdk)
    else
        die "the proton-sdk submodule is missing — clone with --recurse-submodules, or run 'git submodule update --init'"
    fi
fi
if [ ! -f "$SDK_DIR/dist/index.js" ]; then
    say "Building the Proton SDK"
    "$REPO_ROOT/scripts/build-proton-sdk.sh"
fi

# ---------------------------------------------------------------- build
say "Building the daemon"
(cd "$DAEMON_DIR" && bun install --frozen-lockfile 2>/dev/null || bun install)
(cd "$DAEMON_DIR" && node scripts/build.mjs)

[ -f "$DAEMON_DIR/dist/halyard-daemon.cjs" ] || die "build did not produce dist/halyard-daemon.cjs"

# ------------------------------------------------------------- install
say "Installing the daemon to $LIBEXEC_DIR"
mkdir -p "$LIBEXEC_DIR"
install -m 0644 "$DAEMON_DIR/dist/halyard-daemon.cjs" "$LIBEXEC_DIR/halyard-daemon.cjs"
DAEMON_PATH="$LIBEXEC_DIR/halyard-daemon.cjs"

say "Installing licence notices"
mkdir -p "$DOC_DIR"
install -m 0644 "$REPO_ROOT/LICENSE" "$DOC_DIR/LICENSE"
install -m 0644 "$REPO_ROOT/THIRD_PARTY_NOTICES.md" "$DOC_DIR/THIRD_PARTY_NOTICES.md"

say "Registering the D-Bus service"
mkdir -p "$DBUS_SERVICE_DIR"
sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@DAEMON@|$DAEMON_PATH|g" \
    "$REPO_ROOT/packaging/io.github.votton.Halyard.Daemon.service.in" \
    > "$DBUS_SERVICE_DIR/io.github.votton.Halyard.Daemon.service"

say "Installing the systemd user unit"
mkdir -p "$SYSTEMD_USER_DIR"
sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@DAEMON@|$DAEMON_PATH|g" \
    "$REPO_ROOT/packaging/halyard-daemon.service.in" \
    > "$SYSTEMD_USER_DIR/halyard-daemon.service"

systemctl --user daemon-reload

# The session bus caches its list of activatable services, so a freshly
# installed .service file is not picked up until it is told to re-read them.
# Without this, the first launch fails with "The name is not activatable"
# until the user logs out and back in.
gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.ReloadConfig >/dev/null 2>&1 || true

# ------------------------------------------------------------------ ui
if [ -d "$UI_DIR" ]; then
    say "Installing the user interface"
    mkdir -p "$LIBEXEC_DIR/ui"
    cp -r "$UI_DIR/halyard" "$LIBEXEC_DIR/ui/"

    mkdir -p "$HOME/.local/bin"
    cat > "$HOME/.local/bin/halyard" <<EOF
#!/usr/bin/env bash
exec python3 -m halyard "\$@"
EOF
    chmod +x "$HOME/.local/bin/halyard"
    # Make the package importable without touching the system Python.
    sed -i "2i export PYTHONPATH=\"$LIBEXEC_DIR/ui:\${PYTHONPATH:-}\"" "$HOME/.local/bin/halyard"

    # The icon has to live in the icon theme, not next to the code. The
    # .desktop file references it by name (Icon=io.github.votton.Halyard), so
    # without this the app shows up in search with a generic placeholder.
    ICON_SRC="$UI_DIR/halyard/data/icons/hicolor/scalable/apps/io.github.votton.Halyard.svg"
    if [ -f "$ICON_SRC" ]; then
        ICON_DIR="$DATA_HOME/icons/hicolor/scalable/apps"
        mkdir -p "$ICON_DIR"
        install -m 0644 "$ICON_SRC" "$ICON_DIR/io.github.votton.Halyard.svg"
        # Harmless if absent or if the theme has no cache to refresh.
        gtk-update-icon-cache -q -t -f "$DATA_HOME/icons/hicolor" 2>/dev/null || true
    fi

    DESKTOP_SRC="$UI_DIR/halyard/data/io.github.votton.Halyard.desktop"
    if [ -f "$DESKTOP_SRC" ]; then
        mkdir -p "$DATA_HOME/applications"
        sed -e "s|@BIN@|$HOME/.local/bin/halyard|g" "$DESKTOP_SRC" \
            > "$DATA_HOME/applications/io.github.votton.Halyard.desktop"
        update-desktop-database "$DATA_HOME/applications" 2>/dev/null || true
    fi
fi

cat <<EOF

$(say "Done")

Start syncing in the background now:
    systemctl --user enable --now halyard-daemon.service

Open the app:
    halyard

The daemon is D-Bus activated, so the app will start it on demand even without
the systemd unit enabled — but enabling it is what makes sync run at login,
before you open the window.

Logs:
    journalctl --user -u halyard-daemon -f
    ~/.local/state/halyard/halyard.log
EOF
