# Distribution packages

Halyard provides conventional Debian/Ubuntu `debian/` metadata and Arch
`PKGBUILD` recipes. Both packages contain the bundled daemon and Python UI;
Node, GTK and the other runtime dependencies are managed by apt or pacman.
End users do not need Bun, the SDK checkout, or a compiler.

## Install a release package

Download a package from [Halyard releases](https://github.com/VottonDev/halyard/releases).

Debian/Ubuntu:

```sh
sudo apt install ./halyard_*_all.deb
```

Arch Linux:

```sh
sudo pacman -U ./halyard-*-any.pkg.tar.zst
```

Run these commands in a directory containing the one package you downloaded.
They install system-owned application files with the package manager.
Open **Halyard** from the application menu, or run `halyard`. Its daemon runs
as your user on the session bus. Package installation does not start a sync
session or enable the daemon for every user. Choose background startup in the
app's Preferences.

### Supported dependencies

The UI requires GTK **4.10+** and libadwaita **1.6+**. The daemon requires
system Node **22.13+**, including `node:sqlite` without a command-line flag.
The package declares these versions so apt/pacman resolves them automatically
and rejects an installation whose repositories cannot provide them.

| Distribution | Standard repositories |
| --- | --- |
| Ubuntu 26.04 | Satisfy the runtime requirements. |
| Ubuntu 24.04 | libadwaita 1.5 and Node 18 are too old. The standard repositories do not satisfy the runtime requirements. |
| Debian 13 | GTK and libadwaita are sufficient. Node 20 is too old. Enable a trusted Node 22.13 or newer apt repository first. |
| Ubuntu 22.04 / Debian 12 | GTK/libadwaita are too old; these releases are unsupported. |
| Current Arch Linux | Satisfies the runtime requirements. |

Node repository versions: [Ubuntu 26.04](https://packages.ubuntu.com/source/resolute/nodejs),
[Ubuntu 24.04](https://packages.ubuntu.com/source/noble/nodejs),
[Debian 13](https://packages.debian.org/source/trixie/nodejs).

`sudo apt install nodejs` installs the version offered by your enabled
repositories. Halyard does not add repositories, run remote installation
scripts, bundle a private Node runtime, or replace another application's Node.

### Replacing a manual installation

An earlier `packaging/install.sh` installation under `~/.local` takes precedence
over package-owned launchers and services. Stop Halyard before switching, then
remove only the old application files and service definitions:

```sh
was_enabled=false
if systemctl --user is-enabled --quiet halyard-daemon.service; then
  was_enabled=true
fi
systemctl --user disable --now halyard-daemon.service
rm -f ~/.local/bin/halyard
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/halyard-daemon.service"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/dbus-1/services/io.github.votton.Halyard.Daemon.service"
rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/io.github.votton.Halyard.desktop"
rm -rf ~/.local/lib/halyard
systemctl --user daemon-reload
if [ "$was_enabled" = true ]; then
  systemctl --user enable halyard-daemon.service
fi
hash -r
```

Keep `~/.local/share/halyard`, the keyring, and paired folders. They hold sync
state, credentials and your files, and belong to the user rather than the
package. The commands preserve the startup preference by recreating an enabled
service's link against the package unit after removing the old override.
Uninstalling a package also
preserves user data; quit Halyard before removing it.

## Build packages

Build prerequisites are Node 22.15+, Bun 1.3.11+, Python 3 and Git. The test
loader needs Node 22.15's module hooks; the installed daemon needs only 22.13.
Bun is a
build tool, required for the crypto patch; Debian/Ubuntu do not provide it in
all standard repositories, so install it in the build environment separately.
`debian/rules` checks this through the shared build script. Production runtime
dependencies never include Bun.

### Debian/Ubuntu source build

On Ubuntu 26.04, install the distro build tools:

```sh
sudo apt install build-essential debhelper devscripts git nodejs python3 python3-gi \
  gir1.2-gtk-4.0 gir1.2-adw-1
git submodule update --init proton-sdk
./packaging/build-deb.sh
```

The standard debhelper rules build the pinned SDK with Bun, bundle the daemon,
run offline tests and stage files. The wrapper generates `debian/changelog`
from the application version, then calls `dpkg-buildpackage --build=binary
--no-sign`. The resulting `.deb` is written to the parent directory.
Builds currently download JS dependencies using the daemon lockfile and SDK
dependency pins; this is upstream packaging,
not a claim that the source is ready for admission to Debian's official archive.

### Arch source build

Once the source tag matching the application version is published:

```sh
python3 packaging/versioning.py
cd packaging/arch
makepkg -s
```

The source recipe pins the Halyard release tag and Proton SDK commit, fetches
only that submodule, and runs the shared build and tests. Bun is a build
dependency. No live-account tests run.

### Build both downloadable packages

The release process bundles the daemon, includes the application source,
SDK source, exact bundled dependency inputs, source map and complete licence
notices, and creates a checksummed release archive:

```sh
./packaging/build.sh
python3 packaging/release.py --epoch "$(git log -1 --format=%ct)"
```

`dist/packages/PKGBUILD` packages the prebuilt release bundle using makepkg;
it embeds the archive's SHA-256 and has no Bun dependency. This is the recipe
used for the downloadable Arch binary. To build it locally on Arch:

```sh
cd dist/packages
makepkg -s
```

On Debian/Ubuntu, extract the same archive and build it with
`HALYARD_PREBUILT=1 dpkg-buildpackage --build=binary --no-sign`. This still
runs Python and packaging tests and lets debhelper handle schema triggers,
desktop integration and package metadata.

The package workflow runs on pull requests, main pushes, version tags and
manual dispatch. It builds and installs/removes both formats in disposable
containers. A matching `v<version>` tag attaches the packages, source archive,
PKGBUILD and checksums to a GitHub release and **publishes it automatically**
after the daemon tests and both native package checks pass. Assets are attached
while the release is still a draft so a failure cannot expose a partial release.
Reruns never replace assets of an already published release.
For each release, edit **only `version` in `daemon/package.json`**, commit the
change and push a matching `v<version>` tag. The daemon, UI, archive and package
filenames all derive their version from that manifest. Debian's changelog and
Arch's source PKGBUILD are generated from version-free `.in` templates; the
generated files are ignored by Git. `python3 packaging/versioning.py` refreshes
them locally without building the application.

Release workflow actions are pinned to commit hashes. Dependabot checks for
GitHub Actions updates weekly and proposes updates to those pins.

The Debian job uses the ordinary source build with a pinned Bun binary in its
build environment and verifies its rebuilt daemon and licence inventory match
the release archive. The Arch Git/submodule `prepare()` hook is also exercised
offline against the real pinned SDK before the binary recipe is tested.

## Installed layout

| Path | Purpose |
| --- | --- |
| `/usr/bin/halyard` | Python UI launcher |
| `/usr/lib/halyard/` | Daemon bundle and private Python application package |
| `/usr/lib/systemd/user/halyard-daemon.service` | System-wide definition of a user service |
| `/usr/share/dbus-1/services/` | Session-bus activation |
| `/usr/share/applications/` and `/usr/share/icons/` | Desktop integration |
| `/usr/share/glib-2.0/schemas/` | Persistent UI preferences |
| `/usr/share/doc/halyard/` and `/usr/share/licenses/halyard/` | Licence notices |

There is no system daemon, global autostart, root sync process, or package hook
that edits user credentials or sync state.
