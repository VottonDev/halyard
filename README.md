# Halyard

Two-way folder sync for Proton Drive on GNOME.

> **This is a third-party application not officially supported by Proton.**
> It is not affiliated with, endorsed by, or produced by Proton AG. It is built
> on Proton's open-source Drive SDK, but Proton provides no support for it.

Pick a local folder, pick a Drive folder, and Halyard keeps them in step in both
directions. Add as many pairs as you like; folders you have not paired are never
touched.

```
~/Documents/Work   ↔  /Work
~/Pictures/2026    ↔  /Photos/2026
~/notes            ↔  /Notes
```

## Design

The guiding rule is **never lose data**. Sync tools fail in one of two
directions, and only one of them is recoverable:

| Situation | What Halyard does |
|---|---|
| Same file edited in both places | Keeps **both**. The remote version takes the original name; your local version is renamed `file (conflict 2026-07-19).ext` and uploaded alongside it. |
| File deleted in Drive, unchanged locally | Deleted locally too. Safe because Proton Drive keeps its own Trash, and an unchanged local copy is byte-for-byte what is sitting in it. |
| File deleted locally, edited in Drive | The edit wins — the file comes back. |
| File edited locally, deleted in Drive | The edit wins — the file is re-uploaded. Local work is never destroyed by a remote deletion. |
| File renamed or moved | Detected as a move, so nothing is re-transferred. A renamed 4 GB file costs one API call, not 4 GB. |
| Same content on both sides, different timestamps | Records agreement and transfers nothing. |

Resurrecting a file you deleted is an annoyance. Destroying a file you edited is
not, so every ambiguous case resolves toward keeping data.

Note the asymmetry in the two deletion rows. Halyard will delete a local file
when Drive says it is gone — but only when that file is *unchanged*, meaning an
identical copy is recoverable from Proton's Trash. The moment there are local
edits Drive has never seen, deletion stops being reversible and the edit wins
instead.

Sync is a three-way merge between the local filesystem, the remote tree, and a
recorded *base* — the last state at which the two agreed. Without that base you
cannot tell "you created this file" from "the other side deleted it", which is
how naive sync tools eat data.

## Architecture

```
  halyard (Python, GTK4 + libadwaita)
        ↕  session D-Bus  ·  io.github.votton.Halyard.Daemon
  halyard-daemon (Node)  →  @protontech/drive-sdk  →  Proton Drive
```

Two processes, because the two halves have incompatible requirements. The Drive
SDK is TypeScript and its crypto package ships as raw ESM TypeScript, so the
sync engine has to run on Node. A GNOME app should be GTK, not a browser in a
trenchcoat. So the daemon owns everything Proton-related and the UI is a thin
client over [a documented D-Bus interface](docs/dbus-api.md).

The daemon runs without the UI. Closing the window does not stop sync.

Deliberately **no native modules**: SQLite comes from Node's built-in
`node:sqlite`, and D-Bus is spoken over a pure-JS implementation. There is
nothing to compile and nothing to rebuild per Node release.

### Btrfs

Halyard is built with btrfs in mind, because two of its properties break
assumptions that sync tools normally make:

- **Inode numbers are only unique per subvolume.** Two unrelated files under one
  synced folder can share an inode number if they live in different subvolumes.
  Move detection therefore keys on `(device, inode)`, not the inode alone —
  keying on the inode would rename the wrong file on Drive and delete the other.
  There is a regression test for exactly this.
- **`rename(2)` fails with `EXDEV` across subvolume boundaries**, even within one
  filesystem, and subvolumes look like ordinary directories. Every move falls
  back to copy-then-delete when that happens, requesting `COPYFILE_FICLONE` so
  the copy becomes a reflink — instant and free of extra space on btrfs, and a
  normal copy anywhere else.

Snapshots pair well with this: since remote deletions are applied locally, a
periodic `btrfs subvolume snapshot` of a synced folder gives you a second,
local recovery path independent of Proton's Trash.

### Layout

| Path | |
|---|---|
| `daemon/src/drive/` | Session, auth, HTTP, caches — everything the SDK needs supplied |
| `daemon/src/engine/reconcile.ts` | The three-way merge. Pure, no I/O, heavily tested |
| `daemon/src/engine/execute.ts` | Turns a plan into uploads, downloads and moves |
| `daemon/src/engine/remote.ts` | Mirrors the Drive tree from the event stream |
| `daemon/src/ipc/dbus.ts` | The D-Bus surface |
| `ui/` | GTK4 + libadwaita front end |
| `docs/dbus-api.md` | The contract between them |

## Requirements

- GNOME (Wayland or X11), with a Secret Service provider — normally
  `gnome-keyring`, which you already have
- **Node 22+** — the daemon uses the built-in `node:sqlite`
- **Bun** — required to install, because `@protontech/crypto` needs a patch and
  bun is what applies it
- Python 3 with PyGObject, GTK 4 and libadwaita 1

A checkout of [proton-sdk](https://github.com/protonprivacy/proton-sdk-preview)
must sit **next to** this repository, since the daemon depends on it by relative
path:

```
GitHub/
├── proton-sdk/     # Proton's SDK, built with `cd client/js && bun install && bun run build`
└── halyard/
```

## Install

```bash
cd halyard
./packaging/install.sh
systemctl --user enable --now halyard-daemon.service
halyard
```

Sign-in happens in your browser: Halyard opens Proton's sign-in page, you
authenticate there, and it receives a session back. **Halyard never sees your
password**, and 2FA and SSO work because Proton handles them, not us.

The session is stored in your GNOME keyring. The metadata cache is encrypted at
rest with AES-256-GCM under a key kept in the same keyring — file names and
folder structure are exactly what Proton's encryption protects, so leaving them
in a plaintext database would quietly undo that.

## Using it

Add a pair with **+**: choose a local folder, then browse your Drive for the
remote one (or create it). Sync starts immediately and runs from then on —
local changes are picked up by a filesystem watcher, remote changes arrive over
Proton's event stream.

Closing the window does **not** stop syncing. The daemon is the app; the window
is a view onto it. Quit it properly with `systemctl --user stop
halyard-daemon`, or **Quit** in the app menu.

Conflicts appear in their own view. Both copies already exist on disk by the
time you see one, so resolving is just tidying up: **Keep local** promotes your
copy back to the original name, **Keep remote** discards the preserved copy, and
**Dismiss** leaves both files and clears the entry.

### What is not synced

Some names are always skipped, in both directions:

| Skipped | Why |
|---|---|
| `.git` | Syncing a live repository corrupts it — two machines writing the index and packfiles will destroy history. Use `git` to sync code. |
| `.DS_Store`, `lost+found` | Noise. |
| `*~`, `*.swp`, `*.tmp`, `*.part`, `*.partial`, `*.crdownload`, `.~lock.*`, `.goutputstream-*` | Editor and browser scratch files that exist for seconds. |
| `*.halyard-part` | Halyard's own in-progress downloads. |
| Symlinks | Following them invites cycles and would pull files from outside the pair into Drive. |

Everything else syncs, including dotfiles. The list lives in
`daemon/src/config.ts` if you want to change it.

## Development

```bash
cd daemon
bun install
bun test                    # reconciler decision matrix
node scripts/build.mjs      # → dist/halyard-daemon.cjs
./node_modules/.bin/tsc --noEmit

HALYARD_LOG_LEVEL=debug HALYARD_LOG_STDERR=1 node dist/halyard-daemon.cjs
```

Live tests run against a real account, in a throwaway `Halyard Test` folder.
They touch nothing else:

```bash
node scripts/live-test.mjs            # upload, rename, download round-trip, delete
node scripts/live-test-conflicts.mjs  # remote deletion + genuine both-sides conflict
```

For the UI, `ui/run-dev.sh` starts a mock daemon (on its own bus name, so it can
never displace the real one) alongside the app:

```bash
cd ui
./run-dev.sh                 # or --logged-in / --login-fails / --no-pairs / --offline
python3 -m halyard           # against the real daemon
```

The mock proves the UI *renders*; it cannot prove the UI understands what the
Node daemon actually emits. That gap is covered separately, by feeding live
daemon responses through the UI's own model parsers:

```bash
python3 ui/tests/integration_real_daemon.py   # read-only, safe on a real account
```

`live-test-conflicts.mjs` needs a way to change Drive from outside the daemon,
which is what `dist/remoteop.cjs` is for — it stands in for a second device:

```bash
node dist/remoteop.cjs ls     "Halyard Test"
node dist/remoteop.cjs trash  "Halyard Test" file.txt
node dist/remoteop.cjs putrev "Halyard Test" file.txt ./new-contents
```

| Variable | |
|---|---|
| `HALYARD_LOG_LEVEL` | `debug`, `info`, `warn`, `error` |
| `HALYARD_LOG_STDERR` | `1` to mirror all logs to stderr |
| `HALYARD_DRIVE_BASE_URL` | Point at a test environment; the account host follows |
| `HALYARD_UNSAFE_SECRETS` | `1` stores the session in plaintext. Testing only. |
| `HALYARD_BUS_NAME` | Point the UI at a different daemon (used by the mock). |

## Troubleshooting

If something is wrong with the environment rather than the sync, start here — it
checks SQLite, OpenPGP, the session bus and the keyring, and touches no account
data:

```bash
cd daemon && bun run doctor
```

Otherwise, logs are the first stop:

```bash
journalctl --user -u halyard-daemon -f
tail -f ~/.local/state/halyard/halyard.log
```

The daemon can be inspected directly, without the UI:

```bash
gdbus call --session --dest io.github.votton.Halyard.Daemon \
  --object-path /io/github/votton/Halyard/Daemon \
  --method io.github.votton.Halyard.Daemon.GetStatus
```

| Symptom | Likely cause |
|---|---|
| "No usable secret service found" at startup | `gnome-keyring` is not running, or the login keyring is locked. Unlock it and restart the daemon. |
| The app sits on "connecting" | The daemon failed to start. Check `journalctl --user -u halyard-daemon` — a missing or unbuilt `../proton-sdk` is the usual reason. |
| A pair shows an error and stalls | The message is verbatim from the daemon. Failed items are retried on the next cycle; sync does not stop for one bad file. |
| Notifications never appear | GNOME only shows them once the `.desktop` file is installed in `XDG_DATA_DIRS`, which `install.sh` does. |
| Nothing syncs after sign-in | Check the pair is enabled and not globally paused (`GetStatus` shows both). |

State lives in three places: the session in the keyring, sync state in
`~/.local/share/halyard/sync.sqlite`, and a metadata cache in
`~/.cache/halyard/`. The cache can be deleted safely — it is rebuilt. Deleting
`sync.sqlite` forces a full re-scan and re-hash of every pair, which is slow but
not destructive.

## Uninstall

```bash
systemctl --user disable --now halyard-daemon.service
rm -f ~/.config/systemd/user/halyard-daemon.service \
      ~/.local/share/dbus-1/services/io.github.votton.Halyard.Daemon.service \
      ~/.local/bin/halyard \
      ~/.local/share/applications/io.github.votton.Halyard.desktop
rm -rf ~/.local/lib/halyard                 # the program
systemctl --user daemon-reload

# Optional — your sync state, cache and logs:
rm -rf ~/.local/share/halyard ~/.cache/halyard ~/.local/state/halyard
```

Your synced files are left alone. Remove the keyring entry ("Halyard — Proton
Drive session") in **Passwords and Keys** to drop the stored session.

## Complying with Proton's third-party rules

Proton allows personal, non-commercial use of the Drive SDK under
[conditions](https://github.com/protonprivacy/proton-sdk-preview#usage-guidelines-for-personal-projects).
Halyard is built to meet them, and changes should keep meeting them:

- **Honest identification.** Every request sends
  `x-pm-appversion: external-drive-halyard@<version>-alpha`. Do not change this
  to imitate a first-party client — that is explicitly forbidden and gets
  applications blocked.
- **Event-based sync.** The remote tree is enumerated once per pair and kept
  current from the Drive event stream, at the cadence the SDK's scheduler
  dictates. Halyard does not poll and does not repeatedly walk the tree. Adding
  a "check every 30 seconds" loop would get the account rate-limited.
- **No Proton branding.** No Proton logos, trademarks, or visual identity.
- **Disclosure.** The sign-in screen states that this is a third-party
  application not officially supported by Proton.
- **Official endpoints only**, through the SDK rather than raw API calls.

## Limitations

Known and deliberate:

- **Linux/GNOME only.** The sync engine is portable Node, but the UI is GTK.
- **No resumable transfers.** The SDK does not expose resumption, so an
  interrupted large upload restarts. A stable per-installation client id means
  the abandoned draft is cleaned up automatically rather than needing your
  intervention.
- **Symlinks are skipped**, not followed — following them invites cycles and
  would pull files from outside the pair into Drive.
- **Local moves are detected by `(device, inode)`.** A move plus an edit before
  the next scan is seen as a delete and a create, so the file is re-uploaded.
  Correct, just not optimal.
- **One account.** No multi-account support.
- **Shared-with-me folders are untested.** Pairs are intended for folders you
  own.

## Verification status

This is alpha software that moves your files around, so it is worth being
precise about what has actually been exercised rather than merely written.

Verified against a real Proton Drive account:

- Upload, download, and byte-identical round-trip including a 5 MB multi-block
  file and nested folders
- Rename and move detection, confirmed to transfer nothing
- Local deletion propagating to Drive, and remote deletion propagating locally
- A genuine both-sides conflict keeping both copies, with the preserved copy
  reaching Drive
- A remote deletion racing an unsynced local edit, where the edit survives and
  is restored to Drive
- Session persistence and correct no-op resume across daemon restarts
- The UI's parsers against live daemon payloads

Covered by unit tests only: the full reconciler decision matrix, the btrfs
inode-collision case, and the ignore rules.

**Not verified:**

- The local folder picker widget (`Gtk.FileDialog` opens a portal surface that
  could not be automated; its validation logic *is* tested)
- Autostart via the Background portal — written to spec, never run live
- Notification rendering end-to-end
- Very large pairs. Nothing has been run against tens of thousands of files, so
  scan and hash timings at that scale are unknown.
- Sustained multi-day operation, and recovery from a network drop mid-transfer

Take a backup, or start with a folder you can afford to lose, until you have
your own confidence in it.

## Licence

MIT. Use of Proton's hosted services remains subject to Proton's own terms.
