import type { Action, BaseEntry, Conflict, LocalItem, Plan, RemoteItem } from './types.js';

/**
 * Three-way merge between the local filesystem, the remote Drive folder, and
 * the base (the last state at which the two agreed).
 *
 * This module is deliberately pure: no filesystem, no network, no clock beyond
 * an injected `now`. Every sync decision the daemon makes is decided here, so
 * it needs to be exhaustively testable in isolation.
 *
 * The governing policy is **never lose data**. Where the two sides genuinely
 * disagree, both versions survive; where a deletion races an edit, the edit
 * wins. Halyard will happily resurrect a file you deleted rather than destroy
 * one you changed.
 */

type ChangeState = 'unchanged' | 'created' | 'modified' | 'deleted';

export type ReconcileInput = {
    base: Map<string, BaseEntry>;
    local: Map<string, LocalItem>;
    remote: Map<string, RemoteItem>;
    now: number;
    /**
     * Resolves content equality when mtime/size are inconclusive. Returning
     * `null` means "unknown", which is treated as "differs" — the safe answer.
     */
    localHashOf?: (path: string) => string | null;
};

function parentOf(path: string): string | null {
    const index = path.lastIndexOf('/');
    return index <= 0 ? null : path.slice(0, index);
}

function depth(path: string): number {
    return path.split('/').length;
}

function isDescendantOf(path: string, ancestor: string): boolean {
    return path.startsWith(ancestor + '/');
}

/**
 * Builds the name a losing copy is renamed to, e.g.
 * `notes.md` → `notes (conflict 2026-07-19).md`. Dotfiles and extensionless
 * names are handled by only treating a dot as an extension separator when it
 * is not the first character.
 */
export function conflictName(path: string, now: number): string {
    const date = new Date(now).toISOString().slice(0, 10);
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash + 1);
    const name = slash === -1 ? path : path.slice(slash + 1);

    const dot = name.lastIndexOf('.');
    if (dot > 0) {
        return `${dir}${name.slice(0, dot)} (conflict ${date})${name.slice(dot)}`;
    }
    return `${dir}${name} (conflict ${date})`;
}

function localChange(base: BaseEntry | undefined, local: LocalItem | undefined, hashOf?: (p: string) => string | null): ChangeState {
    if (!base) {
        return local ? 'created' : 'unchanged';
    }
    if (!local) {
        return 'deleted';
    }
    if (local.type !== base.type) {
        return 'modified';
    }
    if (local.type === 'folder') {
        return 'unchanged';
    }
    if (local.mtime === base.localMtime && local.size === base.localSize) {
        return 'unchanged';
    }
    // mtime or size moved. Size alone is conclusive; otherwise fall back to the
    // hash, because touching a file or restoring it from backup changes mtime
    // without changing content, and re-uploading then would be pure waste.
    if (local.size !== base.localSize) {
        return 'modified';
    }
    const hash = local.hash !== undefined ? local.hash : hashOf?.(local.path) ?? null;
    if (hash && base.localHash && hash === base.localHash) {
        // Same bytes, new timestamp: adopt the timestamp, do not transfer.
        return 'unchanged';
    }
    return 'modified';
}

function remoteChange(base: BaseEntry | undefined, remote: RemoteItem | undefined): ChangeState {
    if (!base) {
        return remote && !remote.trashed ? 'created' : 'unchanged';
    }
    if (!remote || remote.trashed) {
        return 'deleted';
    }
    if (remote.type !== base.type) {
        return 'modified';
    }
    if (remote.type === 'folder') {
        return 'unchanged';
    }
    // The revision uid is the authoritative identity of a file's content on the
    // server. A move or rename does not change it, which is exactly what we
    // want — those are handled separately as moves, not as content changes.
    return remote.revisionUid === base.remoteRevisionUid ? 'unchanged' : 'modified';
}

function sameContent(local: LocalItem | undefined, remote: RemoteItem | undefined, hashOf?: (p: string) => string | null): boolean {
    if (!local || !remote || local.type !== remote.type) {
        return false;
    }
    if (local.type === 'folder') {
        return true;
    }
    const localHash = local.hash !== undefined ? local.hash : hashOf?.(local.path) ?? null;
    if (!localHash || !remote.hash) {
        return false;
    }
    return localHash.toLowerCase() === remote.hash.toLowerCase();
}

/**
 * Detects renames and moves before the main matrix runs.
 *
 * Without this, a renamed 4 GB file looks like a delete plus an unrelated
 * create, and gets re-transferred in full. Remote moves are matched by node
 * uid, local moves by inode — both are stable identities that survive a
 * rename on their respective side.
 *
 * The base map is rewritten in place so the matrix afterwards sees the world
 * as though the move had always been there.
 */
function detectMoves(input: ReconcileInput, actions: Action[]): void {
    const { base, local, remote } = input;

    // --- Remote moves: same node uid, different path.
    const baseByUid = new Map<string, BaseEntry>();
    for (const entry of base.values()) {
        baseByUid.set(entry.remoteUid, entry);
    }

    for (const [path, item] of remote) {
        if (item.trashed) {
            continue;
        }
        const previous = baseByUid.get(item.uid);
        if (!previous || previous.path === path) {
            continue;
        }
        // Only a move if the old path really is vacated on both sides and the
        // new path is not already occupied locally by something else.
        if (remote.has(previous.path) || local.has(path)) {
            continue;
        }
        if (!local.has(previous.path)) {
            continue;
        }

        actions.push({ kind: 'moveLocal', from: previous.path, to: path });

        const moved = local.get(previous.path)!;
        local.delete(previous.path);
        local.set(path, { ...moved, path });

        base.delete(previous.path);
        base.set(path, { ...previous, path });
    }

    // --- Local moves: same file identity, different path.
    //
    // Identity is (device, inode), not inode alone. Inode numbers are unique
    // only within a filesystem, and on btrfs only within a subvolume — so a
    // synced folder spanning subvolumes can genuinely contain two files with
    // the same inode number. Keying on the inode alone would then "detect" a
    // move between two unrelated files and rename the wrong one on Drive.
    const identity = (device: number | null, inode: number | null): string => `${device ?? '?'}:${inode ?? '?'}`;

    const baseByIdentity = new Map<string, BaseEntry>();
    for (const entry of base.values()) {
        if (entry.localInode !== null && entry.type === 'file') {
            baseByIdentity.set(identity(entry.localDevice, entry.localInode), entry);
        }
    }

    for (const [path, item] of local) {
        if (item.type !== 'file') {
            continue;
        }
        const previous = baseByIdentity.get(identity(item.device, item.inode));
        if (!previous || previous.path === path) {
            continue;
        }
        if (local.has(previous.path) || remote.has(path)) {
            continue;
        }
        const remoteSource = remote.get(previous.path);
        if (!remoteSource || remoteSource.trashed) {
            continue;
        }

        actions.push({ kind: 'moveRemote', from: previous.path, to: path, remoteUid: remoteSource.uid });

        remote.delete(previous.path);
        remote.set(path, { ...remoteSource, path });

        base.delete(previous.path);
        base.set(path, { ...previous, path });
    }

    // --- Collapse a moved folder's subtree into the single folder move.
    //
    // Matching by identity finds the folder *and* every node inside it, so a
    // folder move surfaces here as one move for the folder plus one for each
    // descendant. But a directory rename relocates the whole subtree in a
    // single syscall, so the executor would then try to move descendants their
    // parent has already carried off — each failing with ENOENT and landing in
    // the activity log as a bogus failed move. Drop any move already implied by
    // an ancestor's move (same source subtree, same destination subtree); the
    // in-place base/local/remote rewrites above have already relocated it.
    const moves = actions.filter(
        (action): action is Extract<Action, { kind: 'moveLocal' | 'moveRemote' }> =>
            action.kind === 'moveLocal' || action.kind === 'moveRemote',
    );
    const carriedByAncestor = (move: { from: string; to: string }): boolean =>
        moves.some(
            (other) =>
                other !== move &&
                isDescendantOf(move.from, other.from) &&
                move.to === other.to + move.from.slice(other.from.length),
        );
    for (let i = actions.length - 1; i >= 0; i -= 1) {
        const action = actions[i];
        if ((action.kind === 'moveLocal' || action.kind === 'moveRemote') && carriedByAncestor(action)) {
            actions.splice(i, 1);
        }
    }
}

/**
 * A folder must not be removed on one side if it still holds work the other
 * side has not seen. Deleting an empty-looking folder is cheap; deleting one
 * containing a file the user just edited is data loss.
 */
function hasProtectedDescendants(
    folder: string,
    base: Map<string, BaseEntry>,
    local: Map<string, LocalItem>,
    remote: Map<string, RemoteItem>,
    side: 'local' | 'remote',
    hashOf?: (p: string) => string | null,
): boolean {
    const candidates = side === 'local' ? local : remote;
    for (const path of candidates.keys()) {
        if (!isDescendantOf(path, folder)) {
            continue;
        }
        const entry = base.get(path);
        const change =
            side === 'local'
                ? localChange(entry, local.get(path), hashOf)
                : remoteChange(entry, remote.get(path));
        if (change === 'created' || change === 'modified') {
            return true;
        }
    }
    return false;
}

export function reconcile(input: ReconcileInput): Plan {
    const { base, local, remote, now, localHashOf } = input;
    const actions: Action[] = [];
    const conflicts: Plan['conflicts'] = [];

    detectMoves(input, actions);

    const paths = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys()]);
    // Paths already handled as part of a move are not revisited.
    const movedPaths = new Set<string>();
    for (const action of actions) {
        if (action.kind === 'moveLocal' || action.kind === 'moveRemote') {
            movedPaths.add(action.from);
        }
    }

    for (const path of paths) {
        if (movedPaths.has(path)) {
            continue;
        }

        const baseEntry = base.get(path);
        const localItem = local.get(path);
        const remoteItem = remote.get(path);

        const localState = localChange(baseEntry, localItem, localHashOf);
        const remoteState = remoteChange(baseEntry, remoteItem);

        // ---- Nothing to do.
        if (localState === 'unchanged' && remoteState === 'unchanged') {
            // A file whose mtime drifted but whose content matched still needs
            // its recorded timestamp refreshed, or we rehash it every cycle.
            if (baseEntry && localItem && localItem.type === 'file' && localItem.mtime !== baseEntry.localMtime) {
                actions.push({ kind: 'refreshBase', path });
            }
            continue;
        }

        // ---- Both sides gone.
        if (localState === 'deleted' && remoteState === 'deleted') {
            actions.push({ kind: 'dropBase', path });
            continue;
        }

        // ---- Only one side changed: propagate it.
        if (remoteState === 'unchanged' && (localState === 'created' || localState === 'modified')) {
            if (localItem!.type === 'folder') {
                if (!remoteItem) {
                    actions.push({ kind: 'createRemoteFolder', path });
                }
            } else {
                actions.push({
                    kind: 'upload',
                    path,
                    existingRemoteUid: remoteItem && !remoteItem.trashed ? remoteItem.uid : null,
                });
            }
            continue;
        }

        if (localState === 'unchanged' && (remoteState === 'created' || remoteState === 'modified')) {
            if (remoteItem!.type === 'folder') {
                if (!localItem) {
                    actions.push({ kind: 'createLocalFolder', path });
                }
            } else {
                actions.push({
                    kind: 'download',
                    path,
                    remoteUid: remoteItem!.uid,
                    revisionUid: remoteItem!.revisionUid,
                });
            }
            continue;
        }

        // ---- Deleted on one side, untouched on the other: propagate deletion.
        if (localState === 'deleted' && remoteState === 'unchanged') {
            if (remoteItem) {
                if (
                    remoteItem.type === 'folder' &&
                    hasProtectedDescendants(path, base, local, remote, 'remote', localHashOf)
                ) {
                    // Something new lives under here remotely; bring the folder
                    // back locally instead of deleting it.
                    actions.push({ kind: 'createLocalFolder', path });
                    continue;
                }
                actions.push({ kind: 'trashRemote', path, remoteUid: remoteItem.uid });
            }
            actions.push({ kind: 'dropBase', path });
            continue;
        }

        if (remoteState === 'deleted' && localState === 'unchanged') {
            if (localItem) {
                if (
                    localItem.type === 'folder' &&
                    hasProtectedDescendants(path, base, local, remote, 'local', localHashOf)
                ) {
                    actions.push({ kind: 'createRemoteFolder', path });
                    continue;
                }
                // Safe to delete outright: we only reach here when the local
                // copy is unchanged from the base, so its bytes are exactly
                // what Proton Drive is holding in its Trash. A locally-edited
                // file takes the "edit beats deletion" branch below instead.
                actions.push({ kind: 'deleteLocal', path, type: localItem.type });
            }
            actions.push({ kind: 'dropBase', path });
            continue;
        }

        // ---- Genuine conflicts from here on.

        // Deletion versus edit: the edit always wins. Resurrecting a file the
        // user deleted is recoverable; discarding an edit is not.
        if (localState === 'deleted' && (remoteState === 'created' || remoteState === 'modified')) {
            if (remoteItem!.type === 'folder') {
                actions.push({ kind: 'createLocalFolder', path });
            } else {
                actions.push({
                    kind: 'download',
                    path,
                    remoteUid: remoteItem!.uid,
                    revisionUid: remoteItem!.revisionUid,
                });
                conflicts.push({
                    path,
                    kind: 'localDeletedRemoteModified',
                    detectedAt: now,
                    keptCopyPath: path,
                    localModifiedAt: null,
                    remoteModifiedAt: remoteItem!.mtime,
                });
            }
            continue;
        }

        if (remoteState === 'deleted' && (localState === 'created' || localState === 'modified')) {
            if (localItem!.type === 'folder') {
                actions.push({ kind: 'createRemoteFolder', path });
            } else {
                actions.push({ kind: 'upload', path, existingRemoteUid: null });
                conflicts.push({
                    path,
                    kind: 'remoteDeletedLocalModified',
                    detectedAt: now,
                    keptCopyPath: path,
                    localModifiedAt: localItem!.mtime,
                    remoteModifiedAt: null,
                });
            }
            continue;
        }

        // Both sides changed.
        if (localItem && remoteItem) {
            if (localItem.type === 'folder' && remoteItem.type === 'folder') {
                actions.push({ kind: 'refreshBase', path });
                continue;
            }

            if (sameContent(localItem, remoteItem, localHashOf)) {
                // Converged independently — record agreement, transfer nothing.
                actions.push({ kind: 'refreshBase', path });
                continue;
            }

            // Keep both: the local copy steps aside under a dated name, the
            // remote version takes the canonical path, and the preserved copy
            // is uploaded so both sides end up holding both versions.
            const keptPath = conflictName(path, now);
            actions.push({ kind: 'moveLocal', from: path, to: keptPath });
            actions.push({
                kind: 'download',
                path,
                remoteUid: remoteItem.uid,
                revisionUid: remoteItem.revisionUid,
            });
            actions.push({ kind: 'upload', path: keptPath, existingRemoteUid: null });
            conflicts.push({
                path,
                kind: 'bothModified',
                detectedAt: now,
                keptCopyPath: keptPath,
                localModifiedAt: localItem.mtime,
                remoteModifiedAt: remoteItem.mtime,
            });
            continue;
        }

        // Created independently on both sides at the same path.
        if (!baseEntry && localItem && remoteItem) {
            continue; // handled above
        }
    }

    return { actions: sortActions(actions), conflicts };
}

/**
 * Orders actions so they can be executed sequentially without tripping over
 * each other: moves first, then folders top-down, then transfers, then
 * deletions bottom-up.
 */
export function sortActions(actions: Action[]): Action[] {
    const rank: Record<Action['kind'], number> = {
        moveLocal: 0,
        moveRemote: 0,
        createLocalFolder: 1,
        createRemoteFolder: 1,
        download: 2,
        upload: 2,
        deleteLocal: 3,
        trashRemote: 3,
        refreshBase: 4,
        dropBase: 4,
    };

    const pathOf = (action: Action): string => ('path' in action ? action.path : action.to);

    return [...actions].sort((a, b) => {
        const rankDiff = rank[a.kind] - rank[b.kind];
        if (rankDiff !== 0) {
            return rankDiff;
        }
        const depthDiff = depth(pathOf(a)) - depth(pathOf(b));
        // Creations run parents-first; deletions run children-first.
        const descending = rank[a.kind] === 3;
        return descending ? -depthDiff : depthDiff;
    });
}

export const _internal = { localChange, remoteChange, detectMoves, parentOf, depth };
