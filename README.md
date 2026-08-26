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

## How sync behaves

| Situation | What Halyard does |
|---|---|
| Same file edited in both places | Keeps both. The remote version keeps the original name. The local version gets a name such as `file (conflict 2026-07-19).ext`. |
| File deleted on one side and unchanged on the other | Applies the deletion. The remote copy remains recoverable from Proton's Trash. |
| File deleted on one side and edited on the other | Keeps the edit. The file is restored or re-uploaded. |
| File renamed or moved | Detected as a move, so nothing is re-transferred. A renamed 4 GB file costs one API call, not 4 GB. |

When the safe answer is unclear, Halyard keeps both copies.

## Requirements

- GNOME on Wayland or X11, with a Secret Service provider such as `gnome-keyring`
- Node 22+
- Bun, which applies the required patch for `@protontech/crypto`
- Python 3 with PyGObject, GTK 4 and libadwaita 1

## Install

```bash
git clone --recurse-submodules https://github.com/VottonDev/halyard
cd halyard
./packaging/install.sh    # fetches + builds the pinned Proton SDK, then the daemon
systemctl --user enable --now halyard-daemon.service
halyard
```

Sign-in happens through Proton in your browser, so Halyard never sees your
password. It stores the resulting session in your keyring and encrypts its local
metadata cache.

## Using it

Add a pair with the + button. Choose a local folder, then select or create its
Drive folder. Sync starts at once.

Closing the window does not stop syncing. Choose Quit from the app menu or run
`systemctl --user stop halyard-daemon` to stop the service. Halyard runs entirely
as your user and never needs `sudo`.

Conflicts appear in their own view. Both copies already exist on disk by the
time you see one. Keep local restores your copy to the original name. Keep
remote discards the preserved copy. Dismiss leaves both files and clears the
entry.

### Excluding folders

A pair can cover a broad folder while leaving parts of it alone. For example,
sync `~/Documents` but not the `GitHub` checkout inside it. Patterns are
gitignore-style and relative to the pair root:

| Pattern | Matches |
|---|---|
| `GitHub` | a folder named `GitHub` at any depth, and everything under it |
| `/GitHub` | only at the top level of the pair |
| `Archive/old` | an anchored path (any interior slash anchors) |
| `*.iso` | a glob within one path segment |
| `**/cache` | an explicit any-depth match |

Excluding a path never deletes it. Existing content stays in place locally and
on Drive but is no longer tracked. Removing an exclusion later merges both
sides again. Negation patterns such as `!pattern` are not supported.

> `node_modules` is not excluded by default. A single
> JavaScript project can hold hundreds of megabytes across tens of thousands of
> reinstallable files, so exclude it explicitly if you sync code.

### What is not synced

Halyard skips `.git`, `.DS_Store`, `lost+found`, common temporary files, its own
partial downloads, and symlinks. Everything else syncs, including dotfiles.
Use `git` rather than Halyard to sync repositories.

## Development

```bash
git submodule update --init
./scripts/build-proton-sdk.sh
cd daemon
bun install
bun run test
node scripts/build.mjs
./node_modules/.bin/tsc --noEmit
```

The daemon runs from `dist/`, so rebuild it after changing `daemon/src/`. For UI
work, run the mock daemon and app together:

```bash
cd ui
./run-dev.sh
```

Do not run `daemon/scripts/live-test*.mjs` without checking first. Those scripts
write to the connected Proton Drive account.

## Troubleshooting

Run the doctor first. It checks local dependencies without touching account
data.

```bash
cd daemon && bun run doctor
```

Then check the service log:

```bash
journalctl --user -u halyard-daemon -f
```

| Symptom | Likely cause |
|---|---|
| "No usable secret service found" at startup | `gnome-keyring` is not running, or the login keyring is locked. Unlock it and restart the daemon. |
| The app sits on "connecting" | Start the daemon with `systemctl --user start halyard-daemon`. |
| A pair shows an error and stalls | The message is verbatim from the daemon. Failed items are retried on the next cycle; sync does not stop for one bad file. |
| Notifications never appear | GNOME only shows them once the `.desktop` file is installed in `XDG_DATA_DIRS`, which `install.sh` does. |
| Nothing syncs after sign-in | Check the pair is enabled and not globally paused (`GetStatus` shows both). |

You can safely delete `~/.cache/halyard/`. Do not delete
`~/.local/share/halyard/sync.sqlite` as routine troubleshooting. It records the
last state shared by both sides.

## Uninstall

```bash
systemctl --user disable --now halyard-daemon.service
rm -f ~/.config/systemd/user/halyard-daemon.service \
      ~/.local/share/dbus-1/services/io.github.votton.Halyard.Daemon.service \
      ~/.local/bin/halyard \
      ~/.local/share/applications/io.github.votton.Halyard.desktop
rm -rf ~/.local/lib/halyard                 # the program
systemctl --user daemon-reload

# Optional: remove sync state, cache, and logs
rm -rf ~/.local/share/halyard ~/.cache/halyard ~/.local/state/halyard
```

Your synced files are left alone. Remove the keyring entry "Halyard — Proton
Drive session" in Passwords and Keys to drop the stored session.

## Limitations

- Linux and GNOME only
- One account
- No resumable transfers; interrupted uploads restart
- Symlinks are skipped
- Shared-with-me folders are untested

## Verification status

This is alpha software. Uploads, downloads, moves, deletions, conflicts, and
session restore have been tested against a real account. Very large pairs,
multi-day use, and transfer recovery after a network failure have not. Keep a
backup and start with non-critical files.

## Licence

MIT. Use of Proton's hosted services remains subject to Proton's own terms.
