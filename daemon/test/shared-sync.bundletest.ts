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

test('Trash verifies real pinned SDK batch replies through its cache, with all HTTP writes mocked', async () => {
    const { DriveSession } = await import('../src/drive/session.js');
    const { TrashRecovery } = await import('../src/drive/trash.js');
    const { MemoryCache } = await import('@protontech/drive-sdk/dist/cache/memoryCache.js');
    const { DriveAPIService } = await import('@protontech/drive-sdk/dist/internal/apiService/apiService.js');
    const { SDKEvents } = await import('@protontech/drive-sdk/dist/internal/sdkEvents.js');
    const { PhotosNodesAPIService, PhotosNodesCache, PhotosNodesAccess, PhotosNodesManagement } =
        await import('@protontech/drive-sdk/dist/internal/photos/nodes.js');
    type PhotoNode = import('@protontech/drive-sdk/dist/internal/photos/interface.js').DecryptedPhotoNode;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const telemetry = { getLogger: () => logger, recordMetric() {} };
    const entitiesCache = new MemoryCache<string>();
    const cache = new PhotosNodesCache(logger, entitiesCache);
    const related = Array.from({ length: 100 }, (_, i) => `photos~asset-${i}`);
    const makeNode = (uid: string, type = NodeType.Photo) => ({
        uid, type, parentUid: 'photos~root', name: { ok: true, value: uid },
        creationTime: new Date('2026-10-01'), modificationTime: new Date('2026-10-01'),
        trashTime: new Date('2026-10-02'), directRole: MemberRole.Admin,
        isShared: false, isStale: false,
        photo: { captureTime: new Date('2026-10-01'), tags: [], albums: [], relatedPhotoNodeUids: [] },
    } as unknown as PhotoNode);
    const main = makeNode('photos~main'); main.photo!.relatedPhotoNodeUids = related;
    const remote = new Map([main, ...related.map(uid => makeNode(uid))].map(node => [node.uid, node]));
    const root = makeNode('photos~root', NodeType.Folder); root.trashTime = undefined;
    remote.set(root.uid, root);
    const requests: string[][] = [];
    const http = {
        async fetchJson(request: import('@protontech/drive-sdk').ProtonDriveHTTPClientJsonRequest) {
            assert.equal(request.method, 'PUT');
            assert.equal(request.url, 'https://offline.invalid/drive/v2/volumes/photos/trash/restore_multiple');
            request.signal?.throwIfAborted();
            const ids = (request.json as { LinkIDs: string[] }).LinkIDs;
            requests.push(ids);
            for (const id of ids) if (!['asset-0', 'asset-99'].includes(id)) remote.get(`photos~${id}`)!.trashTime = undefined;
            // Deliberately omit successful responses, including an unapplied
            // item in the second batch. The SDK synthesises ok for these.
            return Response.json({ Code: 1000, Responses: ids.includes('asset-0')
                ? [{ LinkID: 'asset-0', Response: { Code: 2001, Error: 'Permission denied' } }] : [] });
        },
        async fetchBlob(): Promise<Response> { throw new Error('Unexpected blob request'); },
    };
    const api = new PhotosNodesAPIService(logger, new DriveAPIService(telemetry,
        new SDKEvents(telemetry), http, 'https://offline.invalid', 'en'), undefined);
    const access = new PhotosNodesAccess(telemetry, api, cache, {} as never, {} as never, {} as never);
    // Only metadata decryption/loading is a fixture. The SDK's cache reads,
    // stale-node handling, management, batching and HTTP response mapping run.
    (access as unknown as { loadNode(uid: string): Promise<{ node: PhotoNode }> }).loadNode = async uid => {
        const node = structuredClone(remote.get(uid)!);
        assert.ok(node, `Missing fixture ${uid}`);
        await cache.setNode(node);
        return { node };
    };
    const management = new PhotosNodesManagement(api, {} as never, {} as never, access);
    const client = {
        async *iterateTrashedNodes() {
            for (const node of remote.values()) if (node.trashTime) { await cache.setNode(node); yield node; }
        },
        getNode: (uid: string) => access.getNode(uid),
        restoreNodes: (uids: string[], signal?: AbortSignal) => management.restoreNodes(uids, signal),
    };
    const session = { getClient: () => client, caches: { entitiesCache } } as unknown as DriveSession;
    const recovery = new TrashRecovery(async () => client,
        uids => DriveSession.prototype.refreshNodes.call(session, uids), async () => {});
    try {
        await recovery.list({ source: 'photos', requestId: 'sdk' });
        // An old live cache entry must not bypass restoration of this freshly
        // listed trashed node, or hide its companions.
        await cache.setNode({ ...main, trashTime: undefined, photo: { ...main.photo!, relatedPhotoNodeUids: [] } });
        recovery.start('photos', [main.uid]);
        for (let i = 0; i < 500 && recovery.listRestores()[0].status === 'running'; i++) {
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        const job = recovery.listRestores()[0];
        assert.equal(job.status, 'completed');
        assert.deepEqual(requests.map(ids => ids.length), [100, 1]);
        assert.equal(job.results.filter(result => result.status === 'restored').length, 99);
        assert.equal(job.results.find(result => result.uid === 'photos~asset-0')!.status, 'failed');
        assert.equal(job.results.find(result => result.uid === 'photos~asset-99')!.status, 'unknown');
        assert.match(job.results.find(result => result.uid === 'photos~asset-99')!.error!, /still in Trash/);
        const stillCached = await Array.fromAsync(entitiesCache.iterateEntitiesByTag('nodeTrashed'));
        assert.deepEqual(stillCached.map(row => row.key), ['node-photos~asset-0']);
    } finally { await recovery.stop(true); }
});

test('the D-Bus Trash boundary rejects malformed requests and blocks new work throughout sign-out', async () => {
    const { HalyardInterface } = await import('../src/ipc/dbus.js');
    const { TrashRecovery } = await import('../src/drive/trash.js');
    let loggedIn = true, writes = 0, stopped = false;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const client = {
        async *iterateTrashedNodes() {
            yield { uid: 'drive~file', name: { ok: true, value: 'notes.txt' }, type: 'file', trashTime: new Date() } as NodeEntity;
        },
        async getNode() { throw new Error('Unexpected lookup'); },
        async *restoreNodes() { writes++; },
    };
    const trash = new TrashRecovery(async () => client, async () => {}, async () => {});
    const session = {
        getClient() { if (!loggedIn) throw new Error('Not signed in to Proton Drive'); return client; },
        async logout() { loggedIn = false; },
    };
    const downloads = { async stop() { await cleanup; stopped = true; } };
    const iface = new HalyardInterface({ onSignedOut() {} } as never, session as never, () => {},
        { reset() {} } as never, downloads as never, { async stop() {} } as never, { async stop() {} } as never, trash);
    const page = JSON.parse(await iface.ListTrash(JSON.stringify({ source: 'drive', requestId: 'ipc' })));
    assert.equal(page.items[0].name, 'notes.txt');
    for (const raw of ['null', '[]', '{}', '{"source":"drive","uids":"drive~file"}', '{"source":"other","uids":["drive~file"]}']) {
        assert.throws(() => iface.StartTrashRestore(raw));
    }
    await assert.rejects(iface.ListTrash('{"source":"drive","requestId":"../bad"}'), /invalid/);
    const signingOut = iface.Logout();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(loggedIn, true, 'the session remains valid while transfer cleanup is pending');
    assert.throws(() => iface.StartTrashRestore('{"source":"drive","uids":["drive~file"]}'), /sign-out/);
    await assert.rejects(iface.ListTrash('{"source":"drive","requestId":"blocked"}'), /sign-out/);
    release(); await signingOut;
    assert.equal(stopped, true); assert.equal(loggedIn, false); assert.equal(writes, 0);
    assert.deepEqual(JSON.parse(iface.ListTrashRestores()), []);
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

test('a restored folder enters through events and keeps an unsynced local file as a conflict copy', async () => {
    await withPair(async (db, pair, drive, syncer) => {
        drive.putFile('shared~anchor', 'anchor.txt', 'keep the local root nonempty', 2_000);
        const restored = { ...folder('shared~restored', SHARED_ROOT, 'Recovered'), trashTime: new Date() };
        drive.nodes.set(restored.uid, restored);
        drive.putFile('shared~old', 'notes.txt', 'recovered remote contents', 2_000, 'old-revision', restored.uid);
        await syncer.sync();
        assert.deepEqual(drive.enumerated, [SHARED_ROOT]);
        const local = path.join(pair.localPath, 'Recovered');
        await fsp.mkdir(local);
        await fsp.writeFile(path.join(local, 'notes.txt'), 'unsynced local edit');
        const live = { ...restored, trashTime: undefined };
        drive.nodes.set(live.uid, live);
        drive.nodeEvent(live);
        await syncer.sync();
        assert.equal(syncer.status, 'idle', syncer.error ?? 'restored folder reconciled');
        assert.equal(await fsp.readFile(path.join(local, 'notes.txt'), 'utf8'), 'recovered remote contents');
        const conflict = (await fsp.readdir(local)).find(name => name.includes('(conflict '));
        assert.ok(conflict, 'local edits were preserved as a conflict copy');
        assert.equal(await fsp.readFile(path.join(local, conflict), 'utf8'), 'unsynced local edit');
        assert.deepEqual(drive.enumerated, [SHARED_ROOT, restored.uid], 'only the restored subtree is enumerated');
        assert.ok(db.getBase(pair.id).has('Recovered/notes.txt'));
        assert.deepEqual(drive.trashed, []);
    });
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
        for (const pair of manager.listPairs()) await manager.removePair(pair.id, true);
        await manager.stop();
        await fsp.rm(directory, { recursive: true, force: true });
    }
});

/** Holds an SDK operation after progress begins, including its abort cleanup. */
class TransferGate {
    signal?: AbortSignal;
    progress?: () => void;
    private begin!: () => void;
    private finish!: () => void;
    readonly started = new Promise<void>(resolve => { this.begin = resolve; });
    private readonly released = new Promise<void>(resolve => { this.finish = resolve; });

    async wait(signal: AbortSignal | undefined, progress: () => void): Promise<void> {
        this.signal = signal;
        this.progress = progress;
        progress();
        this.begin();
        await this.released;
        signal?.throwIfAborted();
    }

    release(): void { this.finish(); }
}

function holdUpload(client: ProtonDriveClient, gate: TransferGate): void {
    const getUploader = client.getFileUploader.bind(client);
    client.getFileUploader = async (parent, name, metadata, signal) => {
        const uploader = await getUploader(parent, name, metadata, signal);
        if (name !== 'b.txt') return uploader;
        return { ...uploader, uploadFromStream: async (stream, thumbnails, progress) => ({
            completion: async () => {
                try {
                    await gate.wait(signal, () => progress?.(0));
                } catch (error) {
                    await stream.cancel();
                    throw error;
                }
                return (await uploader.uploadFromStream(stream, thumbnails, progress)).completion();
            },
            pause() {}, resume() {},
        }) };
    };
}

for (const overlap of ['remove', 'update-during-removal', 'update-before-removal'] as const) {
    test(`pair mutations wait for cancellation cleanup (${overlap})`, async () => {
        const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-pair-mutations-'));
        const drive = new OfflineDrive();
        const client = drive.asClient();
        const gate = new TransferGate();
        holdUpload(client, gate);
        const session = { isLoggedIn: () => true, getClient: () => client } as DriveSession;
        const manager = new SyncManager(session);
        const db = new SyncDatabase(path.join(testDataHome, 'halyard', 'sync.sqlite'));
        let running: Promise<void> | undefined;
        let mutation: Promise<unknown> | undefined;
        let followup: Promise<{ error?: unknown }> | undefined;
        try {
            await manager.start();
            const pair = await manager.addPair({ localPath: path.join(directory, 'Trips'),
                remoteUid: SHARED_ROOT, remotePath: '/Trips' });
            await waitUntil(() => manager.listPairs().find(item => item.id === pair.id)?.seeded === true &&
                manager.getStatus().pairs.find(item => item.id === pair.id)?.status === 'idle');
            for (const name of ['a.txt', 'b.txt']) await fsp.writeFile(path.join(pair.localPath, name), name);
            running = manager.syncAll(pair.id);
            await gate.started;
            assert.ok(db.getBase(pair.id).has('a.txt'));

            mutation = overlap === 'update-before-removal'
                ? manager.updatePair(pair.id, { excludes: ['a.txt'] })
                : manager.removePair(pair.id, false);
            let finished = false;
            const next = overlap === 'update-during-removal'
                ? manager.updatePair(pair.id, { excludes: ['a.txt'] })
                : manager.removePair(pair.id, true);
            followup = next.then(() => { finished = true; return {}; }, error => {
                finished = true;
                return { error };
            });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(gate.signal?.aborted, true);
            assert.equal(finished, false, 'overlapping mutation waits for the retired run');
            assert.ok(db.getPair(pair.id), 'the pair cannot be forgotten during cleanup');
            assert.ok(db.getBase(pair.id).has('a.txt'), 'an update cannot purge the old run\'s base');
            assert.equal(db.findRemovedPair(pair.localPath, pair.remoteUid), undefined,
                'retained state cannot be revived during cleanup');

            gate.release();
            await Promise.all([running, mutation]);
            const outcome = await followup;
            assert.deepEqual(manager.listPairs(), []);
            if (overlap === 'update-during-removal') {
                assert.match(String(outcome.error), /No such pair/);
                assert.ok(db.findRemovedPair(pair.localPath, pair.remoteUid));
                assert.ok(db.getBase(pair.id).has('a.txt'));
                assert.deepEqual(manager.listHistory({ pairId: pair.id }).map(event => event.path), ['a.txt']);
            } else {
                assert.equal(outcome.error, undefined);
                assert.equal(db.getPair(pair.id), undefined);
                assert.deepEqual(manager.listHistory({ pairId: pair.id }), []);
            }
            await manager.removePair(pair.id, true);
        } finally {
            gate.release();
            await Promise.allSettled([running, mutation, followup]);
            for (const pair of manager.listPairs()) await manager.removePair(pair.id, true);
            await manager.stop();
            db.close();
            await fsp.rm(directory, { recursive: true, force: true });
        }
    });
}

test('cancelling setup preserves an incomplete folder for the next enumeration', async () => {
    await withPair(async (db, pair, drive, syncer) => {
        drive.putFile('shared~a', 'a.txt', 'first', 2_000);
        drive.putFile('shared~b', 'b.txt', 'second', 2_000);
        const client = drive.asClient();
        const iterateChildren = client.iterateFolderChildrenNodeUids.bind(client);
        const gate = new TransferGate();
        client.iterateFolderChildrenNodeUids = async function* (_parent, _options, signal) {
            yield 'shared~a';
            try { await gate.wait(signal, () => {}); }
            catch (error) {
                // Exercise an iterator that ends normally on cancellation.
                if (!signal?.aborted) throw error;
            }
        };
        const running = syncer.sync();
        try {
            await gate.started;
            const cancellation = syncer.cancel();
            gate.release();
            await Promise.all([running, cancellation]);
            assert.equal(syncer.status, 'idle');
            assert.equal(db.getPair(pair.id)!.seeded, false);
            assert.deepEqual(db.getUnlistedFolders(pair.id), [SHARED_ROOT]);
            assert.equal(db.getBase(pair.id).size, 0);
            assert.deepEqual(drive.downloads, []);
            assert.deepEqual(db.listEvents(), []);

            client.iterateFolderChildrenNodeUids = iterateChildren;
            await syncer.sync();
            assert.equal(syncer.status, 'idle', syncer.error ?? 'resumed sync completed');
            assert.equal(await fsp.readFile(path.join(pair.localPath, 'a.txt'), 'utf8'), 'first');
            assert.equal(await fsp.readFile(path.join(pair.localPath, 'b.txt'), 'utf8'), 'second');
        } finally {
            gate.release();
            await running;
        }
    });
});

test('a syncAll snapshot skips a removed queued pair and continues the remaining pair', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-remove-queued-'));
    const drive = new OfflineDrive();
    drive.nodes.set('shared~other', folder('shared~other', 'inaccessible-parent', 'Other', MemberRole.Editor));
    const client = drive.asClient();
    const gate = new TransferGate();
    holdUpload(client, gate);
    const session = { isLoggedIn: () => true, getClient: () => client } as DriveSession;
    const manager = new SyncManager(session);
    let running: Promise<void> | undefined;
    try {
        await manager.start();
        const first = await manager.addPair({ localPath: path.join(directory, 'Trips'),
            remoteUid: SHARED_ROOT, remotePath: '/Trips' });
        const queued = await manager.addPair({ localPath: path.join(directory, 'Other'),
            remoteUid: 'shared~other', remotePath: '/Other' });
        await waitUntil(() => manager.listPairs().every(pair => pair.seeded) &&
            manager.getStatus().pairs.every(pair => pair.status === 'idle'));
        await fsp.writeFile(path.join(first.localPath, 'b.txt'), 'first pair');
        await fsp.writeFile(path.join(queued.localPath, 'queued.txt'), 'second pair');
        running = manager.syncAll();
        await gate.started;
        await manager.removePair(queued.id, true);
        assert.equal(gate.signal?.aborted, false, 'removing another pair does not abort this transfer');
        assert.equal(manager.getStatus().activity?.pairId, first.id, 'other pair activity stays visible');
        gate.release();
        await running;
        assert.equal(manager.getStatus().pairs[0].status, 'idle');
        assert.deepEqual(manager.listHistory({}).map(event => event.path), ['b.txt']);
        assert.equal([...drive.nodes.values()].some(node => node.name.ok && node.name.value === 'queued.txt'), false);
    } finally {
        gate.release();
        await running;
        for (const pair of manager.listPairs()) await manager.removePair(pair.id, true);
        await manager.stop();
        await fsp.rm(directory, { recursive: true, force: true });
    }
});

for (const kind of ['upload', 'download'] as const) {
    for (const forget of [false, true]) {
        test(`removing a pair during ${kind} cancels it quietly (${forget ? 'forget' : 'keep'} state)`, async () => {
            const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-remove-pair-'));
            const drive = new OfflineDrive();
            const client = drive.asClient();
            const gate = new TransferGate();
            if (kind === 'upload') holdUpload(client, gate);
            else {
                const getDownloader = client.getFileDownloader.bind(client);
                client.getFileDownloader = async (uid, signal) => {
                    const downloader = await getDownloader(uid, signal);
                    if (uid !== 'shared~b') return downloader;
                    return { ...downloader, downloadToStream: (stream, progress) => ({
                        completion: async () => {
                            const writer = stream.getWriter();
                            try {
                                await writer.write(Buffer.from('partial'));
                                await gate.wait(signal, () => progress?.(7));
                            } finally {
                                await writer.abort();
                            }
                        },
                        isDownloadCompleteWithSignatureIssues: () => false,
                        pause() {}, resume() {},
                    }) };
                };
            }
            const session = { isLoggedIn: () => true, getClient: () => client } as DriveSession;
            const manager = new SyncManager(session);
            const db = new SyncDatabase(path.join(testDataHome, 'halyard', 'sync.sqlite'));
            const notices: string[] = [];
            manager.onNotify((_kind, _title, body) => notices.push(body));
            let running: Promise<void> | undefined;
            try {
                await manager.start();
                const pair = await manager.addPair({ localPath: path.join(directory, 'Trips'),
                    remoteUid: SHARED_ROOT, remotePath: '/Trips' });
                await waitUntil(() => manager.listPairs().find(item => item.id === pair.id)?.seeded === true &&
                    manager.getStatus().pairs.find(item => item.id === pair.id)?.status === 'idle');
                const lastSyncAt = db.getPair(pair.id)!.lastSyncAt;
                for (const name of ['a.txt', 'b.txt', 'c.txt']) {
                    if (kind === 'upload') await fsp.writeFile(path.join(pair.localPath, name), name);
                    else drive.nodeEvent(drive.putFile(`shared~${name[0]}`, name, name, 2_000), DriveEventType.NodeCreated);
                }
                running = manager.syncAll(pair.id);
                await Promise.race([gate.started, new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('offline transfer never started')), 2_000).unref())]);
                assert.equal(manager.getStatus().activity?.pairId, pair.id);
                assert.ok(db.getBase(pair.id).has('a.txt'), 'finished transfer has durable state');

                let removed = false;
                const removal = Promise.resolve(manager.removePair(pair.id, forget)).then(() => { removed = true; });
                assert.equal(gate.signal?.aborted, true, 'removal aborts the active SDK transfer immediately');
                await new Promise(resolve => setImmediate(resolve));
                assert.equal(removed, false, 'removal waits for the old run to unwind');
                assert.ok(db.getPair(pair.id), 'state is kept until cancellation cleanup finishes');
                assert.equal(manager.getStatus().activity, null);
                gate.progress?.();
                assert.equal(manager.getStatus().activity, null, 'late progress cannot revive removed activity');

                gate.release();
                await Promise.all([running, removal]);
                assert.equal(manager.listPairs().some(item => item.id === pair.id), false);
                assert.equal(manager.getStatus().activity, null);
                assert.deepEqual(notices, []);
                assert.equal(db.getBase(pair.id).has('c.txt'), false, 'queued transfer never runs');
                const history = manager.listHistory({ pairId: pair.id });
                assert.deepEqual(history.map(event => event.path), forget ? [] : ['a.txt']);
                assert.ok(history.every(event => event.outcome === 'ok'), 'cancellation is not an Activity error');
                if (forget) {
                    assert.equal(db.getPair(pair.id), undefined);
                    assert.equal(db.getBase(pair.id).size, 0);
                    assert.equal(db.getRemoteNodes(pair.id).length, 0);
                } else {
                    assert.ok(db.findRemovedPair(pair.localPath, pair.remoteUid));
                    assert.equal(db.getPair(pair.id)!.lastSyncAt, lastSyncAt, 'cancelled cycles do not mark sync complete');
                }
                if (kind === 'download') {
                    await assert.rejects(fsp.stat(path.join(pair.localPath, 'b.txt')), { code: 'ENOENT' });
                    await assert.rejects(fsp.stat(path.join(pair.localPath, 'b.txt.halyard-part')), { code: 'ENOENT' });
                } else assert.equal(await fsp.readFile(path.join(pair.localPath, 'b.txt'), 'utf8'), 'b.txt');
                await manager.removePair(pair.id, true);
            } finally {
                gate.release();
                await running;
                for (const pair of manager.listPairs()) await manager.removePair(pair.id, true);
                await manager.stop();
                db.close();
                await fsp.rm(directory, { recursive: true, force: true });
            }
        });
    }
}

/** Real filesystem deletion races, with no Drive account or requests. */
async function withDeletionPlan(run: (fixture: {
    root: string; db: SQLiteDb; pair: Pair; actions: import('../src/engine/types.js').Action[];
    execute: (client?: ProtonDriveClient) => Promise<import('../src/engine/execute.js').ExecuteResult>;
}) => Promise<void>): Promise<void> {
    const { Executor } = await import('../src/engine/execute.js');
    const { scanLocal } = await import('../src/engine/localScan.js');
    const { reconcile } = await import('../src/engine/reconcile.js');
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-delete-race-'));
    const root = path.join(directory, 'local');
    await fsp.mkdir(path.join(root, 'folder'), { recursive: true });
    for (const file of ['folder/file.txt', 'standalone.txt']) await fsp.writeFile(path.join(root, file), 'old');
    const db = new SyncDatabase(path.join(directory, 'state.sqlite'));
    const pair: Pair = { id: 'deletion', localPath: root, remoteUid: 'root', remotePath: 'root',
        enabled: true, excludes: [], treeEventScopeId: null, eventCursor: null,
        seeded: true, createdAt: 0, lastSyncAt: null };
    try {
        db.insertPair(pair);
        const local = await scanLocal(root);
        for (const item of local.values()) db.setBaseEntry(pair.id, {
            path: item.path, type: item.type, localMtime: item.mtime, localSize: item.size,
            localInode: item.inode, localDevice: item.device,
            localHash: item.type === 'file' ? createHash('sha1').update('old').digest('hex') : null,
            remoteUid: `uid-${item.path}`, remoteRevisionUid: 'rev1', remoteHash: null,
            remoteSize: item.size, remoteMtime: item.mtime,
        });
        const remote = new Map();
        const { actions } = reconcile({ local, base: db.getBase(pair.id), remote, now: 0 });
        await run({ root, db, pair, actions,
            execute: (client = {} as ProtonDriveClient) => new Executor({ pair, db, client, local, remote }).run(actions) });
    } finally {
        db.close();
        await fsp.rm(directory, { recursive: true, force: true });
    }
}

test('post-scan edits survive parent deletion and retain durable base', async () => {
    await withDeletionPlan(async ({ root, db, pair, execute }) => {
        for (const file of ['folder/file.txt', 'standalone.txt']) await fsp.writeFile(path.join(root, file), 'unsynced after scan');
        assert.deepEqual((await execute()).failed, []);
        for (const file of ['folder/file.txt', 'standalone.txt']) assert.equal(await fsp.readFile(path.join(root, file), 'utf8'), 'unsynced after scan');
        assert.deepEqual([...db.getBase(pair.id).keys()].sort(), ['folder', 'folder/file.txt', 'standalone.txt']);
    });
});

test('new post-scan child defers its folder without blocking unrelated deletes', async () => {
    await withDeletionPlan(async ({ root, db, pair, execute }) => {
        await fsp.writeFile(path.join(root, 'folder/new.txt'), 'new work');
        assert.deepEqual((await execute()).failed, []);
        assert.equal(await fsp.readFile(path.join(root, 'folder/new.txt'), 'utf8'), 'new work');
        assert.deepEqual([...db.getBase(pair.id).keys()], ['folder']);
        await assert.rejects(fsp.stat(path.join(root, 'standalone.txt')), { code: 'ENOENT' });
    });
});

test('failed child deletion preserves parent and base while unrelated deletes finish', async (t) => {
    await withDeletionPlan(async ({ root, db, pair, execute }) => {
        const originalRm = fsp.rm;
        t.mock.method(fsp, 'rm', async (...args: Parameters<typeof fsp.rm>) => {
            if (args[0] === path.join(root, 'folder/file.txt')) {
                throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
            }
            return originalRm(...args);
        });
        const result = await execute();
        t.mock.restoreAll();
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0]!.action.kind, 'deleteLocal');
        assert.equal(await fsp.readFile(path.join(root, 'folder/file.txt'), 'utf8'), 'old');
        assert.deepEqual([...db.getBase(pair.id).keys()].sort(), ['folder', 'folder/file.txt']);
        await assert.rejects(fsp.stat(path.join(root, 'standalone.txt')), { code: 'ENOENT' });
    });
});

test('ordinary empty-tree deletion removes tree and durable base', async () => {
    await withDeletionPlan(async ({ root, db, pair, execute }) => {
        assert.deepEqual((await execute()).failed, []);
        assert.deepEqual(await fsp.readdir(root), []);
        assert.equal(db.getBase(pair.id).size, 0);
    });
});

test('failed remote trash retains child and ancestor base without blocking unrelated trash', async () => {
    await withDeletionPlan(async ({ db, pair, actions, execute }) => {
        actions.splice(0, actions.length,
            { kind: 'trashRemote', path: 'folder/file.txt', remoteUid: 'child' },
            { kind: 'trashRemote', path: 'folder', remoteUid: 'parent' },
            { kind: 'trashRemote', path: 'standalone.txt', remoteUid: 'other' },
            { kind: 'dropBase', path: 'folder/file.txt' },
            { kind: 'dropBase', path: 'folder' },
            { kind: 'dropBase', path: 'standalone.txt' });
        const requested: string[] = [];
        const client = { async *trashNodes(uids: string[]) {
            requested.push(...uids);
            if (uids[0] === 'child') yield { ok: false, error: new Error('Permission denied') };
            else yield { ok: true, uid: uids[0] };
        } } as unknown as ProtonDriveClient;
        assert.equal((await execute(client)).failed.length, 1);
        assert.deepEqual(requested, ['child', 'other']);
        assert.deepEqual([...db.getBase(pair.id).keys()].sort(), ['folder', 'folder/file.txt']);
    });
});
