#!/bin/sh
# Run inside a disposable Debian/Ubuntu container, never on the host.
set -eu
archive="$1"
mkdir -p /build/source
tar -xzf "$archive" -C /build/source --strip-components=1
cd /build/source
if [ "${HALYARD_TEST_SOURCE:-0}" = 1 ]; then
    # Exercise the ordinary Debian source build, including Bun and git apply.
    sha256sum daemon/dist/halyard-daemon.cjs daemon/dist/THIRD_PARTY_LICENSES.txt \
        > /build/release-bundle.sha256
    ./packaging/build-deb.sh
    # SDK dependencies are partly pinned rather than fully locked. Refuse to
    # publish a rebuild whose bytes or licences differ from archived inputs.
    sha256sum --check /build/release-bundle.sha256
else
    HALYARD_PREBUILT=1 dpkg-buildpackage --build=binary --no-sign
fi
cp /build/halyard_*.deb /output/
# Verify a real package-manager install, including dependency resolution.
apt-get update -qq
apt-get install -y --no-install-recommends /build/halyard_*.deb
test "$(halyard --version)" = "Halyard $(node -p 'require("./daemon/package.json").version')"
desktop-file-validate /usr/share/applications/io.github.votton.Halyard.desktop
PYTHONPATH=/usr/lib/halyard/ui python3 - <<'PY'
from halyard import daemon_control as control
from gi.repository import Gio
assert control.unit_installed()
assert control.service_files_installed()
assert str(control.find_bundle()) == '/usr/lib/halyard/halyard-daemon.cjs'
assert Gio.SettingsSchemaSource.get_default().lookup('io.github.votton.Halyard', True)
PY
test ! -e /etc/systemd/system/halyard-daemon.service
test ! -e /etc/systemd/user/default.target.wants/halyard-daemon.service
# Remove the package and check that user-owned state is retained.
mkdir -p /root/.local/share/halyard
echo keep > /root/.local/share/halyard/package-test-state
apt-get remove -y halyard
test ! -e /usr/bin/halyard
test "$(cat /root/.local/share/halyard/package-test-state)" = keep
