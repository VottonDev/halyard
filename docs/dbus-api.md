# Halyard D-Bus API

The contract between the Node sync daemon and the GTK user interface.

| | |
|---|---|
| Application ID | `io.github.votton.Halyard` |
| Bus name | `io.github.votton.Halyard.Daemon` |
| Object path | `/io/github/votton/Halyard/Daemon` |
| Interface | `io.github.votton.Halyard.Daemon` |
| Bus | session |

The UI honours `HALYARD_BUS_NAME` to target a different bus name for
development; it defaults to the value above. `ui/tests/mock_daemon.py` uses
`io.github.votton.Halyard.MockDaemon` and refuses to claim the production name.

The daemon is D-Bus activatable, so the UI never needs to spawn it: calling any
method starts it if it is not already running. It keeps running after the UI
window closes, which is the point — sync is a background service.

## Conventions

Every structured payload crosses the bus as a **JSON string** (signature `s`)
rather than as a typed D-Bus struct. Sync state is a nested, evolving shape;
marshalling it as `a{sv}` would make both sides brittle for no real benefit.
Scalars stay native types.

Times are epoch milliseconds (`number`). Sizes are bytes. `null` is used for
absent values, never an empty string.

Any method may fail with `io.github.votton.Halyard.Error.Failed` and a
human-readable message; the UI shows it verbatim.

## Methods

### Account

| Method | Signature | Returns |
|---|---|---|
| `GetAccount` | `() → s` | `Account` |
| `BeginLogin` | `() → s` | `{ "signInUrl": string }` |
| `CancelLogin` | `() → ()` | |
| `Logout` | `() → ()` | |

`BeginLogin` initiates Proton's web sign-in fork and returns a URL the UI must
open in the user's browser. The daemon then polls for completion and emits
`LoginStateChanged`. Sign-in happens entirely in the browser — the app never
sees the password, and 2FA/SSO are handled by Proton.

```jsonc
// Account — signed in
{ "loggedIn": true, "email": "you@proton.me", "displayName": "You" }

// Account — signed out. The fields are always present, never omitted.
{ "loggedIn": false, "email": null, "displayName": null }
```

### Folder pairs

| Method | Signature | Returns |
|---|---|---|
| `ListPairs` | `() → s` | `Pair[]` |
| `AddPair` | `(s newPair) → s` | the created `Pair` |
| `UpdatePair` | `(s id, s patch) → s` | the updated `Pair` |
| `RemovePair` | `(s id, b deleteLocalState) → ()` | |
| `SyncNow` | `(s id) → ()` | empty `id` means every pair |
| `SetPaused` | `(b paused) → ()` | global pause |

`AddPair` takes `{ localPath, remoteUid, remotePath, excludes? }`. When the
local folder has no counterpart on Drive yet, pass `createRemote: true` (with an
optional `remoteName`) in place of a `remoteUid`: the daemon creates a folder at
the top level of My Files — named `remoteName`, or the local folder's own name
when that is omitted — and pairs against it, filling in `remoteUid` and
`remotePath` from the folder it made. Exactly one of `remoteUid` or
`createRemote` must be supplied; `remotePath` is ignored when `createRemote` is
set.

`UpdatePair` accepts any subset of `{ enabled, localPath, remoteUid, remotePath, excludes }`;
every other key is ignored, and a patch containing no supported key is an error
rather than a silent no-op. Changing `localPath` or `remoteUid` re-points the
pair, which discards its recorded sync state — the next sync then treats both
sides as new and merges them, so nothing is deleted and differing files become
conflicts with both copies kept.

### Exclusions

`excludes` is a list of gitignore-style patterns, relative to the pair root,
letting a pair cover a broad folder while leaving parts of it alone — sync
`~/Documents` but not the `GitHub` checkout inside it.

| Pattern | Matches |
|---|---|
| `GitHub` | a segment named `GitHub` at any depth, and everything under it |
| `/GitHub` | only at the top level of the pair |
| `Archive/old` | anchored path (any interior slash anchors) |
| `*.iso` | glob within one path segment |
| `**/cache` | explicit any-depth match |
| `build/` | trailing slash accepted and ignored |
| `# note` | comment, ignored |

Negation (`!pattern`) is **not** supported and is rejected rather than ignored:
re-including part of an excluded tree makes exclusion order-dependent, and an
exclusion the user believes is active but is not could push private files to
Drive. An invalid pattern fails the whole call with a message naming it, so the
UI can show it against the offending row.

Sending `excludes` as an empty list clears every exclusion; omitting the key
leaves them unchanged.

Excluding a folder never deletes anything, on either side. Content already
synced simply stops being tracked and is left where it is, locally and on
Drive. Un-excluding later merges the two sides afresh, which can raise
conflicts (both copies kept) but never deletions.

Removing a pair never touches the user's files; `deleteLocalState` only discards
Halyard's own sync database for that pair. Removing with `deleteLocalState`
false and later re-adding the same two folders resumes from the retained state
instead of re-hashing and re-transferring everything.

```jsonc
// Pair
{
  "id": "p_7f3a",
  "localPath": "/home/you/Documents/Work",
  "remotePath": "/Work",              // display path
  "remoteUid": "volumeId~nodeId",
  "enabled": true,
  "excludes": ["GitHub", "*.iso"],    // gitignore-style, relative to the pair
  "status": "idle",                   // setup|scanning|syncing|idle|paused|error
  "lastSyncAt": 1752940800000,
  "error": null,
  "stats": {
    "pending": 0, "conflicts": 0,
    "filesUp": 12, "filesDown": 3,
    "bytesUp": 4194304, "bytesDown": 91234
  }
}
```

### Browsing the remote drive

| Method | Signature | Returns |
|---|---|---|
| `ListRemoteFolders` | `(s parentUid) → s` | `RemoteFolder[]` |
| `CreateRemoteFolder` | `(s parentUid, s name) → s` | the created `RemoteFolder` |

An empty `parentUid` lists the root of My Files. Folders only — the picker has
no use for files.

```jsonc
// RemoteFolder
{ "uid": "volumeId~nodeId", "name": "Work", "path": "/Work", "hasChildren": true }
```

### Status and conflicts

| Method | Signature | Returns |
|---|---|---|
| `GetStatus` | `() → s` | `Status` |
| `ListConflicts` | `(s pairId) → s` | `Conflict[]` |
| `ResolveConflict` | `(s conflictId, s resolution) → ()` | |
| `GetVersion` | `() → s` | version string, **not** JSON |
| `Quit` | `() → ()` | stops the daemon |

An empty `pairId` on `ListConflicts` means every pair, matching `SyncNow`.

There is no dedicated conflict-change signal. `StatusChanged` carries
`stats.conflicts` per pair, so the UI can refetch when that count moves.

`resolution` is one of `keepLocal`, `keepRemote`, or `dismiss`. Conflicts are
already resolved safely by default (both copies kept on disk); resolving one
just tidies up and clears it from the list.

```jsonc
// Status
{
  "version": "0.1.0",
  "loggedIn": true,
  "email": "you@proton.me",
  "paused": false,
  "online": true,
  // Single object, not a list: the daemon syncs pairs sequentially so that
  // several pairs cannot compete for one API session and rate limit. Only one
  // transfer is ever in flight.
  "activity": {                       // null when idle
    "pairId": "p_7f3a",
    "kind": "upload",                 // upload|download
    "path": "notes/todo.md",
    "bytesDone": 524288,
    "bytesTotal": 1048576
  },
  "pairs": [ /* Pair[] */ ]
}

// Conflict
{
  "id": "c_19ab",
  "pairId": "p_7f3a",
  "path": "notes/todo.md",
  "kind": "bothModified",             // bothModified|localDeletedRemoteModified|remoteDeletedLocalModified
  "detectedAt": 1752940800000,
  "keptCopyPath": "notes/todo (conflict 2026-07-19).md",
  "localModifiedAt": 1752940000000,
  "remoteModifiedAt": 1752940700000
}
```

## Signals

| Signal | Signature | Meaning |
|---|---|---|
| `StatusChanged` | `(s status)` | Full `Status`. Throttled to ~4/second while transferring. |
| `LoginStateChanged` | `(s state)` | `{ "state": "pending"\|"success"\|"failed"\|"cancelled", "error": string\|null }` |
| `Notify` | `(s notification)` | `{ "kind": "info"\|"warning"\|"error", "title": string, "body": string }` |

`StatusChanged` carries the whole status rather than a delta, so the UI can be a
pure function of the last signal it received and never has to reconcile
incremental updates. It is throttled because transfer progress would otherwise
saturate the bus.

The UI surfaces `Notify` as a desktop notification via
`Gio.Application.send_notification` (no libnotify dependency). GNOME has no
system tray, so notifications and the app window are the only places status is
visible. Note that GNOME only renders these once the app's `.desktop` file is
installed in `XDG_DATA_DIRS`.
