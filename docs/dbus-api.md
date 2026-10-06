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

### Trash recovery

| Method | Signature | Returns |
|---|---|---|
| `ListTrash` | `(s query) → s` | `TrashPage` |
| `CancelTrashListing` | `(s requestId) → ()` | |
| `StartTrashRestore` | `(s request) → s` | `TrashRestore` |
| `ListTrashRestores` | `() → s` | `TrashRestore[]`, newest first |
| `CancelTrashRestore` | `(s id) → ()` | |

```typescript
type TrashSource = 'drive' | 'photos';
type TrashQuery = { source: TrashSource; requestId: string; cursor?: string };
type TrashItem = {
  uid: string; source: TrashSource; name: string; type: string;
  size: number | null; trashedAt: number | null; error: string | null;
};
type TrashPage = { items: TrashItem[]; nextCursor: string | null };
type TrashRestoreRequest = { source: TrashSource; uids: string[] };
type TrashRestoreResult = TrashItem & {
  status: 'pending' | 'restored' | 'alreadyRestored' | 'failed' | 'unknown' | 'cancelled';
};
type TrashRestore = {
  id: string; source: TrashSource; createdAt: number;
  status: 'running' | 'completed' | 'cancelled';
  results: TrashRestoreResult[]; refreshError: string | null;
};
```

Trash is account-scoped and fetched only on demand, through the public SDK's
`iterateTrashedNodes`. Files/folders and Photos have separate listings and
clients. The Photos source also supports albums and folders where returned by
the public Photos SDK. A missing Photos volume gives an empty listing without
creating one. Items are in SDK order, at most 50 per page; sizes are client
claims and can be absent. Undecryptable names/unsupported types are visible
with an error and cannot be selected for restore.

Use a fresh `requestId` (1–80 ASCII letters, digits, underscores or hyphens)
when refreshing, then pass the returned `nextCursor` with that same ID to load
more. Cursors expire after five minutes idle and after a restore that may have
changed Trash. At most eight listings are retained. `CancelTrashListing`
aborts network work and releases the cursor. The UI also cancels on source
changes, navigation away and window destruction. Superseded replies are
discarded. Listings and up to 20,000 recently listed identities are in memory,
with no new plaintext metadata persistence.

`StartTrashRestore` requires 1–100 recently listed item UIDs from one source;
duplicates are removed. It returns promptly while one restore job runs in the
background. The daemon refreshes/revalidates nodes before mutation, restores
selected parents before their children, and includes related photo assets
(up to 1,000 total items). Already-live items are reported `alreadyRestored`.
A trashed/missing parent produces a per-item failure: restore the parent
first, or use the web app if the original location is unavailable. The SDK's
`restoreNodes` restores to original locations; Halyard does not rename, move,
overwrite, or offer another destination to bypass name collisions. SDK
per-item errors are retained verbatim. The UI confirms restoration and
explains ordinary sync and conflict-copy behaviour before submitting.

`TrashRestoresChanged(s)` carries the complete `TrashRestore[]` list after
state changes, throttling intermediate per-item updates to 250 ms. Up to 20
recent jobs are kept in memory, cleared at sign-out.
`completed` means the attempt finished, not that all items succeeded; inspect
each result. Cancellation aborts remaining work, retains confirmed results,
and does not undo restored items. An interrupted submitted batch or a missing
SDK result is `unknown`; refresh Trash before retrying. `cancelled` on an item
means it was not submitted. Cancelling a finished job is a no-op. Sign-out and
shutdown cancel and await outstanding work. A daemon crash can leave remote
outcomes unknown; refresh Trash after restarting rather than assuming failure.

The pinned SDK can synthesise successful results for omitted per-link response
entries. For every SDK success, Halyard performs one targeted fresh node read
to confirm the item has left Trash. A failed confirmation or an item still in
Trash is `unknown`, rather than a claimed success. No confirmation polling is
added.

Successful/already-live/unconfirmed results invalidate affected SDK metadata.
For Drive, a normal sync cycle requests actual Drive events; the existing SDK
scheduler handles later events. Restored folders enter through the usual
event-driven catch-up path. Recovery never writes the durable sync base or
manufactures events. Photos invalidate the gallery's disposable views while
retaining its event cursor/scheduler, then reload on demand. Local edits and
root-loss guards remain governed by ordinary reconciliation. A refresh failure
is reported separately in `refreshError` and never changes successful restore
results. `Notify` reports completion and partial failures.

Permanent deletion and Empty Trash are not exposed. Version history stays in
the web app: pinned SDK `restoreRevision` acknowledges asynchronous acceptance
without a returned confirmation identity, warns that it may not apply, and
only marks its SDK node cache stale. Historical revision downloads exist,
but are outside this Trash feature by user preference. No SDK upgrade is used.

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

`RemovePair` cancels the pair's active sync and prevents queued cycles from
starting. It returns after the running work has unwound, then hides the pair
and either retains its sync state (`deleteLocalState: false`) or deletes that
state and its Activity history (`true`). Cancellation is not logged as a sync
failure. Local files and files on Proton Drive are kept.
Updates and removals of the same pair run in request order. An update queued
after removal fails with `No such pair`; a later removal can still discard
retained state.

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
  // waiting means a temporary connection/service failure; Halyard retries it.
  // paused means the user explicitly paused syncing or disabled this pair.
  "status": "idle",                   // setup|scanning|syncing|idle|waiting|paused|error
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

An empty `parentUid` lists folders at the root of My Files followed by accepted
folders shared with the user. Each category is sorted by name; the UI displays
the shared folders in a separate **Shared with me** group below My Files.
Folders only — the picker has no use for files. Pending invitations and shared
links/bookmarks are not included. Opening a folder lists only its children.

```jsonc
// RemoteFolder
{
  "uid": "volumeId~nodeId", "name": "Trips",
  "path": "/Shared with me/Trips", "hasChildren": true,
  "sharedWithMe": true, "canWrite": true
}
```

`sharedWithMe` is also true for descendants of a shared folder. `canWrite`
reflects the highest role along the accessible hierarchy (editor or admin).
Older daemons may omit these fields; the UI defaults them to false and true,
respectively. Read-only folders remain browsable but cannot be paired for
two-way sync or used for `CreateRemoteFolder`. The daemon enforces this for
pair creation, retargeting, and each sync cycle. Lost access pauses sync and
preserves local files and durable sync state.

`CreateRemoteFolder` returns the complete display path and the same sharing
metadata, including for folders created inside an editable share. An empty
`parentUid` still creates a folder at the root of My Files.

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
  "version": "0.2.1",
  "loggedIn": true,
  "email": "you@proton.me",
  "paused": false,
  // False while a temporary connection or Proton service failure is cooling
  // down. The daemon retries automatically; this is not a pair-specific error.
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

## Photos (0.2.0)

These methods require a signed-in account. All structured arguments and results
are JSON strings. The daemon owns the Photos SDK, including crypto and remote
access. Opening Folders does not access the photo gallery.

| Method | Signature | Argument / result |
|---|---|---|
| `ListPhotos` | `s → s` | `PhotoQuery` / `PhotoPage` |
| `ListPhotoAlbums` | `() → s` | `PhotoAlbum[]` |
| `GetPhoto` | `s → s` | photo uid / `Photo` |
| `GetPhotoThumbnails` | `s → s` | `{uids: string[], preview?: boolean}` / `PhotoThumbnail[]` |
| `StartPhotoDownload` | `s → s` | `{uids: string[], destination: string}` / `PhotoDownload` |
| `ListPhotoDownloads` | `() → s` | `PhotoDownload[]` |
| `ControlPhotoDownload` | `ss → ()` | job id, action |
| `StartPhotoUpload` | `s → s` | `{files: UploadInput[]}` / `PhotoUpload` |
| `ListPhotoUploads` | `() → s` | `PhotoUpload[]` |
| `ControlPhotoUpload` | `ss → ()` | job id, action |

`PhotoQuery` accepts `albumUid`, `cursor`, `limit` (1 to 100, default 60),
`search` (filename substring), `kind` (`all`, `favourites`, `videos`), `year`
(`YYYY`) and `month` (`YYYY-MM`, in UTC). Leave `albumUid` absent for the
timeline. A cursor is opaque
and must be used with the same query. A gallery event invalidates old cursors;
reload from the first page after `PhotosChanged`. Filtered requests examine at
most 600 entries, so an empty page can have a non-null `nextCursor`.
Year/month filtering uses SDK date placeholders before fetching decrypted nodes.
Pagination ends once the SDK iterator has passed the chosen period and no
matching cached placeholders remain. This ends only that query; older dates
and all-dates browsing still use the same lazy collection.
The UI follows those pages on a date jump and loads further gallery pages near
the bottom of the viewport. Continuation requests are serialized; a failed
request exposes a manual retry instead of repeating automatically. A stale
continuation refreshes once while retaining selection and the requested extent.
Explicit refresh also retains loaded pages and selection where photos remain.

```ts
type Photo = {
  uid: string;
  name: string;
  captureTime: number;             // epoch milliseconds
  size: number | null;
  mediaType: string;
  revisionUid: string;
  favourite: boolean;
  relatedUids: string[];           // related live/motion assets
  error: string | null;
  canFavourite: boolean;            // owned Photos volume only
  canTrash: boolean;                // owned Photos volume only
};
type PhotoPage = { photos: Photo[]; nextCursor: string | null; revision: number };
type PhotoAlbum = {
  uid: string; name: string; photoCount: number; coverPhotoUid: string | null;
  sharedWithMe: boolean; canWrite: boolean; canDelete: boolean;
};
type PhotoThumbnail = { uid: string; data: string | null; error: string | null };
```

Thumbnail `data` is base64 image bytes. Request no more than 12 uids per call.
`preview: false` requests SDK type 1, `true` requests type 2. A preview is not
the original file. Thumbnail responses are capped at 3 MiB per image before
base64 encoding; their memory cache is capped at 32 MiB. Account changes discard
gallery state. The initial SDK timeline iterator is retained between pages;
subsequent remote changes come from the SDK event scheduler. There is no
periodic recursive gallery walk. Explicit SDK tree refresh events can discard
that iterator. Browsing an empty gallery never creates a Photos volume.

### Photo and album management

| Method | Signature | Argument / result |
|---|---|---|
| `CreatePhotoAlbum` | `s → s` | name / `PhotoAlbum` |
| `RenamePhotoAlbum` | `s → s` | `{uid: string, name: string}` / `PhotoAlbum` |
| `DeletePhotoAlbum` | `s → ()` | album uid |
| `ManagePhotos` | `s → s` | `PhotoManagementRequest` / `PhotoManagementResult` |
| `CancelPhotoOperation` | `s → ()` | operation id; unknown or completed ids are a no-op |

```ts
type PhotoManagementRequest = {
  operationId: string;             // unique per active call, 1..80 letters/digits/_/-
  action: 'favourite' | 'add' | 'remove';
  uids: string[];                  // 1..100 main photos; duplicates handled once
  favourite?: boolean;            // required for favourite
  albumUid?: string;              // required for add/remove
};
type PhotoManagementResult = {
  results: {uid: string; ok: boolean; error: string | null}[];
  cancelled: boolean;
  revision: number;
};
```

The UI processes larger selections in sequential calls of 25 photos,
with a unique operation ID per call. It keeps confirmed outcomes across batches,
stops sending new batches on cancellation or a request error, and refreshes once
at the end. Management calls allow five minutes for fresh metadata, related
assets and preservation; cancellation remains available while waiting.
Only confirmed album additions clear their selection.

Albums include accepted albums shared with the user. `canWrite` reflects the
highest accessible SDK role, including inherited editor/admin access. Only
owned albums have `canDelete`. These flags guide the UI; the daemon checks fresh
album permissions again before writes. Shared-album photos can be viewed,
downloaded and added to writable albums; favourites and Trash are restricted
to the user's own Photos volume. Cross-volume album additions use the SDK's
copy semantics. Shared album event scopes follow the SDK scheduler's cadence.
Explicit album listings discover accepted/revoked shares; there is no recurring
album enumeration.

With the pinned SDK, shared-album metadata access also requires the user's own
Photos volume. If that volume does not yet exist, browsing returns an empty
gallery without creating cloud storage. The user can explicitly create an album
or upload a supported photo to initialise their gallery; accepted shared albums
then become available on reload.

Favourites use `updatePhotos` with `PhotoTag.Favorites` on the main photo, leaving
other tags and related-file tags intact. Favouriting an owned album-only photo
saves it to the timeline while retaining its album membership. Add includes
related assets through the SDK. Remove explicitly includes related assets and
saves album-only photos to the timeline first (copying shared-volume photos).
If preservation cannot be confirmed, that photo's membership is kept. Removing
membership does not trash or delete originals.
Adding a photo already in an album is a confirmed no-op only when fresh metadata
also confirms its related assets are members. Otherwise SDK errors remain errors.
After additions the UI clears confirmed items from selection, retaining failed
or unconfirmed items and keeping selection mode available for the next batch.
Error details offer dismissal without changing any mutation result.

`DeletePhotoAlbum` permanently deletes the album after UI confirmation. It
always passes `{saveToTimeline: true}` to the SDK and never `force`. Album-only
photos, including related assets, must be saved successfully before the SDK
retries deletion. Failure stops deletion; already saved photos remain saved.
The SDK has no cancellation signal for create, rename or delete; the UI must
not offer cancellation for those calls. Explicit creation may initialise an
empty Photos volume. Names must contain 1..255 characters after trimming and
cannot contain slashes or control characters.

`ManagePhotos` remains pending while cancellable SDK work runs. Cancellation
aborts supported steps and preserves completed results. Every selected main
photo has a result; missing SDK results and interrupted requests are errors,
never fabricated successes. A failed main-photo removal can include partially
removed linked memberships. Reload before retrying unconfirmed changes.
The GTK gallery and preview offer details identifying each failed photo.
Attempted writes invalidate gallery collections and album metadata and emit
`PhotosChanged`, even when a response fails or a cancellation races a write.
Affected SDK metadata is evicted too, so a lost reply cannot leave reload using
the pre-write state. Additions and favourite preparation retain SDK batching.
Account reset aborts work and suppresses old-account results. Client timeouts
also mean an outcome is unconfirmed; check the library before retrying.

```ts
type PhotoDownloadFile = {
  uid: string; name: string; size: number | null; bytesDone: number;
  status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
  path: string | null; error: string | null;
};
type PhotoDownload = {
  id: string; destination: string; createdAt: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';
  files: PhotoDownloadFile[];
};
type UploadInput = {
  path: string;
  thumbnails: { type: 1 | 2; data: string }[]; // JPEG base64, one of each type
};
type PhotoUploadFile = {
  uid: string; name: string; path: string; size: number; bytesDone: number;
  status: 'queued' | 'uploading' | 'completed' | 'skipped' | 'failed' | 'cancelled';
  error: string | null;
};
type PhotoUpload = {
  id: string; destination: 'Proton Drive Photos'; createdAt: number;
  status: 'queued' | 'uploading' | 'paused' | 'completed' | 'failed' | 'cancelled';
  files: PhotoUploadFile[];
};
```

Download selections contain 1 to 1,000 photo uids. Related assets are included
once, with a maximum of 5,000 files per job. The destination must resolve inside
the user's home directory. Files first land in a `.halyard-part` temporary
file, are checked by the SDK, then published without overwriting existing
files. Collisions use numbered names. This does not create a folder pair; a
destination overlapping an existing pair follows that pair's normal rules.

Uploads accept 1 to 20 JPEG, PNG or WebP originals inside the user's home
directory. The GTK client prepares oriented JPEG previews off the main thread,
bounded to 256 and 2,048 pixels. The daemon checks paths, file type and previews
before queueing. Maximum preview data is 24 MiB per job. Original bytes are
streamed with expected size and SHA1 checks. A changed file fails and must be
chosen again. The SDK duplicate check uses both name and content; matching
copies receive `skipped` status. EXIF capture time is used where available in
the first 1 MiB of metadata; otherwise the file modification date is used.
Upload may initialise a missing Photos volume. Local files remain in place.

Control actions are `pause`, `resume`, `cancel` and `retry`. Invalid transitions
fail with a user-facing error. Retry skips completed files and skipped uploads.
The daemon runs one download job and one upload job at a time. These queues are
separate from folder reconciliation, the sync base and sync history. Jobs and
previews are not persisted as plaintext. Jobs continue after the UI closes,
but do not survive daemon restart. Sign-out cancels jobs and clears their state.

### Photo signals

| Signal | Signature | Payload |
|---|---|---|
| `PhotosChanged` | `s` | `{revision: number}` |
| `PhotoDownloadsChanged` | `s` | `PhotoDownload[]` |
| `PhotoUploadsChanged` | `s` | `PhotoUpload[]` |

Progress signals are throttled to about four per second per queue; transitions
are emitted immediately. `PhotosChanged` also follows successful uploads, so
a visible gallery can offer Reload without disturbing the current selection.

### Trash and video playback

| Method | Signature | Argument / result |
|---|---|---|
| `TrashPhotos` | `s → s` | `{uids: string[]}` / `PhotoTrashResult[]` |
| `StartVideoPreview` | `s → s` | video uid / `VideoPreview` |
| `ReleaseVideoPreview` | `s → ()` | preview id |

```ts
type PhotoTrashResult = { uid: string; ok: boolean; error: string | null };
type VideoPreview = {
  id: string; uid: string; status: 'ready' | 'failed';
  uri: string | null; size: number; error: string | null;
};
```

`TrashPhotos` accepts 1 to 100 selected photo/video uids and includes their
related assets (up to 1,000 files). Every node is validated as a photo before
any mutation; folders and albums are refused. The SDK moves them to Trash,
where Proton Drive can restore them. Local downloaded copies are untouched.
This is not permanent deletion. The UI requires a destructive-action
confirmation. Results cover individual assets, including partial failures.
Successful mutations update the gallery revision immediately and release
playback sessions for trashed videos.

`StartVideoPreview` creates an in-memory playback capability and returns an
unguessable URI on `http://127.0.0.1:<ephemeral-port>/video/<token>`. GTK uses it
as a media source. The daemon serves HTTP byte ranges through the SDK's
`getSeekableStream()`, which decrypts requested blocks and supports seeking.
It does not download the full video first or create a decrypted media file.
The listener rejects foreign origins, incorrect Host headers, unknown tokens,
multiple ranges, and invalid ranges. No CORS headers are exposed. There are at
most four previews and four concurrent requests per preview. Playback
capabilities are secrets and must not be logged or persisted.

Call `ReleaseVideoPreview` when leaving a video, changing selection or closing
the preview. Sign-out and daemon shutdown release all capabilities and abort
requests; idle previews expire after 15 minutes without requests. The GTK
client stops its media stream before releasing the capability.

The pinned SDK seekable path does **not** perform full-file integrity checks.
Original downloads continue to use the verified download API. Videos with
unknown sizes or older revisions lacking claimed block sizes can require
Download instead. Each preview has a separate SDK client, sharing encrypted
caches and account dependencies, so unsupported seeking cannot consume the
original-download queue's capacity. Native codec support comes from GTK's
media backend. Failed streaming and codec errors provide a Download fallback.

`VideoPreviewChanged(s)` carries a `VideoPreview` when an active stream fails.
Its URI must pass the same local-host checks before GTK receives it.
