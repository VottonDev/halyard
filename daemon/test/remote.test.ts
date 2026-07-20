/**
 * Runs under Bun (`bun test`): no `node:sqlite` here. `RemoteTree` is exercised
 * against an in-memory fake of the handful of `SyncDatabase` methods it touches
 * and a scripted stand-in for the Drive client, so the event-handling logic can
 * be tested without a live account or a real database.
 *
 * The focus is `applyEvent`'s catch-up enumeration: a folder that *enters* the
 * pair from another device brings pre-existing descendants whose own events
 * arrived before we knew the parent, so the folder has to be listed once to
 * recover them. That entry can arrive as `NodeUpdated` (a move) just as much as
 * `NodeCreated` (a fresh folder) — the gate is "was this folder tracked before
 * the event", not the event type.
 */
import { describe, expect, test } from 'bun:test';

import { DriveEventType, NodeType } from '@protontech/drive-sdk';
import type { DriveEvent, NodeEntity, ProtonDriveClient } from '@protontech/drive-sdk';

import type { RemoteNodeInput, RemoteNodeRow, SyncDatabase } from '../src/engine/db.js';
import { RemoteTree } from '../src/engine/remote.js';
import type { Pair } from '../src/engine/types.js';

const ROOT = 'ROOT';

/** The subset of `SyncDatabase` that `pull()`/`applyEvent()`/`snapshot()` reach. */
class FakeDb {
    readonly rows = new Map<string, RemoteNodeRow>();

    private key(pairId: string, uid: string): string {
        return `${pairId}::${uid}`;
    }

    getRemoteNodes(pairId: string): RemoteNodeRow[] {
        return [...this.rows.values()].filter((row) => row.pair_id === pairId);
    }

    upsertRemoteNode(pairId: string, node: RemoteNodeInput): void {
        this.rows.set(this.key(pairId, node.uid), {
            pair_id: pairId,
            uid: node.uid,
            parent_uid: node.parentUid,
            name: node.name,
            type: node.type,
            revision_uid: node.revisionUid,
            hash: node.hash,
            size: node.size,
            mtime: node.mtime,
            trashed: node.trashed ? 1 : 0,
        });
    }

    deleteRemoteNode(pairId: string, uid: string): void {
        this.rows.delete(this.key(pairId, uid));
    }

    // Enumeration marks the frontier and pull persists its cursor; neither
    // matters to what these tests assert.
    markChildrenListed(): void {}
    updatePair(): void {}

    // The in-memory map needs no atomicity; run the batch directly.
    transaction<T>(fn: () => T): T {
        return fn();
    }
}

/** A Drive client whose tree and event stream are scripted per test. */
class MockClient {
    readonly nodes = new Map<string, NodeEntity>();
    readonly children = new Map<string, string[]>();
    events: DriveEvent[] = [];
    /** Every folder we were asked to list — the signal that enumeration ran. */
    readonly listCalls: string[] = [];

    async getNode(uid: string): Promise<NodeEntity> {
        const node = this.nodes.get(uid);
        if (!node) {
            throw new Error(`unknown node ${uid}`);
        }
        return node;
    }

    async *iterateFolderChildrenNodeUids(parentUid: string): AsyncGenerator<string> {
        this.listCalls.push(parentUid);
        for (const uid of this.children.get(parentUid) ?? []) {
            yield uid;
        }
    }

    async *iterateNodes(uids: string[]): AsyncGenerator<NodeEntity> {
        for (const uid of uids) {
            const node = this.nodes.get(uid);
            if (node) {
                yield node;
            }
        }
    }

    async *iterateEvents(): AsyncGenerator<DriveEvent> {
        for (const event of this.events) {
            yield event;
        }
    }
}

function folderNode(uid: string, parentUid: string | null, name: string, mtime = 0): NodeEntity {
    return {
        uid,
        parentUid: parentUid ?? undefined,
        name: { ok: true, value: name },
        type: NodeType.Folder,
        modificationTime: new Date(mtime),
        folder: { claimedModificationTime: new Date(mtime) },
        activeRevision: undefined,
        trashTime: undefined,
    } as unknown as NodeEntity;
}

function fileNode(uid: string, parentUid: string, name: string, mtime = 1000): NodeEntity {
    return {
        uid,
        parentUid,
        name: { ok: true, value: name },
        type: NodeType.File,
        modificationTime: new Date(mtime),
        activeRevision: {
            ok: true,
            value: {
                uid: `${uid}-rev`,
                claimedDigests: { sha1: `sha-${uid}` },
                claimedSize: 10,
                storageSize: 12,
                claimedModificationTime: new Date(mtime),
            },
        },
        trashTime: undefined,
    } as unknown as NodeEntity;
}

function nodeEvent(
    type: DriveEventType.NodeCreated | DriveEventType.NodeUpdated,
    nodeUid: string,
    parentNodeUid: string,
    eventId = 'e1',
): DriveEvent {
    return {
        type,
        nodeUid,
        parentNodeUid,
        isTrashed: false,
        isShared: false,
        treeEventScopeId: 'scope',
        eventId,
    } as unknown as DriveEvent;
}

function makePair(): Pair {
    return {
        id: 'p1',
        localPath: '/home/u/Sync',
        remoteUid: ROOT,
        remotePath: '/Sync',
        enabled: true,
        excludes: [],
        treeEventScopeId: 'scope',
        eventCursor: 'c0',
        seeded: true,
        createdAt: 0,
        lastSyncAt: null,
    };
}

function makeTree(db: FakeDb, client: MockClient): RemoteTree {
    const tree = new RemoteTree(db as unknown as SyncDatabase, client as unknown as ProtonDriveClient, makePair());
    // Every scenario starts from a seeded pair whose root is already stored,
    // matching the post-seed state pull() runs against.
    db.upsertRemoteNode('p1', {
        uid: ROOT,
        parentUid: null,
        name: '',
        type: 'folder',
        revisionUid: null,
        hash: null,
        size: 0,
        mtime: 0,
        trashed: false,
    });
    return tree;
}

describe('RemoteTree.applyEvent catch-up enumeration', () => {
    test('a folder moved in from another device pulls in its pre-existing descendants', async () => {
        // Folder F, holding file C, was outside the pair and moves under the
        // root. The move is a NodeUpdated (F already existed; only its parent
        // changed). C's own creation event predates F being known, so it is not
        // replayed — only enumeration can recover it.
        const db = new FakeDb();
        const client = new MockClient();
        const tree = makeTree(db, client);

        client.nodes.set('F', folderNode('F', ROOT, 'F'));
        client.nodes.set('C', fileNode('C', 'F', 'C.txt'));
        client.children.set('F', ['C']);
        client.events = [nodeEvent(DriveEventType.NodeUpdated, 'F', ROOT)];

        const result = await tree.pull();

        expect(result.needsReseed).toBe(false);
        expect(result.changed).toBe(true);

        const snapshot = tree.snapshot();
        expect([...snapshot.keys()].sort()).toEqual(['F', 'F/C.txt']);
        // The folder was listed exactly once to catch up.
        expect(client.listCalls).toEqual(['F']);
    });

    test('an ordinary update of an already-tracked folder does not re-enumerate', async () => {
        // F is already inside the pair. A plain metadata update must apply, but
        // must not re-list F — gratuitous enumeration is both wasteful and, under
        // Proton's rules, treated as abuse.
        const db = new FakeDb();
        const client = new MockClient();
        const tree = makeTree(db, client);

        db.upsertRemoteNode('p1', {
            uid: 'F',
            parentUid: ROOT,
            name: 'F',
            type: 'folder',
            revisionUid: null,
            hash: null,
            size: 0,
            mtime: 0,
            trashed: false,
        });

        // getNode reports a bumped mtime, so we can tell the update was applied.
        client.nodes.set('F', folderNode('F', ROOT, 'F', 5000));
        // A child exists on Drive; if F were wrongly re-listed it would surface.
        client.nodes.set('C', fileNode('C', 'F', 'C.txt'));
        client.children.set('F', ['C']);
        client.events = [nodeEvent(DriveEventType.NodeUpdated, 'F', ROOT)];

        await tree.pull();

        const snapshot = tree.snapshot();
        expect(snapshot.get('F')?.mtime).toBe(5000); // update applied
        expect(snapshot.has('F/C.txt')).toBe(false); // but no descendants pulled
        expect(client.listCalls).toEqual([]); // and no listing at all
    });

    test('a newly created folder still enumerates its descendants', async () => {
        // The pre-existing NodeCreated behaviour must survive the gate change:
        // a folder created here is also "not previously known", so it enumerates.
        const db = new FakeDb();
        const client = new MockClient();
        const tree = makeTree(db, client);

        client.nodes.set('G', folderNode('G', ROOT, 'G'));
        client.nodes.set('D', fileNode('D', 'G', 'D.txt'));
        client.children.set('G', ['D']);
        client.events = [nodeEvent(DriveEventType.NodeCreated, 'G', ROOT)];

        await tree.pull();

        const snapshot = tree.snapshot();
        expect([...snapshot.keys()].sort()).toEqual(['G', 'G/D.txt']);
        expect(client.listCalls).toEqual(['G']);
    });
});
