# AGENTS.md

Working notes for Halyard — an unofficial two-way Proton Drive sync client for
GNOME. Read this before changing anything. The code alone does not explain
several constraints here.

## Layout

Two processes, one contract.

```
daemon/   Node sync engine. Owns the Proton SDK, auth, and all Drive access.
ui/       Python GTK4 + libadwaita front end. Thin client, no Proton code.
docs/dbus-api.md   The contract between them. Treat as an interface, not a note.
packaging/         D-Bus activation, systemd user unit, installer.
debian/            Debian/Ubuntu debhelper packaging metadata.
```

The engine runs on Node because the Drive SDK uses TypeScript. Its crypto
package ships raw ESM `.ts` files. The GNOME interface uses GTK.
Keep the daemon and UI as separate processes.

## Commands

Run these commands from the repository root:

```bash
cd daemon
bun install                    # bun, not npm — see below
node scripts/build.mjs         # → dist/halyard-daemon.cjs (this is what runs)
bun run test                   # all offline suites (see below)
bun test                       # pure logic only: reconciler, ignore, exclude
bun run test:node              # anything touching node:sqlite
./node_modules/.bin/tsc --noEmit
HALYARD_LOG_LEVEL=debug HALYARD_LOG_STDERR=1 node dist/halyard-daemon.cjs
```

For UI development, start from the repository root:

```bash
cd ui
./run-dev.sh                   # mock daemon + UI
python3 -m halyard             # against the real daemon
```

**The daemon runs from `dist/`, not `src/`.** Editing source without rebuilding
changes nothing. Always `node scripts/build.mjs` before testing behaviour.

## Non-obvious build constraints

Each of these cost real debugging time. Do not "simplify" them away.

- **Bun is mandatory.** `@protontech/crypto` needs a patch applied through
  `patchedDependencies`, which npm does not support. npm install produces a
  broken crypto package.
- **The daemon must be bundled.** `@protontech/crypto` and
  `proton-drive-sdk-account` publish raw TypeScript — crypto's package exports
  point directly at `.ts` files. Node cannot load either directly.
- **`preserveSymlinks` is required** in both `tsconfig.json` and the esbuild
  config. The SDK packages use `file:` dependencies, which create symlinks.
  Without this setting, resolution starts from the SDK's real path in
  `../proton-sdk`. Our `node_modules` directory is absent there, so imports fail.
- **`import.meta.url` needs the banner** in `scripts/build.mjs`. openpgp calls
  `createRequire(import.meta.url)` internally, which is `undefined` once bundled
  to CJS.
- **`x11` is aliased to a stub.** `dbus-next` optionally requires it in an
  unreachable X11 fallback. The stub exports `null`, which dbus-next checks for.
- **Keep both test runners.** Bun does not implement `node:sqlite`.
  Tests that use `SyncDatabase` must run under Node. Name these files
  `*.nodetest.ts` so Bun's `*.test.ts` glob skips them. Run them with
  `bun run test:node`. Keep pure logic tests in `*.test.ts` under Bun.

  Node cannot resolve the `.js` specifiers used in `src/` to the TypeScript sources.
  The Node test command loads `test/support/register.mjs` to rewrite these
  specifiers to `.ts` and erase types with esbuild.
  Distribution builds of Node can omit native type stripping.

  Crypto-cache, shared-sync and download-concurrency tests require both
  `node:sqlite` and bundled SDK dependencies. Name these files `*.bundletest.ts`.
  Their commands bundle each suite before running it under Node:
  `bun run test:crypto`, `bun run test:shared` and `bun run test:downloads`.
  Source builds and tests require Node 22.15+ for module hooks.
  The installed daemon can run on Node 22.13+.
- **Build the SDK submodule before compiling the daemon.** `proton-sdk` is
  pinned at tag `js/v0.22.2`. It lives at the repository root, or
  `../proton-sdk` from `daemon/`. Run `git submodule update --init` to fetch it.
  Run `./scripts/build-proton-sdk.sh` from the repository root to build `client/js`.
  `packaging/install.sh` fetches and builds it automatically.

  The submodule comes from `github.com/ProtonDriveApps/sdk`.
  The daemon does not depend on a checkout outside this repository.

## Proton's rules — do not break these

Proton permits personal, non-commercial use of the SDK under conditions.
Halyard complies with these conditions. Preserve compliance in every change
to avoid account rate limits or blocking.

- **`x-pm-appversion` must stay honest** — `external-drive-halyard@<v>-alpha`,
  set in `daemon/src/config.ts`. Making it look first-party is explicitly
  forbidden.
- **Event-based sync only.** The remote tree is enumerated once per pair and
  then kept current from the Drive event stream at the SDK scheduler's cadence.
  Never add a polling loop or a periodic recursive tree walk.
- **No Proton branding**, and the sign-in screen must carry the third-party
  disclosure (`ui/halyard/login_view.py`, `DISCLOSURE`). It is a requirement,
  not decoration — do not hide or shorten it.

## Sync engine invariants

`daemon/src/engine/reconcile.ts` is a pure three-way merge (local × base ×
remote) with no I/O. Keep it free of I/O. Every sync decision passes through
this function. It is the only part that can be tested exhaustively.

- **The base is durable state, not a cache.** It is the last state at which both
  sides agreed. Losing it means deletions cannot be told apart from
  never-seen-it.
- **A deletion never beats an edit.** Remote deletions are applied locally only
  when the local copy is *unchanged* — so an identical copy is recoverable from
  Proton's Trash. Unsynced local edits are re-uploaded instead. If you touch the
  decision matrix, preserve this asymmetry.

  The executor checks the file again immediately before deletion.
  `deleteLocal` reads its current metadata and defers deletion if a write
  occurred after the scan. Preserve this check to prevent a time-of-check to
  time-of-use (TOCTOU) race.
- **Handle file/folder type swaps in a separate decision branch.** If the file
  is *unchanged*, replace it outright. Its bytes remain recoverable from Trash.
  Otherwise, use the conflict rename to keep both copies.
  Do not let type swaps reach the single-sided branches.
  Those branches can loop forever or apply file operations to a folder UID.
- **Pause a pair if its local root disappears or scans empty while the base is non-empty.**
  `runOnce` (`daemon/src/engine/pair.ts`) enforces this guard. Do not reconcile
  the pair in this state. The folder could be moved, deleted or unmounted.
  Reconciliation would interpret the missing local files as deletions and trash
  their Drive copies. This mirrors the guard against an incomplete remote enumeration.

  Preserve both guards. Do not let the initial `mkdir -p` recreate a missing
  root when durable state exists. Recreating it could also put a phantom folder
  at a bare mountpoint.
- **Conflicts keep both copies.** The remote version keeps the original path.
  Rename the local version to `file (conflict YYYY-MM-DD).ext` and upload it.
- **Never re-transfer on rename.** Moves are detected by node uid (remote) and
  `(device, inode)` (local).
- **btrfs:** inode numbers are unique only per subvolume.
  Use `(device, inode)` for move detection. An inode-only key can rename the
  wrong file. `rename(2)` fails with `EXDEV` across subvolumes.
  Preserve the fallback that copies with `COPYFILE_FICLONE` and then deletes the source.

  Both cases have regression tests. The development machine uses btrfs with an
  `@`/`@home` layout, so these cases occur during normal use.
- Downloads land on a `.halyard-part` temp file and are renamed into place. That
  suffix **must** stay in the ignore list, or a scan racing a download uploads
  half-written files to Drive.
- **The activity log is disposable.** `sync_events` records completed and failed
  executor actions for the UI's Activity screen. Entries expire after 90 days
  or 20 000 rows. Never use this log to make a sync decision.
  Losing it must only remove explanations, not affect user data.

  Write the log once per cycle in one transaction.
  A separate commit for each file cost more than the sync itself.

## The daemon is a user service — never add elevation

Nothing in Halyard requires root. Do not add a root requirement.
The daemon runs as the user and stores its session in the user's keyring.
It writes only under `$HOME` and registers on the **session** bus.
The manual installer uses `~/.local` and `~/.config`.

`ui/halyard/daemon_control.py` tries these startup methods in order:

1. `systemctl --user`
2. D-Bus activation
3. A direct spawn

None of these methods prompts for a password.

Distribution packages use apt/pacman to install read-only program files under
`/usr/lib/halyard` and a user unit under `/usr/lib/systemd/user`. Only the package
manager needs administrator access. The daemon still runs as the logged-in
user. Package hooks must never start a system daemon, enable sync globally, or
alter user credentials, paired folders or sync state. The manual installer
continues to use `~/.local` and `~/.config` without elevation.

If a change here appears to need `sudo`, revise the change.
Moving the user's own files must not require root.
Proton's own clients do not require root for this either.

The systemd unit has one source of truth: `packaging/halyard-daemon.service.in`.
`ui/halyard/daemon_control.py` reads that template when a checkout provides it.
Installed UIs use a byte-identical embedded fallback.
Both sources write the same file, and the last write determines its contents.
Mirror every template change in the fallback.
An earlier inline copy silently omitted the entire hardening block.

## GNOME specifics

- **The tray is optional.** Stock GNOME has no StatusNotifier host, but
  extensions such as AppIndicator and KStatusNotifierItem Support provide
  `org.kde.StatusNotifierWatcher`. When a watcher is present, Halyard exposes a
  tray icon through `org.kde.StatusNotifierItem` and `com.canonical.dbusmenu`.
  `ui/halyard/tray.py` implements both protocols with Gio because
  AppIndicator3 is GTK3 and cannot be loaded into the GTK4 process. Watch the
  watcher at runtime so the icon appears and disappears with the extension.

  The app must remain usable without a tray. Keep status in the window.
  Use notifications for background events.
- Autostart goes through `org.freedesktop.portal.Background`, never a
  hand-written `~/.config/autostart` file.
- Notifications use `Gio.Application.send_notification`. Do not add a libnotify
  dependency. GNOME only renders them once the `.desktop` file is installed.

## Testing against a real account — read first

`daemon/scripts/live-test*.mjs` run against a **live Proton Drive account** in a
throwaway `Halyard Test` folder. They upload, download, rename and delete real
data.

- Ask the user before running anything that writes to their Drive.
- `dist/remoteop.cjs` changes Drive out of band, standing in for a second
  device. It is the only way to test remote deletions and genuine conflicts.
- `ui/tests/integration_real_daemon.py` is **read-only** and safe: it feeds live
  daemon payloads through the UI's parsers.
- `ui/tests/mock_daemon.py` owns `…Halyard.MockDaemon` and refuses the
  production bus name. Keep it that way — an earlier version claimed the real
  name with replace-flags and displaced the live daemon.

## Versioning

- `daemon/package.json` is the only application version source. The daemon and
  checkout UI read it. Installers generate the UI's `data/version.json`.
  `packaging/versioning.py` generates ignored `debian/changelog` and
  `packaging/arch/PKGBUILD` from their `.in` templates. Do not add another version
  constant or hand-edit generated metadata. Release tags must match `v<version>`.
- An SDK upgrade requires a Halyard version bump in the same change.
  For an SDK update compatible with Halyard's public behaviour, increment the
  final component, for example `0.1.1` to `0.1.2`.
  Apply this rule even if Proton labels an internal SDK change as breaking.
- Increment the middle component for a user-facing breaking change while
  Halyard is pre-1.0, for example `0.1.x` to `0.2.0`.
- Increment the leading component for a whole-product refactor or another major
  product update. Assess Halyard's exposed behaviour rather than copying the
  upstream SDK's commit label.

## Conventions

- The D-Bus boundary carries JSON strings, not typed structs. Changing a payload
  shape means updating `docs/dbus-api.md`, the daemon, the UI models, and the
  mock — all four.
- Daemon errors surface to the user verbatim, so their wording is UI text.
- UI models are frozen dataclasses. Return collections as tuples.
- Secrets never touch disk unencrypted. The session lives in the keyring.
  The metadata cache uses AES-256-GCM encryption with a key from the same keyring.
  `daemon/src/log.ts` redacts tokens centrally — do not log request bodies.
