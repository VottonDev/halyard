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

`AddPair` takes `{ localPath, remoteUid, remotePath, excludes? }`.

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

### Activity log

| Method | Signature | Returns |
|---|---|---|
| `ListHistory` | `(s filter) → s` | `HistoryEntry[]`, newest first |
| `ClearHistory` | `(s pairId) → ()` | empty `pairId` clears every pair |

The daemon records what it actually did to each file, so the UI can answer
"why did this disappear?" without anyone reading a log file. It is **not**
load-bearing state: entries are pruned after 90 days or 20 000 rows, whichever
comes first, and `deletePair` discards a pair's entries along with its base.

`filter` is a JSON object; every field narrows, and an omitted field means
"any". An empty string is a valid filter meaning "everything".

```jsonc
{
  "pairId": "p_7f3a",               // omit for every pair
  "actions": ["deletedLocal"],      // any of the action values below
  "outcome": "failed",              // ok|failed
  "search": "budget",               // case-insensitive substring of the path
  "beforeId": 412,                  // paging: only entries older than this id
  "limit": 100                      // clamped to 1..1000, default 200
}
```

Ids descend with time, so paging is "ask again with `beforeId` set to the id of
the oldest entry you hold". A reply shorter than `limit` means there is nothing
older to fetch.

```jsonc
// HistoryEntry
{
  "id": 412,                        // monotonic; also the paging cursor
  "pairId": "p_7f3a",
  "at": 1752940800000,
  "action": "deletedLocal",
  "path": "archive/old-notes.txt",
  "toPath": null,                   // destination, for moves only
  "type": "file",                   // file|folder
  "size": 1048576,                  // null when it does not apply
  "outcome": "ok",                  // ok|failed
  "error": null                     // the failure message when outcome is failed
}
```

`action` is finer-grained than the engine's internal actions, because the
distinctions matter to the person reading them — whether a download replaced
an existing file, and which side a deletion came from:

| Action | Means |
|---|---|
| `downloaded` | New file arrived from Drive |
| `updatedLocal` | Drive's copy changed, so the local file was overwritten |
| `uploaded` | New local file copied to Drive |
| `updatedRemote` | Local file changed, so Drive was updated |
| `deletedLocal` | Removed locally because it was removed on Drive |
| `trashedRemote` | Moved to Drive's Trash because it was deleted locally |
| `movedLocal` / `movedRemote` | Moved or renamed to match the other side |
| `createdLocalFolder` / `createdRemoteFolder` | Folder created to match |

There is no activity signal. The log is only read while its screen is open, and
pushing an event per file would flood the bus during a large sync.

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
