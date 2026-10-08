/** Offline transfers exercise Node streams, SQLite and the bundled executor. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Executor, type Progress } from '../src/engine/execute.js';
import { SyncDatabase } from '../src/engine/db.js';
import { PhotoDownloads } from '../src/photos/downloads.js';
import type { PhotosClient } from '../src/photos/library.js';
import type { Action, Pair, RemoteItem } from '../src/engine/types.js';
import type { ProtonDriveClient } from '@protontech/drive-sdk';

async function until(condition: () => boolean) {
    for (let i = 0; i < 400; i++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for downloads');
}

function transfers() {
    const pending = new Map<string, { finish: (error?: Error) => void; paused: boolean }>();
    const started: string[] = [];
    let peak = 0;
    const client = {
        async getNode(uid: string) {
            return { uid, type: 'photo', name: { ok: true, value: 'same.jpg' }, creationTime: new Date(),
                photo: { relatedPhotoNodeUids: [], tags: [] } };
        },
        async getFileDownloader(uid: string, signal?: AbortSignal) {
            signal?.throwIfAborted();
            return {
                getClaimedSizeInBytes: () => 4,
                downloadToStream(stream: WritableStream, progress: (done: number) => void) {
                    started.push(uid);
                    const writer = stream.getWriter();
                    let finish!: (error?: Error) => void;
                    const gate = new Promise<void>((resolve, reject) => {
                        finish = error => error ? reject(error) : resolve();
                    });
                    const abort = () => finish(new Error('Cancelled'));
                    signal?.addEventListener('abort', abort, { once: true });
                    const state = { finish, paused: false };
                    pending.set(uid, state); peak = Math.max(peak, pending.size);
                    const done = (async () => {
                        try {
                            await gate;
                            await writer.write(new Uint8Array([1, 2, 3, 4]));
                            progress(4);
                        } catch (error) { await writer.abort(error); throw error; }
                        finally {
                            writer.releaseLock(); pending.delete(uid);
                            signal?.removeEventListener('abort', abort);
                        }
                    })();
                    return { pause() { state.paused = true; }, resume() { state.paused = false; },
                        completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
                },
            };
        },
    };
    return { client, pending, started, get peak() { return peak; },
        finishAll() { for (const item of pending.values()) item.finish(); } };
}

async function fixture() {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-concurrent-'));
    const db = new SyncDatabase(path.join(home, 'sync.sqlite'));
    const pair: Pair = { id: 'test', localPath: path.join(home, 'sync'), remoteUid: 'root', remotePath: '/',
        enabled: true, excludes: [], seeded: true, treeEventScopeId: null, eventCursor: null, createdAt: 0, lastSyncAt: null };
    await fsp.mkdir(pair.localPath); db.insertPair(pair);
    const remote = new Map<string, RemoteItem>();
    const actions = (count: number, prefix = 'file'): Action[] => Array.from({ length: count }, (_, i) => {
        const name = `${prefix}-${i}.jpg`;
        remote.set(name, { path: name, uid: name, parentUid: 'root', revisionUid: 'revision',
            hash: null, size: 4, mtime: 1000, type: 'file', trashed: false });
        return { kind: 'download', path: name, remoteUid: name, revisionUid: 'revision' };
    });
    const rig = transfers();
    const progress: Array<Progress | null> = [];
    const executor = new Executor({ pair, db, remote, local: new Map(), client: rig.client as unknown as ProtonDriveClient,
        onProgress: value => progress.push(value) });
    return { home, db, pair, remote, actions, rig, executor, progress,
        async close() { db.close(); await fsp.rm(home, { recursive: true, force: true }); } };
}

test('sync downloads five at once, refills slots, then crosses action barriers with durable base and history', async () => {
    const f = await fixture();
    const actions = [{ kind: 'createLocalFolder', path: 'before' } as Action, ...f.actions(8),
        { kind: 'moveLocal', from: 'before', to: 'after' } as Action];
    const running = f.executor.run(actions);
    try {
        await until(() => f.rig.pending.size === 5);
        assert.equal(f.rig.started.length, 5);
        assert.equal((await fsp.stat(path.join(f.pair.localPath, 'before'))).isDirectory(), true);
        f.rig.pending.get('file-0.jpg')!.finish();
        await until(() => f.rig.started.length === 6);
        assert.equal(f.rig.peak, 5);
        assert.equal((await fsp.stat(path.join(f.pair.localPath, 'before'))).isDirectory(), true);
        while (f.rig.started.length < 8 || f.rig.pending.size) {
            f.rig.finishAll(); await new Promise(resolve => setTimeout(resolve, 5));
        }
        const result = await running;
        assert.equal(result.filesDown, 8); assert.equal(result.bytesDown, 32);
        assert.equal(result.completed, 10); assert.deepEqual(result.failed, []);
        assert.equal(f.db.getBase(f.pair.id).size, 8);
        assert.equal(f.db.listEvents().filter(event => event.action === 'downloaded').length, 8);
        assert.equal((await fsp.stat(path.join(f.pair.localPath, 'after'))).isDirectory(), true);
        assert.equal(f.progress.at(-1), null);
        assert.ok(new Set(f.progress.filter(value => value !== null).map(value => value.path)).size > 1,
            'representative activity switches as files finish');
        assert.ok((await fsp.readdir(f.pair.localPath)).every(name => !name.endsWith('.halyard-part')));
    } finally { f.rig.finishAll(); await running; await f.close(); }
});

test('sync and Photos share five slots; photo pause/resume controls all active files and cancellation cleans all partials', async () => {
    const f = await fixture();
    const exports = path.join(f.home, 'exports');
    const queue = new PhotoDownloads(async () => f.rig.client as unknown as PhotosClient, undefined, undefined, f.home);
    const running = f.executor.run(f.actions(2));
    try {
        await until(() => f.rig.pending.size === 2);
        const job = await queue.start(Array.from({ length: 9 }, (_, i) => `photo-${i}`), exports);
        await until(() => f.rig.pending.size === 5);
        assert.equal(f.rig.started.length, 5); assert.equal(f.rig.peak, 5);
        queue.control(job.id, 'pause');
        await until(() => [...f.rig.pending.keys()].every(uid => !uid.startsWith('photo-')));
        f.rig.pending.get('file-0.jpg')!.finish(); f.rig.pending.get('file-1.jpg')!.finish();
        await running;
        assert.equal(f.rig.started.filter(uid => uid.startsWith('photo-')).length, 3, 'paused workers must not start more SDK downloads');
        const otherSync = f.executor.run(f.actions(5, 'other'));
        await until(() => f.rig.pending.size === 5);
        assert.ok([...f.rig.pending.keys()].every(uid => uid.startsWith('other')),
            'five paused Photos files must leave all five slots available for folder sync');
        f.rig.finishAll(); await otherSync;
        queue.control(job.id, 'resume');
        await until(() => f.rig.pending.size === 5);
        assert.equal(f.rig.started.filter(uid => uid.startsWith('photo-')).length, 8, 'resume restarts interrupted files');
        queue.control(job.id, 'cancel'); await queue.stop();
        assert.equal(queue.list()[0].status, 'cancelled');
        assert.ok(queue.list()[0].files.every(file => file.status === 'cancelled'));
        assert.deepEqual(await fsp.readdir(exports), []); assert.equal(f.rig.pending.size, 0);
        // All permits are reusable after aborting both active and queued work.
        const next = await queue.start(['retry-photo'], exports);
        await until(() => f.rig.pending.size === 1); f.rig.finishAll();
        await until(() => queue.list().find(item => item.id === next.id)?.status === 'completed');
    } finally { f.rig.finishAll(); await queue.stop(); await running; await f.close(); }
});

test('a transient sync failure stops new downloads but awaits in-flight successes before recording results', async () => {
    const f = await fixture();
    const running = f.executor.run(f.actions(12));
    try {
        await until(() => f.rig.pending.size === 5);
        f.rig.pending.get('file-0.jpg')!.finish(new Error('Service unavailable'));
        await until(() => f.rig.pending.size === 4);
        // Allow filesystem cleanup and failure classification to finish.
        await new Promise(resolve => setTimeout(resolve, 25));
        f.rig.finishAll();
        const result = await running;
        assert.equal(f.rig.started.length, 5);
        assert.equal(result.failed.length, 1); assert.equal(result.failed[0].transient, true);
        assert.equal(result.filesDown, 4); assert.equal(f.db.getBase(f.pair.id).size, 4);
        assert.equal(f.db.listEvents().length, 5);
        assert.equal((await fsp.readdir(f.pair.localPath)).length, 4);
    } finally { f.rig.finishAll(); await running; await f.close(); }
});

test('five concurrent photo exports publish colliding names without replacing existing files; retry skips successes', async () => {
    const f = await fixture(); const exports = path.join(f.home, 'exports'); await fsp.mkdir(exports);
    await fsp.writeFile(path.join(exports, 'same.jpg'), 'existing');
    const queue = new PhotoDownloads(async () => f.rig.client as unknown as PhotosClient, undefined, undefined, f.home);
    try {
        const job = await queue.start(['p0', 'p1', 'p2', 'p3', 'p4'], exports);
        await until(() => f.rig.pending.size === 5);
        f.rig.pending.get('p0')!.finish(new Error('Bad file')); for (const [uid, state] of f.rig.pending) if (uid !== 'p0') state.finish();
        await until(() => queue.list()[0].status === 'failed');
        assert.equal(await fsp.readFile(path.join(exports, 'same.jpg'), 'utf8'), 'existing');
        assert.equal((await fsp.readdir(exports)).length, 5);
        queue.control(job.id, 'retry'); await until(() => f.rig.pending.size === 1);
        assert.equal(f.rig.started.filter(uid => uid === 'p0').length, 2);
        assert.equal(f.rig.started.length, 6); f.rig.finishAll();
        await until(() => queue.list()[0].status === 'completed');
        assert.equal(new Set(queue.list()[0].files.map(file => file.path)).size, 5);
        assert.equal((await fsp.readdir(exports)).length, 6);
    } finally { f.rig.finishAll(); await queue.stop(); await f.close(); }
});

for (const source of ['sync', 'photos'] as const) {
    test(`${source} cancellation during five SDK metadata requests releases all reservations before retry`, async () => {
        const f = await fixture();
        let reserved = 0, opened = 0, release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const client = {
            getNode: f.rig.client.getNode,
            async getFileDownloader(_uid: string, signal?: AbortSignal) {
                signal?.throwIfAborted();
                reserved++;
                // The real SDK does not pass signal to these metadata reads.
                await gate;
                return { getClaimedSizeInBytes: () => 4,
                    downloadToStream(stream: WritableStream) {
                        opened++;
                        const done = (async () => {
                            const writer = stream.getWriter();
                            try {
                                signal?.throwIfAborted();
                                await writer.write(new Uint8Array([1, 2, 3, 4]));
                            } catch (error) { await writer.abort(error); throw error; }
                            finally { writer.releaseLock(); reserved--; }
                        })();
                        return { completion: () => done, pause() {}, resume() {}, isDownloadCompleteWithSignatureIssues: () => false };
                    },
                };
            },
        };
        const controller = new AbortController();
        const executor = new Executor({ pair: f.pair, db: f.db, remote: f.remote, local: new Map(),
            client: client as unknown as ProtonDriveClient, signal: controller.signal });
        const queue = new PhotoDownloads(async () => client as unknown as PhotosClient, undefined, undefined, f.home);
        let running: Promise<unknown> | undefined;
        try {
            if (source === 'sync') running = executor.run(f.actions(8));
            else await queue.start(Array.from({ length: 8 }, (_, i) => `metadata-${i}`), path.join(f.home, 'exports'));
            await until(() => reserved === 5);
            if (source === 'sync') controller.abort();
            else queue.control(queue.list()[0].id, 'cancel');
            release(); await running; await queue.stop();
            assert.equal(opened, 5, 'every reserved SDK downloader is started, even after cancellation');
            assert.equal(reserved, 0); assert.equal(f.db.getBase(f.pair.id).size, 0);
            assert.deepEqual(await fsp.readdir(f.pair.localPath), []);
            if (source === 'photos') assert.deepEqual(await fsp.readdir(path.join(f.home, 'exports')), []);
            // A subsequent request can use the very same SDK client.
            const next = new Executor({ pair: f.pair, db: f.db, remote: f.remote, local: new Map(), client: client as unknown as ProtonDriveClient });
            const result = await next.run(f.actions(5, 'retry'));
            assert.equal(result.filesDown, 5); assert.equal(reserved, 0);
        } finally { release(); controller.abort(); await running; await queue.stop(); await f.close(); }
    });
}

test('duplicate download paths are serial barriers, preserving the second version and base', async () => {
    const f = await fixture();
    const first = f.actions(1)[0] as Extract<Action, { kind: 'download' }>;
    const running = f.executor.run([first, { ...first, remoteUid: 'second-version' }]);
    try {
        await until(() => f.rig.started.length === 1);
        assert.deepEqual(f.rig.started, ['file-0.jpg']); f.rig.finishAll();
        await until(() => f.rig.started.length === 2); assert.equal(f.rig.peak, 1); f.rig.finishAll();
        const result = await running;
        assert.equal(result.filesDown, 2); assert.deepEqual(result.failed, []);
        assert.equal(f.db.getBase(f.pair.id).get(first.path)!.remoteUid, 'second-version');
    } finally { f.rig.finishAll(); await running; await f.close(); }
});
