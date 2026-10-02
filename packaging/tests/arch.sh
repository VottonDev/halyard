#!/bin/bash
# Run inside a disposable Arch container, never on the host.
set -euo pipefail
pacman -Syu --noconfirm --needed base-devel nodejs python python-gobject gtk4 libadwaita \
    dbus gnome-keyring xdg-desktop-portal gst-plugins-base gst-plugins-good desktop-file-utils namcap
useradd --create-home builder
mkdir -p /build
# The release-input artifact contains exactly one application archive; recipe
# exports are produced later, so they cannot be mistaken for that archive.
cp /input/PKGBUILD /input/halyard-[0-9]*.tar.gz /build/
chown -R builder:builder /build
runuser -u builder -- bash -c 'cd /build && makepkg --noconfirm && makepkg --printsrcinfo > .SRCINFO'
cp /build/halyard-*.pkg.tar.zst /output/
cp /build/.SRCINFO /output/
source /build/PKGBUILD
srcroot="/build/src/halyard-$pkgver"
epoch="$(stat -c %Y "$srcroot/daemon/package.json")"
for recipe in halyard halyard-bin; do
    pkgbuild="$srcroot/packaging/arch/PKGBUILD"
    if [[ "$recipe" == halyard-bin ]]; then pkgbuild=/build/PKGBUILD; fi
    runuser -u builder -- python "$srcroot/packaging/arch/export.py" \
        --pkgbuild "$pkgbuild" --output "/build/exports/$recipe" --archive-dir /build/exports --epoch "$epoch"
    namcap "/build/exports/$recipe/PKGBUILD" | tee "/build/namcap-$recipe.log"
done
namcap /build/halyard-bin-*.pkg.tar.zst | tee /build/namcap-package.log
# namcap returns success even for errors. Keep advisory warnings visible but
# fail the package job on every error, including missing licence texts.
if grep -q ' E:' /build/namcap-*.log; then exit 1; fi
cp /build/exports/*-aur-*.tar.gz /output/
pacman -U --noconfirm /build/halyard-*.pkg.tar.zst
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
pacman -R --noconfirm "$pkgname"
test ! -e /usr/bin/halyard
test "$(cat /root/.local/share/halyard/package-test-state)" = keep
