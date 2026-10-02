#!/bin/bash
# Run inside a disposable Arch container, never on the host.
set -euo pipefail
pacman -Syu --noconfirm --needed base-devel nodejs python python-gobject gtk4 libadwaita \
    dbus gnome-keyring xdg-desktop-portal gst-plugins-base gst-plugins-good desktop-file-utils
useradd --create-home builder
mkdir -p /build
cp /input/PKGBUILD /input/halyard-*.tar.gz /build/
chown -R builder:builder /build
runuser -u builder -- bash -c 'cd /build && makepkg --noconfirm && makepkg --printsrcinfo > .SRCINFO'
cp /build/halyard-*.pkg.tar.zst /output/
cp /build/.SRCINFO /output/
pacman -U --noconfirm /build/halyard-*.pkg.tar.zst
source /build/PKGBUILD
test "$(halyard --version)" = "Halyard $pkgver"
desktop-file-validate /usr/share/applications/io.github.votton.Halyard.desktop
PYTHONPATH=/usr/lib/halyard/ui python - <<'PY'
from halyard import daemon_control as control
from gi.repository import Gio
assert control.unit_installed()
assert control.service_files_installed()
assert str(control.find_bundle()) == '/usr/lib/halyard/halyard-daemon.cjs'
assert Gio.SettingsSchemaSource.get_default().lookup('io.github.votton.Halyard', True)
PY
test ! -e /etc/systemd/user/default.target.wants/halyard-daemon.service
mkdir -p /root/.local/share/halyard
echo keep > /root/.local/share/halyard/package-test-state
pacman -R --noconfirm halyard
test ! -e /usr/bin/halyard
test "$(cat /root/.local/share/halyard/package-test-state)" = keep
