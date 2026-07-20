import {
    DriveEventType,
    NodeType,
    type DriveEvent,
    type NodeEntity,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import { getLogger } from '../log.js';
import type { RemoteNodeInput, SyncDatabase } from './db.js';
import { compileExcludes } from './exclude.js';
import type { NodeKind, Pair, RemoteItem } from './types.js';

const logger = getLogger('remote');

/** Nodes whose name failed to decrypt cannot be placed in a path; skip them. */
function nodeName(node: NodeEntity): string | null {
    return node.name.ok ? node.name.value : null;
}

function nodeKind(node: NodeEntity): NodeKind | null {
    if (node.type === NodeType.Folder) {
        return 'folder';
    }
    if (node.type === NodeType.File) {
        return 'file';
    }
    return null;
}

/**
 * Flattens a node into the row we store.
 *
 * Two subtleties matter for sync:
 *
 *  - `modificationTime` on the node is *server-side* and gets bumped by a
 *    rename or move, so it is useless as a content signal. The real filesystem
 *    timestamp lives on the revision as `claimedModificationTime`.
 *  - `storageSize` is the encrypted size. The plaintext size we can compare
 *    against a local file is `claimedSize`.
 */
function toRemoteNode(node: NodeEntity): RemoteNodeInput | null {
    const name = nodeName(node);
    const kind = nodeKind(node);
    if (!name || !kind) {
        logger.warn(`Skipping node ${node.uid}: name or type could not be resolved`);
        return null;
    }

    const revision = node.activeRevision?.ok ? node.activeRevision.value : undefined;

    return {
        uid: node.uid,
        parentUid: node.parentUid ?? null,
        name,
        type: kind,
        revisionUid: revision?.uid ?? null,
        hash: revision?.claimedDigests?.sha1 ?? null,
        size: revision?.claimedSize ?? revision?.storageSize ?? 0,
        mtime:
            revision?.claimedModificationTime?.getTime() ??
            node.folder?.claimedModificationTime?.getTime() ??
            node.modificationTime.getTime(),
        trashed: !!node.trashTime,
    };
}

/**
 * Mirrors one pair's remote folder and keeps it current from Drive events.
 *
 * Proton's operating rules require event-based sync — repeatedly listing the
 * tree is treated as abuse and gets rate-limited. So the full walk happens
 * exactly once per pair (or after a refresh event), and everything after that
 * is driven by the event stream.
 */
export class RemoteTree {
    private isExcluded: (relativePath: string) => boolean;

    /**
     * Memoised result of buildFolderPaths(). A pull() can deliver thousands of
     * events, and rebuilding the map for each one made applying a batch
     * O(events × nodes). File events never change folder paths, and a brand-new
     * folder only extends the map, so the cache survives the common cases and
     * is dropped only when a folder is renamed, moved, or removed.
     */
    private folderPathsCache: Map<string, string> | null = null;

    constructor(
        private readonly db: SyncDatabase,
        private readonly client: ProtonDriveClient,
        private pair: Pair,
        /** Reports enumeration progress, so a long seed is visible rather than silent. */
        private readonly onProgress?: (folders: number, nodes: number) => void,
    ) {
        this.isExcluded = compileExcludes(pair.excludes ?? []);
    }

    setPair(pair: Pair): void {
        this.pair = pair;
        this.isExcluded = compileExcludes(pair.excludes ?? []);
        this.folderPathsCache = null;
    }

    private folderPaths(): Map<string, string> {
        this.folderPathsCache ??= this.buildFolderPaths();
        return this.folderPathsCache;
    }

    /** Keeps the cached path map aligned with a folder row just written. */
    private noteFolderStored(row: RemoteNodeInput): void {
        const cache = this.folderPathsCache;
        if (!cache) {
            return;
        }
        const parentPath = row.parentUid ? cache.get(row.parentUid) : '';
        if (parentPath === undefined) {
            this.folderPathsCache = null;
            return;
        }
        const newPath = parentPath ? `${parentPath}/${row.name}` : row.name;
        const existing = cache.get(row.uid);
        if (existing === undefined) {
            cache.set(row.uid, newPath);
        } else if (existing !== newPath) {
            // Rename or move: every descendant's path shifted with it.
            this.folderPathsCache = null;
        }
    }

    /** Invalidates the cached path map when a removed node was a known folder. */
    private noteNodeRemoved(uid: string): void {
        if (this.folderPathsCache?.has(uid)) {
            this.folderPathsCache = null;
        }
    }

    private async *listChildren(parentUid: string, signal?: AbortSignal): AsyncGenerator<NodeEntity> {
        const uids: string[] = [];
        for await (const uid of this.client.iterateFolderChildrenNodeUids(parentUid, undefined, signal)) {
            uids.push(uid);
        }
        if (uids.length === 0) {
            return;
        }
        for await (const node of this.client.iterateNodes(uids, signal)) {
            if ('missingUid' in node) {
                continue;
            }
            yield node;
        }
    }

    /** Relative path of every known folder, so exclusions can be tested during the walk. */
    private buildFolderPaths(): Map<string, string> {
        const rows = this.db.getRemoteNodes(this.pair.id);
        const byParent = new Map<string, typeof rows>();
        for (const row of rows) {
            const key = row.parent_uid ?? '';
            const list = byParent.get(key) ?? [];
            list.push(row);
            byParent.set(key, list);
        }

        const paths = new Map<string, string>([[this.pair.remoteUid, '']]);
        const walk = (parentUid: string, prefix: string): void => {
            for (const row of byParent.get(parentUid) ?? []) {
                const relative = prefix ? `${prefix}/${row.name}` : row.name;
                if (row.type === 'folder') {
                    paths.set(row.uid, relative);
                    walk(row.uid, relative);
                }
            }
        };
        walk(this.pair.remoteUid, '');
        return paths;
    }

    /**
     * One-time enumeration of the remote folder, used on first sync and after
     * a TreeRefresh. Also establishes the event scope and starting cursor.
     *
     * Three things make this survivable on a large folder:
     *
     *  - **It is resumable.** Each folder is marked once its children have been
     *    listed, so an interrupted seed continues from the frontier. Without
     *    this, a tree big enough to outlast one run could never finish: every
     *    restart began again from nothing.
     *  - **It honours exclusions.** Excluded subtrees are never walked. On a
     *    folder containing a source checkout this is the difference between a
     *    few hundred requests and many thousands.
     *  - **The cursor is taken first.** Anything that changes while we are
     *    enumerating then arrives as an event afterwards, rather than falling
     *    into the gap between the walk and the cursor.
     */
    async seed(signal?: AbortSignal): Promise<void> {
        const pairId = this.pair.id;
        this.folderPathsCache = null;
        const resuming =
            !!this.pair.treeEventScopeId && !this.pair.seeded && this.db.countRemoteNodes(pairId) > 0;

        if (!resuming) {
            logger.info(`Seeding remote tree for pair ${pairId}`);
            this.db.clearRemoteNodes(pairId);

            const root = await this.client.getNode(this.pair.remoteUid);
            const scopeId = root.treeEventScopeId;

            let cursor: string | null = null;
            for await (const event of this.client.iterateEvents(scopeId, undefined, signal)) {
                cursor = event.eventId;
            }

            // The root is stored so the frontier logic can treat it like any
            // other folder. snapshot() walks down from it, so it never appears
            // as an entry in its own right.
            this.db.upsertRemoteNode(pairId, {
                uid: this.pair.remoteUid,
                parentUid: null,
                name: '',
                type: 'folder',
                revisionUid: null,
                hash: null,
                size: 0,
                mtime: 0,
                trashed: false,
            });

            this.db.updatePair(pairId, { treeEventScopeId: scopeId, eventCursor: cursor, seeded: false });
            this.pair = { ...this.pair, treeEventScopeId: scopeId, eventCursor: cursor, seeded: false };
        } else {
            logger.info(`Resuming interrupted seed for pair ${pairId}`);
        }

        let listed = 0;
        let skipped = 0;

        while (!signal?.aborted) {
            const frontier = this.db.getUnlistedFolders(pairId);
            if (frontier.length === 0) {
                break;
            }
            const paths = this.buildFolderPaths();

            for (const folderUid of frontier) {
                if (signal?.aborted) {
                    break;
                }
                const folderPath = paths.get(folderUid);
                if (folderPath === undefined) {
                    // Orphaned by a move we have already recorded; nothing to list.
                    this.db.markChildrenListed(pairId, folderUid);
                    continue;
                }

                const rows: RemoteNodeInput[] = [];
                for await (const node of this.listChildren(folderUid, signal)) {
                    const row = toRemoteNode(node);
                    if (!row || row.trashed) {
                        continue;
                    }
                    const childPath = folderPath ? `${folderPath}/${row.name}` : row.name;
                    if (this.isExcluded(childPath)) {
                        skipped += 1;
                        continue;
                    }
                    rows.push(row);
                }

                // One commit per listed folder rather than one per child: a
                // seed writes thousands of rows, and per-row auto-commits were
                // a prepare + WAL flush apiece.
                this.db.transaction(() => {
                    for (const row of rows) {
                        this.db.upsertRemoteNode(pairId, row);
                    }
                    this.db.markChildrenListed(pairId, folderUid);
                });
                listed += 1;

                if (listed % 100 === 0) {
                    logger.info(`Pair ${pairId}: enumerated ${listed} folders (${this.db.countRemoteNodes(pairId)} nodes)`);
                    this.onProgress?.(listed, this.db.countRemoteNodes(pairId));
                }
            }
        }

        if (signal?.aborted) {
            logger.info(`Seed for pair ${pairId} interrupted after ${listed} folders; will resume`);
            return;
        }

        this.db.updatePair(pairId, { seeded: true });
        this.pair = { ...this.pair, seeded: true };
        logger.info(
            `Seeded pair ${pairId}: ${this.db.countRemoteNodes(pairId)} nodes across ${listed} folders` +
                (skipped > 0 ? `, ${skipped} excluded` : ''),
        );
    }

    /**
     * Applies pending events. Returns true if the caller should re-seed,
     * which happens when the server tells us our view is too stale to patch.
     */
    async pull(signal?: AbortSignal): Promise<{ needsReseed: boolean; changed: boolean }> {
        const scopeId = this.pair.treeEventScopeId;
        if (!scopeId || !this.pair.eventCursor) {
            return { needsReseed: true, changed: false };
        }

        const known = new Set(this.db.getRemoteNodes(this.pair.id).map((row) => row.uid));
        known.add(this.pair.remoteUid);

        let cursor = this.pair.eventCursor;
        let changed = false;

        try {
            for await (const event of this.client.iterateEvents(scopeId, cursor, signal)) {
                const outcome = await this.applyEvent(event, known);
                if (outcome === 'reseed') {
                    return { needsReseed: true, changed };
                }
                if (outcome === 'changed') {
                    changed = true;
                }
                // Only advance once the event has actually been applied, so an
                // interruption re-delivers it rather than skipping it.
                if (event.eventId && event.eventId !== 'none') {
                    cursor = event.eventId;
                    this.db.updatePair(this.pair.id, { eventCursor: cursor });
                    this.pair = { ...this.pair, eventCursor: cursor };
                }
            }
        } catch (error) {
            // A removed volume yields TreeRemove and then rethrows. Everything
            // else is a genuine failure worth surfacing.
            logger.error(`Event stream failed for pair ${this.pair.id}`, error);
            throw error;
        }

        return { needsReseed: false, changed };
    }

    private async applyEvent(event: DriveEvent, known: Set<string>): Promise<'ignored' | 'changed' | 'reseed'> {
        switch (event.type) {
            case DriveEventType.TreeRefresh:
                logger.info(`Tree refresh for pair ${this.pair.id}; re-enumerating`);
                return 'reseed';

            case DriveEventType.TreeRemove:
                logger.warn(`Remote tree for pair ${this.pair.id} was removed`);
                return 'reseed';

            case DriveEventType.FastForward:
            case DriveEventType.SharedWithMeUpdated:
                return 'ignored';

            case DriveEventType.NodeDeleted: {
                if (!known.has(event.nodeUid)) {
                    return 'ignored';
                }
                this.db.deleteRemoteNode(this.pair.id, event.nodeUid);
                known.delete(event.nodeUid);
                this.noteNodeRemoved(event.nodeUid);
                return 'changed';
            }

            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated: {
                // Whether we tracked this node *before* this event is what tells
                // a folder that has just entered our subtree apart from one that
                // was already inside it. It decides, further down, if we owe the
                // folder a catch-up enumeration.
                const wasKnown = known.has(event.nodeUid);

                // Events cover the whole volume, not just our folder. A node is
                // ours if we already track it, or if its parent is something we
                // track — which also catches nodes moved *into* the pair.
                const relevant =
                    wasKnown || (!!event.parentNodeUid && known.has(event.parentNodeUid));
                if (!relevant) {
                    return 'ignored';
                }

                if (event.isTrashed) {
                    // Trashing is not deletion: it arrives as an update, and the
                    // node keeps existing. For us it means "gone from the tree".
                    this.db.deleteRemoteNode(this.pair.id, event.nodeUid);
                    known.delete(event.nodeUid);
                    this.noteNodeRemoved(event.nodeUid);
                    return 'changed';
                }

                let node: NodeEntity;
                try {
                    node = await this.client.getNode(event.nodeUid);
                } catch (error) {
                    logger.warn(`Could not load node ${event.nodeUid}: ${error}`);
                    return 'ignored';
                }

                const row = toRemoteNode(node);
                if (!row) {
                    return 'ignored';
                }

                // A node moved out of our subtree stops being ours.
                if (row.parentUid && !known.has(row.parentUid) && row.uid !== this.pair.remoteUid) {
                    this.db.deleteRemoteNode(this.pair.id, row.uid);
                    known.delete(row.uid);
                    this.noteNodeRemoved(row.uid);
                    return 'changed';
                }

                // An event can bring a node into a path we are excluding;
                // ignoring it here keeps excluded subtrees genuinely absent.
                const paths = this.folderPaths();
                const parentPath = row.parentUid ? paths.get(row.parentUid) : '';
                if (parentPath !== undefined) {
                    const nodePath = parentPath ? `${parentPath}/${row.name}` : row.name;
                    if (this.isExcluded(nodePath)) {
                        this.db.deleteRemoteNode(this.pair.id, row.uid);
                        known.delete(row.uid);
                        this.noteNodeRemoved(row.uid);
                        return 'ignored';
                    }
                }

                this.db.upsertRemoteNode(this.pair.id, row);
                known.add(row.uid);
                if (row.type === 'folder') {
                    this.noteFolderStored(row);
                }

                // A folder that has just entered our subtree may bring
                // descendants we have never listed, whose own events arrived
                // before we knew the parent. Enumerate it once to catch up.
                // This covers a folder freshly created here (NodeCreated) *and*
                // one moved in from another device (NodeUpdated with a new
                // parent) alike — both surface as a folder we did not previously
                // track. Gating on `!wasKnown` — not the event type — is what
                // makes the move-in case work while an ordinary update of an
                // already-tracked folder does not re-list it. Re-enumerating on
                // every update would be wasteful and, under Proton's rules,
                // abusive.
                if (row.type === 'folder' && !wasKnown) {
                    await this.enumerateInto(row.uid, known);
                }
                return 'changed';
            }

            default:
                return 'ignored';
        }
    }

    private async enumerateInto(parentUid: string, known: Set<string>): Promise<void> {
        const paths = this.folderPaths();
        const queue: Array<{ uid: string; path: string }> = [{ uid: parentUid, path: paths.get(parentUid) ?? '' }];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const rows: RemoteNodeInput[] = [];
            for await (const node of this.listChildren(current.uid)) {
                const row = toRemoteNode(node);
                if (!row || row.trashed) {
                    continue;
                }
                const childPath = current.path ? `${current.path}/${row.name}` : row.name;
                if (this.isExcluded(childPath)) {
                    continue;
                }
                rows.push(row);
                known.add(row.uid);
                if (row.type === 'folder') {
                    queue.push({ uid: row.uid, path: childPath });
                }
            }
            // One commit per listed folder, not one per child row.
            this.db.transaction(() => {
                for (const row of rows) {
                    this.db.upsertRemoteNode(this.pair.id, row);
                    if (row.type === 'folder') {
                        this.noteFolderStored(row);
                    }
                }
                this.db.markChildrenListed(this.pair.id, current.uid);
            });
        }
    }

    /**
     * Materialises the stored rows into a path-keyed snapshot by walking down
     * from the pair root. Nodes whose parent chain does not reach the root are
     * dropped — they are leftovers from a move we have already handled.
     */
    snapshot(): Map<string, RemoteItem> {
        const rows = this.db.getRemoteNodes(this.pair.id);
        const byParent = new Map<string, typeof rows>();
        for (const row of rows) {
            if (row.trashed) {
                continue;
            }
            const key = row.parent_uid ?? '';
            const list = byParent.get(key) ?? [];
            list.push(row);
            byParent.set(key, list);
        }

        const result = new Map<string, RemoteItem>();
        const walk = (parentUid: string, prefix: string): void => {
            for (const row of byParent.get(parentUid) ?? []) {
                const relative = prefix ? `${prefix}/${row.name}` : row.name;
                result.set(relative, {
                    path: relative,
                    type: row.type as NodeKind,
                    uid: row.uid,
                    parentUid: row.parent_uid,
                    revisionUid: row.revision_uid,
                    hash: row.hash,
                    size: row.size,
                    mtime: row.mtime,
                    trashed: false,
                });
                if (row.type === 'folder') {
                    walk(row.uid, relative);
                }
            }
        };
        walk(this.pair.remoteUid, '');
        return result;
    }
}
