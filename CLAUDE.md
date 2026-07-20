# CLAUDE.md

Working notes for Halyard — an unofficial two-way Proton Drive sync client for
GNOME. Read this before changing anything; several constraints here are not
discoverable from the code alone.

## Layout

Two processes, one contract.

```
daemon/   Node sync engine. Owns the Proton SDK, auth, and all Drive access.
ui/       Python GTK4 + libadwaita front end. Thin client, no Proton code.
docs/dbus-api.md   The contract between them. Treat as an interface, not a note.
packaging/         D-Bus activation, systemd user unit, installer.
```

The split exists because the Drive SDK is TypeScript (its crypto package ships
raw ESM `.ts`), so the engine must run on Node — while a GNOME app should be
GTK, not a browser. Do not try to merge them.

## Commands

```bash
cd daemon
bun install                    # bun, not npm — see below
node scripts/build.mjs         # → dist/halyard-daemon.cjs (this is what runs)
bun run test                   # both suites (see below)
bun test                       # pure logic only: reconciler, ignore, exclude
bun run test:node              # anything touching node:sqlite
./node_modules/.bin/tsc --noEmit
HALYARD_LOG_LEVEL=debug HALYARD_LOG_STDERR=1 node dist/halyard-daemon.cjs

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
  config. The SDK packages arrive via `file:` deps, so they are symlinks;
  without it, resolution happens from the SDK's real path in `../proton-sdk`
  where our `node_modules` does not exist, and every import fails.
- **`import.meta.url` needs the banner** in `scripts/build.mjs`. openpgp calls
  `createRequire(import.meta.url)` internally, which is `undefined` once bundled
  to CJS.
- **`x11` is aliased to a stub.** `dbus-next` optionally requires it in an
  unreachable X11 fallback; the stub exports `null`, which is what dbus-next
  itself checks for.
- **Tests are split across two runners, and that is not optional.** Bun does
  not implement `node:sqlite`, so anything touching `SyncDatabase` cannot run
  under `bun test` — those files are named `*.nodetest.ts` (so Bun's `*.test.ts`
  glob skips them) and run under Node via `bun run test:node`. Node in turn
  cannot resolve the `.js` specifiers the `src/` tree uses, so that script
  loads `test/support/register.mjs`, which rewrites them to `.ts`. Pure logic
  stays in `*.test.ts` under Bun.
- The `proton-sdk` submodule (pinned at tag `js/v0.19.2`) lives at the repo root
  — `../proton-sdk` from `daemon/` — and `client/js` must be built (`bun install
  && bun run build`) before this will compile. `git submodule update --init`
  fetches it; `packaging/install.sh` runs both the fetch and the build. It is a
  submodule of `github.com/ProtonDriveApps/sdk`, not a sibling checkout — the
  daemon no longer depends on anything outside this repo.

## Proton's rules — do not break these

Proton permits personal, non-commercial use of the SDK under conditions. Halyard
complies; changes must keep complying, or the account gets rate-limited or
blocked.

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
remote) with no I/O. Keep it that way — it is the only part that is exhaustively
testable, and every sync decision goes through it.

- **The base is durable state, not a cache.** It is the last state at which both
  sides agreed. Losing it means deletions cannot be told apart from
  never-seen-it.
- **A deletion never beats an edit.** Remote deletions are applied locally only
  when the local copy is *unchanged* — so an identical copy is recoverable from
  Proton's Trash. Unsynced local edits are re-uploaded instead. If you touch the
  decision matrix, preserve this asymmetry.
- **A vanished or empty local root pauses the pair; it never reconciles.**
  `runOnce` (`daemon/src/engine/pair.ts`) refuses to sync when the local folder
  is missing, or exists but scans empty, while the base is non-empty — that
  means the folder was moved, deleted, or unmounted out from under us, and
  reconciling would read the whole tree as deleted and trash the Drive copies.
  This mirrors the half-enumerated-remote guard. Do not remove it, and do not
  let the `mkdir -p` at the top recreate a missing root when there is state to
  lose (it would also mask a bare mountpoint with a phantom folder).
- **Conflicts keep both copies.** Remote takes the canonical path; the local
  version is renamed `file (conflict YYYY-MM-DD).ext` and uploaded.
- **Never re-transfer on rename.** Moves are detected by node uid (remote) and
  `(device, inode)` (local).
- **btrfs:** inode numbers are unique only per subvolume, so move detection must
  key on `(device, inode)` — inode alone renames the wrong file. And `rename(2)`
  fails with `EXDEV` across subvolumes, so moves fall back to copy+delete with
  `COPYFILE_FICLONE`. Both have regression tests; the dev machine is btrfs with
  an `@`/`@home` layout, so these paths are live, not theoretical.
- Downloads land on a `.halyard-part` temp file and are renamed into place. That
  suffix **must** stay in the ignore list, or a scan racing a download uploads
  half-written files to Drive.
- **The activity log is the opposite of the base: disposable.** `sync_events`
  records what the executor actually did, for the UI's Activity screen, and is
  pruned at 90 days / 20 000 rows. Nothing may ever read it back to make a sync
  decision — losing it costs the user an explanation, not their data. It is
  written once per cycle in one transaction, because a commit per file cost
  more than the sync itself.

## The daemon is a user service — never add elevation

Nothing in Halyard requires root, and nothing should start doing so. The daemon
runs as the user, stores its session in the user's keyring, writes only under
`$HOME`, registers on the **session** bus, and installs to `~/.local` and
`~/.config`. `ui/halyard/daemon_control.py` starts and enables it through
`systemctl --user`, D-Bus activation, or a direct spawn — in that order, and
none of them prompt for a password.

If a change here appears to need `sudo`, the change is wrong. A sync tool that
asks for root to move the user's own files is teaching them a bad habit, and
Proton's own clients do not do it either.

## GNOME specifics

- **There is no system tray.** GNOME dropped StatusNotifier. Do not add a tray
  icon; use notifications and the Background portal.
- Autostart goes through `org.freedesktop.portal.Background`, never a
  hand-written `~/.config/autostart` file.
- Notifications use `Gio.Application.send_notification`; no libnotify
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

## Conventions

- The D-Bus boundary carries JSON strings, not typed structs. Changing a payload
  shape means updating `docs/dbus-api.md`, the daemon, the UI models, and the
  mock — all four.
- Daemon errors surface to the user verbatim, so their wording is UI text.
- UI models are frozen dataclasses; collections come back as tuples.
- Secrets never touch disk unencrypted. The session lives in the keyring; the
  metadata cache is AES-256-GCM encrypted under a key from the same keyring.
  `daemon/src/log.ts` redacts tokens centrally — do not log request bodies.
