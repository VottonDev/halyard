# Halyard user guide

[Back to the README](../README.md)

## Folder sync

Select the + button to add a folder pair. Choose a folder on this computer.
Then select or create its Proton Drive folder. Sync starts at once.

Closing the window does not stop syncing. Open Preferences and select
**Stop service**, or run `systemctl --user stop halyard-daemon`.
Halyard runs as your user. Only installation of a distribution package uses
administrator access.

Select **Conflicts** from the app menu to review files that changed in both
places, or were edited in one place and deleted in the other.

For files edited in both places, Halyard keeps both versions under different
names. Select **Use this computer’s version** to replace the file at the
original path with your preserved version.
Select **Use Proton Drive’s version** to remove the preserved local copy.
Select **Keep both** to leave both files and clear the entry.

If a file was edited in one place and deleted in the other, Halyard keeps the
edited version. Select **Keep edited file** to clear the entry. Check Activity
for any transfers that could not finish.

### Excluding folders

A pair can cover a broad folder while leaving parts of it alone. For example,
sync `~/Documents` but not the `GitHub` folder inside it. Use names or patterns
to choose what Halyard skips. Write paths relative to the folder you are syncing:

| Pattern | Matches |
|---|---|
| `GitHub` | a folder named `GitHub` at any depth, and everything under it |
| `/GitHub` | only at the top level of the pair |
| `Archive/old` | the `Archive/old` path starting from the synced folder, and anything inside it |
| `*.iso` | names ending in `.iso` at any folder level, and anything inside matching folders |
| `**/cache` | a file or folder named `cache` at any depth, and anything inside it |

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

## Sync behaviour

| Situation | What Halyard does |
|---|---|
| Same file edited in both places | Keeps both. The remote version keeps the original name. The local version gets a name such as `file (conflict 2026-07-19).ext`. |
| File deleted on one side and unchanged on the other | Applies the deletion. The remote copy remains recoverable from Proton's Trash. |
| File deleted on one side and edited on the other | Keeps the edit. The file is restored or re-uploaded. |
| File renamed or moved | Detected as a move, so nothing is re-transferred. A renamed 4 GB file costs one API call, not 4 GB. |

When the safe answer is unclear, Halyard keeps both copies.

Open **Trash** from the app menu to browse deleted files and folders, or
switch to **Photos** for deleted photos and albums. Select items and choose
**Restore** to return them to their original locations in Drive. Files in
paired folders sync normally, with conflicting local edits kept as copies.

The results show each item's outcome. Cancelling stops remaining work without
undoing completed restores. Missing parents and name collisions may require
restoring the parent first or resolving the original location on the web.
Version history remains available through Proton Drive on the web.

## Photos

Browse your Proton Drive gallery and albums, preview photos, play videos,
download originals, upload JPEG, PNG or WebP images, and move items to Trash.
Halyard opens on Folders. Photo transfers appear in Activity and are separate
from folder sync.

## Troubleshooting

Check the service log first:

```bash
journalctl --user -u halyard-daemon -f
```

Press **Ctrl+C** to stop following the log.

For source checkouts, run the doctor from the repository root.
It requires Bun and the prepared source-build dependencies.
It checks local dependencies without accessing account data or making network calls.

```bash
cd daemon
bun run doctor
```

| Symptom | Likely cause |
|---|---|
| "No usable secret service found" at startup | `gnome-keyring` is not running, or the login keyring is locked. Unlock it and restart the daemon. |
| The app sits on "connecting" | Start the daemon with `systemctl --user start halyard-daemon`. |
| A pair shows an error and stalls | Read the error for details. Halyard retries failed items on the next sync cycle. One failed file does not stop the others. |
| Notifications never appear | GNOME needs the installed `.desktop` file to show notifications. Reinstall Halyard with your package manager or `packaging/install.sh`. |
| Nothing syncs after sign-in | Check that the folder pair is switched on and syncing is not paused. |

You can safely delete `~/.cache/halyard/`. Do not delete
`~/.local/share/halyard/sync.sqlite` as routine troubleshooting. It records the
last state shared by both sides.

## Uninstall

Stop syncing in Preferences before uninstalling Halyard.

### Uninstall a distribution package

Remove the package with your package manager:

```bash
# Debian/Ubuntu
sudo apt remove halyard
# Arch Linux
sudo pacman -R halyard-bin
```

Your files, saved sync state and credentials stay in place.

### Uninstall a manual installation

```bash
systemctl --user disable --now halyard-daemon.service
rm -f ~/.config/systemd/user/halyard-daemon.service \
      ~/.local/share/dbus-1/services/io.github.votton.Halyard.Daemon.service \
      ~/.local/bin/halyard \
      ~/.local/share/applications/io.github.votton.Halyard.desktop
rm -rf ~/.local/lib/halyard ~/.local/share/doc/halyard
systemctl --user daemon-reload
```

Your synced files, saved sync state and credentials stay in place.

### Optional: delete saved data

After uninstalling, use this command only if you also want to delete Halyard's
sync state, cache and logs. Deleting sync state removes Halyard's record of
previously synced files. A later installation cannot resume from that state.

```bash
rm -rf ~/.local/share/halyard ~/.cache/halyard ~/.local/state/halyard
```

Your synced files stay in place. These paths assume the default XDG directories.
If you changed them, use the corresponding `halyard` directories there instead.

To delete the stored session, remove the keyring entry "Halyard — Proton Drive
session" in Passwords and Keys.

