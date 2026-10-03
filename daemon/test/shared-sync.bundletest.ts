/** Shared-folder sync against temporary SQLite and an entirely offline SDK stand-in. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DriveEventType, MemberRole, NodeType, type DriveEvent, type NodeEntity,
    type ProtonDriveClient } from '@protontech/drive-sdk';
import type { DriveSession } from '../src/drive/session.js';
import type { SyncDatabase as SQLiteDb } from '../src/engine/db.js';
import type { Pair } from '../src/engine/types.js';

// Config captures XDG paths at import time. Defer daemon runtime imports so
// even SyncManager's default database never touches the user's real state.
let SyncDatabase: typeof import('../src/engine/db.js').SyncDatabase;
let PairSyncer: typeof import('../src/engine/pair.js').PairSyncer;
let SyncManager: typeof import('../src/engine/manager.js').SyncManager;
let registerFolderRefresh: typeof import('../src/drive/folders.js').registerFolderRefresh;
let testDataHome: string;
const previousDataHome = process.env.XDG_DATA_HOME;
before(async () => {
    testDataHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-shared-manager-'));
    process.env.XDG_DATA_HOME = testDataHome;
    ({ SyncDatabase } = await import('../src/engine/db.js'));
    ({ PairSyncer } = await import('../src/engine/pair.js'));
    ({ SyncManager } = await import('../src/engine/manager.js'));
    ({ registerFolderRefresh } = await import('../src/drive/folders.js'));
});
after(async () => {
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
    await fsp.rm(testDataHome, { recursive: true, force: true });
});

const SHARED_ROOT = 'shared~trips';
function folder(uid: string, parentUid: string | undefined, name: string,
    role?: MemberRole, mtime = 1_000): NodeEntity {
    return { uid, parentUid, name: { ok: true, value: name }, type: NodeType.Folder,
        modificationTime: new Date(mtime), folder: { claimedModificationTime: new Date(mtime) },
        directRole: role, treeEventScopeId: 'shared' } as NodeEntity;
}

class OfflineDrive {
    readonly nodes = new Map<string, NodeEntity>([
        [SHARED_ROOT, folder(SHARED_ROOT, 'inaccessible-parent', 'Trips', MemberRole.Editor)],
        ['shared~viewer', folder('shared~viewer', 'inaccessible-parent', 'Read only', MemberRole.Viewer)],
    ]);
    readonly contents = new Map<string, Buffer>();
    readonly events: DriveEvent[] = [];
    readonly enumerated: string[] = [];
    readonly eventRequests: Array<{ scope: string; cursor?: string }> = [];
    readonly uploads: string[] = [];
    readonly downloads: string[] = [];
    readonly trashed: string[] = [];
    readonly scopes: string[] = [];
    readonly cache = new Map<string, NodeEntity>();
    readonly refreshes: string[][] = [];
    missing = new Set<string>();
    private nextNode = 0;

    asClient(): ProtonDriveClient {
        const client = this as unknown as ProtonDriveClient;
        registerFolderRefresh(client, async uids => {
            this.refreshes.push([...uids]);
            for (const uid of uids) this.cache.delete(uid);
        });
        return client;
    }
    private cachedNode(uid: string): NodeEntity | undefined {
        const cached = this.cache.get(uid);
        if (cached) return cached;
        const node = this.missing.has(uid) ? undefined : this.nodes.get(uid);
        if (node) this.cache.set(uid, node);
        return node;
    }
    async getMyFilesRootFolder() { return folder('own~root', undefined, 'My Files', MemberRole.Admin); }
    async getNode(uid: string): Promise<NodeEntity> {
        const node = this.cachedNode(uid);
        assert.ok(node, `offline node ${uid} exists`);
        return node;
    }
    async getNodeHierarchy(uid: string): Promise<NodeEntity[]> {
        const hierarchy: NodeEntity[] = [];
        let current = this.cachedNode(uid);
        while (current) {
            hierarchy.unshift(current);
            current = current.parentUid ? this.cachedNode(current.parentUid) : undefined;
        }
        return hierarchy;
    }
    async *iterateNodes(uids: string[]) {
        for (const uid of uids) {
            const node = this.cachedNode(uid);
            if (!node) yield { missingUid: uid };
            else yield node;
        }
    }
    async *iterateFolderChildrenNodeUids(parentUid: string) {
        this.enumerated.push(parentUid);
        for (const node of this.nodes.values()) {
            if (node.parentUid === parentUid && !node.trashTime) yield node.uid;
        }
    }
    async *iterateEvents(scope: string, cursor?: string) {
        this.eventRequests.push({ scope, cursor });
        if (cursor === undefined) {
            yield { type: DriveEventType.FastForward, treeEventScopeId: scope,
                eventId: `e${this.events.length}` } as DriveEvent;
            return;
        }
        for (const event of this.events.slice(Number(cursor.slice(1)))) {
            if ('nodeUid' in event) this.cache.delete(event.nodeUid);
            yield event;
        }
    }
    emit(event: Omit<DriveEvent, 'eventId' | 'treeEventScopeId'>): void {
        this.events.push({ ...event, treeEventScopeId: 'shared', eventId: `e${this.events.length + 1}` } as DriveEvent);
    }
    nodeEvent(node: NodeEntity, type = DriveEventType.NodeUpdated): void {
        this.emit({ type, nodeUid: node.uid, parentNodeUid: node.parentUid, isTrashed: false,
            isShared: true } as Omit<DriveEvent, 'eventId' | 'treeEventScopeId'>);
    }
    putFile(uid: string, name: string, bytes: string | Buffer, mtime: number,
        revisionUid = `${uid}-revision`, parentUid = SHARED_ROOT): NodeEntity {
        const content = Buffer.from(bytes);
        this.contents.set(uid, content);
        const node = { uid, parentUid, name: { ok: true, value: name }, type: NodeType.File,
            modificationTime: new Date(mtime), treeEventScopeId: 'shared',
            activeRevision: { uid: revisionUid, claimedSize: content.length, storageSize: content.length,
                claimedDigests: { sha1: createHash('sha1').update(content).digest('hex') },
                claimedModificationTime: new Date(mtime) } } as NodeEntity;
        this.nodes.set(uid, node);
        return node;
    }
    async createFolder(parentUid: string, name: string, mtime = new Date()) {
        const node = folder(`shared~new${++this.nextNode}`, parentUid, name, undefined, mtime.getTime());
        this.nodes.set(node.uid, node);
        this.nodeEvent(node, DriveEventType.NodeCreated);
        return node;
    }
    async getFileDownloader(uid: string) {
        this.downloads.push(uid);
        const content = this.contents.get(uid)!;
        return {
            getClaimedSizeInBytes: () => content.length,
            downloadToStream: (stream: WritableStream, progress: (done: number) => void) => {
                const completion = (async () => {
                    const writer = stream.getWriter();
                    await writer.write(content);
                    await writer.close();
                    progress(content.length);
                })();
                return { completion: () => completion, isDownloadCompleteWithSignatureIssues: () => false };
            },
        };
    }
    private uploader(uid: string, parentUid: string, name: string, metadata: { modificationTime: Date }) {
        return {
            uploadFromStream: async (stream: ReadableStream, _thumbnail: unknown[], progress: (done: number) => void) => {
                const reader = stream.getReader();
                const chunks: Uint8Array[] = [];
                while (true) {
                    const result = await reader.read();
                    if (result.done) break;
                    chunks.push(result.value);
                }
                const content = Buffer.concat(chunks);
                const existed = this.nodes.has(uid);
                const revision = `${uid}-revision-${this.events.length}`;
                const node = this.putFile(uid, name, content, metadata.modificationTime.getTime(), revision, parentUid);
                this.uploads.push(uid);
                this.nodeEvent(node, existed ? DriveEventType.NodeUpdated : DriveEventType.NodeCreated);
                progress(content.length);
                return { completion: async () => ({ nodeUid: uid, nodeRevisionUid: revision }) };
            },
        };
    }
    async getFileUploader(parentUid: string, name: string, metadata: { modificationTime: Date }) {
        return this.uploader(`shared~new${++this.nextNode}`, parentUid, name, metadata);
    }
    async getFileRevisionUploader(uid: string, metadata: { modificationTime: Date }) {
        const node = await this.getNode(uid);
        assert.ok(node.name.ok);
        return this.uploader(uid, node.parentUid!, node.name.value, metadata);
    }
    async *trashNodes(uids: string[]) {
        for (const uid of uids) {
            this.trashed.push(uid);
            yield { uid, ok: true };
        }
    }
    async getEventScheduler() {
        return { addScope: (scope: string) => this.scopes.push(scope), removeScope() {} };
    }
}

function pairFor(localPath: string): Pair {
    return { id: 'p1', localPath, remoteUid: SHARED_ROOT, remotePath: '/Shared with me/Trips',
        enabled: true, excludes: [], treeEventScopeId: null,
        eventCursor: null, seeded: false, createdAt: 0, lastSyncAt: null };
}

async function withPair(run: (db: SQLiteDb, pair: Pair, drive: OfflineDrive,
    syncer: InstanceType<typeof PairSyncer>) => Promise<void>): Promise<void> {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-shared-sync-'));
    const db = new SyncDatabase(path.join(directory, 'state.sqlite'));
    try {
        const pair = pairFor(path.join(directory, 'Trips'));
        await fsp.mkdir(pair.localPath);
        db.insertPair(pair);
        const drive = new OfflineDrive();
        const syncer = new PairSyncer(pair, db, drive.asClient(), () => {}, () => {});
        await run(db, pair, drive, syncer);
    } finally {
        db.close();
        await fsp.rm(directory, { recursive: true, force: true });
    }
}

test('editable shares seed and sync files both ways, then use events without another tree walk', async () => {
    await withPair(async (db, pair, drive, syncer) => {
        drive.putFile('shared~plan', 'plan.txt', 'remote itinerary', 2_000);
        await fsp.writeFile(path.join(pair.localPath, 'notes.txt'), 'local notes');
        await fsp.mkdir(path.join(pair.localPath, 'Receipts'));
        await syncer.sync();
        assert.equal(syncer.status, 'idle', syncer.error ?? 'sync completed');
        assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'remote itinerary');
        const notesUid = db.getBase(pair.id).get('notes.txt')!.remoteUid;
        assert.equal(drive.contents.get(notesUid)!.toString(), 'local notes');
        assert.equal(db.getBase(pair.id).get('Receipts')?.type, 'folder');
        assert.equal(db.getPair(pair.id)?.treeEventScopeId, 'shared');
        assert.equal(db.getPair(pair.id)?.seeded, true);
        assert.deepEqual(drive.enumerated, [SHARED_ROOT]);

        const edited = drive.putFile('shared~plan', 'plan.txt', 'remote itinerary updated', 3_000, 'revision-two');
        drive.nodeEvent(edited);
        await fsp.writeFile(path.join(pair.localPath, 'notes.txt'), 'local notes updated');
        await syncer.sync();
        assert.equal(syncer.status, 'idle', syncer.error ?? 'sync completed');
        assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'remote itinerary updated');
        assert.equal(drive.contents.get(notesUid)!.toString(), 'local notes updated');
        assert.equal(db.getBase(pair.id).get('plan.txt')?.remoteRevisionUid, 'revision-two');
        // Newly uploaded folders need one catch-up listing; the pair root
        // and previously known folders must never be enumerated again.
        assert.equal(drive.enumerated.filter(uid => uid === SHARED_ROOT).length, 1);
        const enumerations = [...drive.enumerated];
        const transferCount = drive.uploads.length + drive.downloads.length;
        await syncer.sync();
        await syncer.sync();
        assert.equal(syncer.status, 'idle', syncer.error ?? 'sync completed');
        assert.deepEqual(drive.enumerated, enumerations);
        assert.equal(drive.uploads.length + drive.downloads.length, transferCount);
        assert.ok(drive.eventRequests.slice(1).every(request => request.scope === 'shared' && request.cursor));
        assert.deepEqual(drive.trashed, []);
    });
});

test('cached editing access cannot hide a share becoming read-only or inaccessible', async () => {
    for (const access of ['viewer', 'missing']) {
        await withPair(async (db, pair, drive, syncer) => {
            drive.putFile('shared~plan', 'plan.txt', 'original itinerary', 2_000);
            await syncer.sync();
            assert.equal(syncer.status, 'idle', syncer.error ?? 'sync completed');
            const base = db.getBase(pair.id);
            const history = db.listEvents();
            await fsp.writeFile(path.join(pair.localPath, 'plan.txt'), 'unsynced local edit');
            if (access === 'missing') drive.missing.add(SHARED_ROOT);
            else drive.nodes.set(SHARED_ROOT,
                folder(SHARED_ROOT, 'inaccessible-parent', 'Trips', MemberRole.Viewer));
            assert.equal(drive.cache.get(SHARED_ROOT)?.directRole, MemberRole.Editor);
            const refreshCount = drive.refreshes.length;
            await syncer.sync();
            assert.equal(syncer.status, 'error');
            assert.match(syncer.error!, access === 'viewer' ? /read-only/ : /no longer available/);
            assert.ok(drive.refreshes.length > refreshCount);
            assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'unsynced local edit');
            assert.deepEqual(db.getBase(pair.id), base);
            assert.deepEqual(db.listEvents(), history);
            assert.deepEqual(drive.uploads, []);
            assert.deepEqual(drive.trashed, []);
        });
    }
});

test('shared-root deletion, trash, and lost volume access preserve local files and durable state', async () => {
    const rootEvents = [
        { type: DriveEventType.NodeDeleted, nodeUid: SHARED_ROOT },
        { type: DriveEventType.NodeUpdated, nodeUid: SHARED_ROOT, parentNodeUid: 'inaccessible-parent',
            isTrashed: true, isShared: true },
        { type: DriveEventType.TreeRemove },
    ];
    for (const event of rootEvents) {
        await withPair(async (db, pair, drive, syncer) => {
            drive.putFile('shared~plan', 'plan.txt', 'original itinerary', 2_000);
            await syncer.sync();
            const base = db.getBase(pair.id);
            const history = db.listEvents();
            if (event.type === DriveEventType.NodeDeleted) drive.missing.add(SHARED_ROOT);
            if (event.type === DriveEventType.NodeUpdated) {
                drive.nodes.set(SHARED_ROOT, { ...drive.nodes.get(SHARED_ROOT)!, trashTime: new Date() });
            }
            drive.emit(event as Omit<DriveEvent, 'eventId' | 'treeEventScopeId'>);
            await syncer.sync();
            assert.equal(syncer.status, 'error');
            assert.match(syncer.error!, /local files are kept/);
            assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'original itinerary');
            assert.deepEqual(db.getBase(pair.id), base);
            assert.deepEqual(db.listEvents(), history);
            assert.ok(db.getRemoteNodes(pair.id).some(node => node.uid === SHARED_ROOT));
            assert.deepEqual(drive.trashed, []);

            if (event.type !== DriveEventType.TreeRemove) {
                drive.missing.delete(SHARED_ROOT);
                const root = folder(SHARED_ROOT, 'inaccessible-parent', 'Trips', MemberRole.Editor);
                drive.nodes.set(SHARED_ROOT, root);
                drive.nodeEvent(root);
                await syncer.sync();
                assert.equal(syncer.status, 'idle', syncer.error ?? 'sync completed');
                assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'original itinerary');
                assert.deepEqual(db.getBase(pair.id), base);
                assert.equal(db.getPair(pair.id)?.eventCursor, 'e2');
                assert.deepEqual(drive.enumerated, [SHARED_ROOT]);
                assert.equal(drive.downloads.length, 1);
            }
        });
    }
});

test('missing or unexpectedly empty shared-pair local roots never trash remote copies', async () => {
    for (const missing of [true, false]) {
        await withPair(async (db, pair, drive, syncer) => {
            drive.putFile('shared~plan', 'plan.txt', 'original itinerary', 2_000);
            await syncer.sync();
            const base = db.getBase(pair.id);
            if (missing) await fsp.rm(pair.localPath, { recursive: true });
            else await fsp.rm(path.join(pair.localPath, 'plan.txt'));
            await syncer.sync();
            assert.equal(syncer.status, 'error');
            assert.match(syncer.error!, missing ? /is missing/ : /is empty/);
            assert.deepEqual(db.getBase(pair.id), base);
            assert.deepEqual(drive.trashed, []);
            if (missing) await assert.rejects(fsp.stat(pair.localPath), { code: 'ENOENT' });
        });
    }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, 'offline first sync finished within two seconds');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test('manager rejects viewer pair creation and retargeting, and registers a new shared scope after seeding', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-shared-targets-'));
    const drive = new OfflineDrive();
    const session = { isLoggedIn: () => true, getClient: () => drive.asClient() } as DriveSession;
    const manager = new SyncManager(session);
    try {
        await manager.start();
        await assert.rejects(manager.addPair({ localPath: path.join(directory, 'Read only'),
            remoteUid: 'shared~viewer', remotePath: '/Read only' }), /read-only/);
        assert.deepEqual(manager.listPairs(), []);

        drive.putFile('shared~plan', 'plan.txt', 'original itinerary', 2_000);
        const pair = await manager.addPair({ localPath: path.join(directory, 'Trips'),
            remoteUid: SHARED_ROOT, remotePath: '/incorrect caller path' });
        await waitUntil(() => drive.scopes.includes('shared') && manager.getStatus().pairs[0]?.status === 'idle');
        assert.equal(manager.listPairs()[0].remotePath, '/Shared with me/Trips');
        assert.equal(manager.listPairs()[0].seeded, true);
        assert.ok(drive.scopes.includes('shared'));
        assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'original itinerary');

        const persisted = manager.listPairs()[0];
        const history = manager.listHistory({});
        await assert.rejects(manager.updatePair(pair.id, { remoteUid: 'shared~viewer',
            remotePath: '/Read only', localPath: path.join(directory, 'Retarget') }), /read-only/);
        assert.deepEqual(manager.listPairs(), [persisted]);
        assert.deepEqual(manager.listHistory({}), history);
        await assert.rejects(fsp.stat(path.join(directory, 'Retarget')), { code: 'ENOENT' });
        assert.equal(await fsp.readFile(path.join(pair.localPath, 'plan.txt'), 'utf8'), 'original itinerary');
        assert.deepEqual(drive.trashed, []);
    } finally {
        await manager.stop();
        await fsp.rm(directory, { recursive: true, force: true });
    }
});
