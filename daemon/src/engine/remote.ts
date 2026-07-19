import {
    DriveEventType,
    NodeType,
    type DriveEvent,
    type NodeEntity,
    type ProtonDriveClient,
} from '@protontech/drive-sdk';

import { getLogger } from '../log.js';
import type { RemoteNodeInput, SyncDatabase } from './db.js';
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
    constructor(
        private readonly db: SyncDatabase,
        private readonly client: ProtonDriveClient,
        private pair: Pair,
    ) {}

    setPair(pair: Pair): void {
        this.pair = pair;
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

    /**
     * One-time full enumeration, used on first sync and after a TreeRefresh.
     * Also establishes the event scope and starting cursor.
     */
    async seed(signal?: AbortSignal): Promise<void> {
        logger.info(`Seeding remote tree for pair ${this.pair.id}`);
        this.db.clearRemoteNodes(this.pair.id);

        const root = await this.client.getNode(this.pair.remoteUid);
        const scopeId = root.treeEventScopeId;

        const queue: string[] = [this.pair.remoteUid];
        let count = 0;

        while (queue.length > 0) {
            const parentUid = queue.shift()!;
            for await (const node of this.listChildren(parentUid, signal)) {
                const row = toRemoteNode(node);
                if (!row || row.trashed) {
                    continue;
                }
                this.db.upsertRemoteNode(this.pair.id, row);
                count += 1;
                if (row.type === 'folder') {
                    queue.push(row.uid);
                }
            }
        }

        // Establish the cursor. With no cursor the SDK yields a single
        // FastForward carrying the current event id and no history — which is
        // exactly the bootstrap we want, since we just enumerated everything.
        let cursor: string | null = null;
        for await (const event of this.client.iterateEvents(scopeId, undefined, signal)) {
            cursor = event.eventId;
        }

        this.db.updatePair(this.pair.id, { treeEventScopeId: scopeId, eventCursor: cursor });
        this.pair = { ...this.pair, treeEventScopeId: scopeId, eventCursor: cursor };
        logger.info(`Seeded ${count} remote node(s) for pair ${this.pair.id}`);
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
                return 'changed';
            }

            case DriveEventType.NodeCreated:
            case DriveEventType.NodeUpdated: {
                // Events cover the whole volume, not just our folder. A node is
                // ours if we already track it, or if its parent is something we
                // track — which also catches nodes moved *into* the pair.
                const relevant =
                    known.has(event.nodeUid) || (!!event.parentNodeUid && known.has(event.parentNodeUid));
                if (!relevant) {
                    return 'ignored';
                }

                if (event.isTrashed) {
                    // Trashing is not deletion: it arrives as an update, and the
                    // node keeps existing. For us it means "gone from the tree".
                    this.db.deleteRemoteNode(this.pair.id, event.nodeUid);
                    known.delete(event.nodeUid);
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
                    return 'changed';
                }

                this.db.upsertRemoteNode(this.pair.id, row);
                known.add(row.uid);

                // A newly visible folder may bring descendants we have never
                // listed, and events for those arrived before we knew the
                // parent. Enumerate it once to catch up.
                if (row.type === 'folder' && event.type === DriveEventType.NodeCreated) {
                    await this.enumerateInto(row.uid, known);
                }
                return 'changed';
            }

            default:
                return 'ignored';
        }
    }

    private async enumerateInto(parentUid: string, known: Set<string>): Promise<void> {
        const queue = [parentUid];
        while (queue.length > 0) {
            const current = queue.shift()!;
            for await (const node of this.listChildren(current)) {
                const row = toRemoteNode(node);
                if (!row || row.trashed) {
                    continue;
                }
                this.db.upsertRemoteNode(this.pair.id, row);
                known.add(row.uid);
                if (row.type === 'folder') {
                    queue.push(row.uid);
                }
            }
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
