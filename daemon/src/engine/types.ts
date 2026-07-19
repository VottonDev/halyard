export type NodeKind = 'file' | 'folder';

/** A folder pair: one local directory kept in step with one Drive folder. */
export type Pair = {
    id: string;
    localPath: string;
    remoteUid: string;
    remotePath: string;
    enabled: boolean;
    /** gitignore-style patterns, relative to the pair root. See engine/exclude.ts. */
    excludes: string[];
    treeEventScopeId: string | null;
    eventCursor: string | null;
    /** False while the one-time remote enumeration is still in progress. */
    seeded: boolean;
    createdAt: number;
    lastSyncAt: number | null;
};

/**
 * The last state at which both sides were known to agree — the "base" of the
 * three-way merge. Without this you cannot tell a local edit from a remote
 * deletion, so every sync decision ultimately rests on these rows.
 */
export type BaseEntry = {
    path: string;
    type: NodeKind;
    localMtime: number;
    localSize: number;
    localInode: number | null;
    /** Paired with the inode to identify a file across renames. See LocalItem. */
    localDevice: number | null;
    localHash: string | null;
    remoteUid: string;
    remoteRevisionUid: string | null;
    remoteHash: string | null;
    remoteSize: number;
    remoteMtime: number;
};

export type LocalItem = {
    path: string;
    type: NodeKind;
    mtime: number;
    size: number;
    inode: number;
    /**
     * Device id. Required alongside the inode because inode numbers are only
     * unique within a filesystem — and on btrfs, only within a *subvolume*, so
     * two files under one synced folder really can share an inode number.
     */
    device: number;
    /** Computed lazily — only when mtime/size suggest the content may differ. */
    hash?: string | null;
};

export type RemoteItem = {
    path: string;
    type: NodeKind;
    uid: string;
    parentUid: string | null;
    revisionUid: string | null;
    hash: string | null;
    size: number;
    mtime: number;
    trashed: boolean;
};

export type ConflictKind = 'bothModified' | 'localDeletedRemoteModified' | 'remoteDeletedLocalModified';

export type Conflict = {
    id: string;
    pairId: string;
    path: string;
    kind: ConflictKind;
    detectedAt: number;
    keptCopyPath: string | null;
    localModifiedAt: number | null;
    remoteModifiedAt: number | null;
};

/**
 * What the user sees in the activity log, in their vocabulary rather than the
 * executor's.
 *
 * These are deliberately finer-grained than `Action`: "downloaded" and
 * "updatedLocal" are both a download, but one appeared out of nowhere and the
 * other overwrote something the user already had, and those read very
 * differently when you are trying to work out what happened to a file.
 */
export type SyncEventAction =
    | 'downloaded'
    | 'updatedLocal'
    | 'uploaded'
    | 'updatedRemote'
    | 'deletedLocal'
    | 'trashedRemote'
    | 'movedLocal'
    | 'movedRemote'
    | 'createdLocalFolder'
    | 'createdRemoteFolder';

export type SyncEventOutcome = 'ok' | 'failed';

/**
 * One thing that happened to one file, recorded after the fact.
 *
 * This exists because sync is otherwise invisible: files appear and disappear
 * with no explanation, and "it was deleted here because it was removed from
 * Drive" is not something a user can deduce. Log files do not count — nobody
 * reads them.
 */
export type SyncEvent = {
    id: number;
    pairId: string;
    at: number;
    action: SyncEventAction;
    path: string;
    /** Destination, for moves and renames only. */
    toPath: string | null;
    type: NodeKind;
    size: number | null;
    outcome: SyncEventOutcome;
    error: string | null;
};

/** Query for the activity log. All fields narrow; omitting them means "any". */
export type HistoryFilter = {
    pairId?: string;
    actions?: SyncEventAction[];
    outcome?: SyncEventOutcome;
    /** Case-insensitive substring match on the path. */
    search?: string;
    /** Paging cursor: only entries older than this id. Ids descend with time. */
    beforeId?: number;
    limit?: number;
};

/**
 * A single unit of work. The reconciler emits these; the executor performs
 * them. Keeping them as plain data is what makes the merge logic testable
 * without touching the filesystem or the network.
 */
export type Action =
    | { kind: 'createLocalFolder'; path: string }
    | { kind: 'createRemoteFolder'; path: string }
    | { kind: 'download'; path: string; remoteUid: string; revisionUid: string | null }
    | { kind: 'upload'; path: string; existingRemoteUid: string | null }
    /** Applied directly: Proton Drive's own Trash is the recovery path. */
    | { kind: 'deleteLocal'; path: string; type: NodeKind }
    | { kind: 'trashRemote'; path: string; remoteUid: string }
    | { kind: 'moveLocal'; from: string; to: string }
    | { kind: 'moveRemote'; from: string; to: string; remoteUid: string }
    | { kind: 'refreshBase'; path: string }
    | { kind: 'dropBase'; path: string };

export type Plan = {
    actions: Action[];
    conflicts: Array<Omit<Conflict, 'id' | 'pairId'>>;
};
