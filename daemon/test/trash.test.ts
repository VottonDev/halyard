import { describe, expect, test } from 'bun:test';
import type { NodeEntity, NodeResult } from '@protontech/drive-sdk';
import { TrashRecovery, type TrashClient, type TrashRestore, type TrashSource } from '../src/drive/trash.js';

function node(uid: string, type = 'file', parentUid = 'root'): any {
    return { uid, type, parentUid, name: { ok: true, value: `${uid}.txt` }, trashTime: new Date('2026-10-01'),
        activeRevision: { claimedSize: 42 }, photo: { relatedPhotoNodeUids: [] } };
}

class OfflineTrash implements TrashClient {
    nodes = new Map<string, any>([['root', { ...node('root', 'folder'), trashTime: undefined }]]);
    calls: string[][] = [];
    failures = new Map<string, string>();
    omitted = new Set<string>();
    unapplied = new Set<string>();
    block?: (signal: AbortSignal) => Promise<void>;
    listingBlock?: (signal: AbortSignal) => Promise<void>;

    constructor(nodes: any[]) { for (const item of nodes) this.nodes.set(item.uid, item); }
    async getNode(uid: string): Promise<NodeEntity> {
        if (!this.nodes.has(uid)) throw new Error('The original location is missing or inaccessible.');
        return structuredClone(this.nodes.get(uid));
    }
    async *iterateTrashedNodes(signal: AbortSignal): AsyncGenerator<NodeEntity> {
        if (this.listingBlock) await this.listingBlock(signal);
        for (const item of [...this.nodes.values()].filter(item => item.trashTime)) {
            signal.throwIfAborted(); yield structuredClone(item);
        }
    }
    async *restoreNodes(uids: string[], signal: AbortSignal): AsyncGenerator<NodeResult> {
        this.calls.push([...uids]);
        // Deliberately return a different order from the request.
        for (const uid of [...uids].reverse()) {
            if (this.omitted.has(uid)) continue;
            signal.throwIfAborted();
            const error = this.failures.get(uid);
            if (error) yield { uid, ok: false, error: new Error(error) };
            else { if (!this.unapplied.has(uid)) this.nodes.get(uid).trashTime = undefined; yield { uid, ok: true }; }
            if (this.block) await this.block(signal);
        }
    }
}

async function until(check: () => boolean) {
    for (let i = 0; i < 500; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    throw new Error('Timed out waiting for mock recovery');
}
function blocked(signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error('aborted'));
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}
function fixture(nodes: any[], photoNodes: any[] | null = []) {
    const drive = new OfflineTrash(nodes), photos = photoNodes ? new OfflineTrash(photoNodes) : null;
    const refreshed: string[][] = [], after: Array<{ source: TrashSource; uids: string[] }> = [], changes: TrashRestore[][] = [];
    const recovery = new TrashRecovery(async source => source === 'drive' ? drive : photos,
        async uids => { refreshed.push(uids); }, async (source, uids) => { after.push({ source, uids }); },
        jobs => changes.push(jobs));
    return { drive, photos, recovery, refreshed, after, changes };
}
async function run(recovery: TrashRecovery, source: TrashSource, uids: string[]) {
    const job = recovery.start(source, uids);
    await until(() => recovery.listRestores()[0].status !== 'running');
    return recovery.listRestores().find(item => item.id === job.id)!;
}
const results = (job: TrashRestore) => Object.fromEntries(job.results.map(r => [r.uid, r.status]));

describe('Trash recovery using public SDK stand-ins', () => {
    test('pages on demand, isolates sources, and never creates an absent Photos volume', async () => {
        const { recovery, drive } = fixture(Array.from({ length: 51 }, (_, i) => node(`f${i}`)), null);
        const first = await recovery.list({ source: 'drive', requestId: 'files' });
        expect(first.items).toHaveLength(50);
        expect(first.items[0].size).toBe(42);
        expect(first.items[0].trashedAt).toBe(Date.parse('2026-10-01'));
        await expect(recovery.list({ source: 'photos', requestId: 'files', cursor: first.nextCursor! })).rejects.toThrow('expired');
        const last = await recovery.list({ source: 'drive', requestId: 'files', cursor: first.nextCursor! });
        expect(last.items.map(item => item.uid)).toEqual(['f50']);
        expect(last.nextCursor).toBeNull();
        expect(await recovery.list({ source: 'photos', requestId: 'photos' })).toEqual({ items: [], nextCursor: null });
        expect(drive.calls).toEqual([]);
    });

    test('cancels a network listing, releases it, and permits a fresh request', async () => {
        const { drive, recovery } = fixture([node('file')]);
        drive.listingBlock = blocked;
        const listing = recovery.list({ source: 'drive', requestId: 'cancel' });
        recovery.cancelListing('cancel');
        await expect(listing).rejects.toThrow();
        drive.listingBlock = undefined;
        expect((await recovery.list({ source: 'drive', requestId: 'fresh' })).items).toHaveLength(1);
    });

    test('rejects unlisted, wrong-source and undecryptable items before any mutation', async () => {
        const unreadable = { ...node('bad'), name: { ok: false, error: new Error('decryption failed') } };
        const { recovery, drive } = fixture([node('file'), unreadable]);
        const page = await recovery.list({ source: 'drive', requestId: 'list' });
        expect(page.items.find(item => item.uid === 'bad')?.error).toContain('decrypted');
        expect(() => recovery.start('drive', ['arbitrary'])).toThrow('no longer listed');
        expect(() => recovery.start('photos', ['file'])).toThrow('no longer listed');
        expect(() => recovery.start('drive', ['bad'])).toThrow('decrypted');
        expect(drive.calls).toEqual([]);
    });

    test('restores files and folders, selected parents before children, and refreshes affected metadata', async () => {
        const { recovery, drive, after, refreshed } = fixture([node('child', 'file', 'parent'), node('parent', 'folder')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        const job = await run(recovery, 'drive', ['child', 'parent', 'child']);
        expect(results(job)).toEqual({ child: 'restored', parent: 'restored' });
        expect(drive.calls).toEqual([['parent'], ['child']]);
        expect(after).toEqual([{ source: 'drive', uids: ['child', 'parent'] }]);
        expect(refreshed.flat()).toContain('root');
        expect(refreshed.at(-1)).toEqual(['child', 'parent']);
    });

    test('missing/trashed parents and name collisions preserve partial successes and raw server errors', async () => {
        const { recovery, drive } = fixture([node('good'), node('collision'), node('missing', 'file', 'deleted'),
            node('child', 'file', 'parent'), node('parent', 'folder')]);
        drive.failures.set('collision', 'An item with this name already exists.');
        await recovery.list({ source: 'drive', requestId: 'list' });
        const job = await run(recovery, 'drive', ['good', 'collision', 'missing', 'child']);
        expect(results(job)).toEqual({ good: 'restored', collision: 'failed', missing: 'failed', child: 'failed' });
        expect(job.results.find(item => item.uid === 'collision')?.error).toBe('An item with this name already exists.');
        expect(job.results.find(item => item.uid === 'child')?.error).toContain('Restore that folder first');
        expect(drive.nodes.get('collision').trashTime).toBeDefined();
        expect(drive.calls.flat()).not.toContain('missing');
        expect(drive.calls.flat()).not.toContain('child');
    });

    test('a child restored implicitly with its parent is not submitted again', async () => {
        const { recovery, drive } = fixture([node('child', 'file', 'parent'), node('parent', 'folder')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        const original = drive.restoreNodes.bind(drive);
        drive.restoreNodes = async function* (uids, signal) {
            for await (const result of original(uids, signal!)) {
                if (result.uid === 'parent' && result.ok) drive.nodes.get('child').trashTime = undefined;
                yield result;
            }
        };
        const job = await run(recovery, 'drive', ['child', 'parent']);
        expect(results(job)).toEqual({ child: 'alreadyRestored', parent: 'restored' });
        expect(drive.calls).toEqual([['parent']]);
    });

    test('revalidates stale listed metadata and reports already-live items without submitting them', async () => {
        const { recovery, drive } = fixture([node('file')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        drive.nodes.get('file').trashTime = undefined;
        const job = await run(recovery, 'drive', ['file']);
        expect(results(job)).toEqual({ file: 'alreadyRestored' });
        expect(drive.calls).toEqual([]);
    });

    test('cancellation before submission changes no remote state', async () => {
        const { recovery, drive } = fixture([node('file')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        const job = recovery.start('drive', ['file']);
        recovery.cancelRestore(job.id);
        await until(() => recovery.listRestores()[0].status !== 'running');
        expect(results(recovery.listRestores()[0])).toEqual({ file: 'cancelled' });
        expect(drive.calls).toEqual([]);
        recovery.cancelRestore(job.id); // Finished jobs are idempotent.
    });

    test('cancellation in a submitted batch keeps confirmed success and marks unanswered results unknown', async () => {
        const { recovery, drive, after } = fixture([node('first'), node('second')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        drive.block = blocked;
        const job = recovery.start('drive', ['first', 'second']);
        await until(() => recovery.listRestores()[0].results.some(r => r.status === 'restored'));
        expect(() => recovery.start('drive', ['first'])).toThrow('current restore');
        recovery.cancelRestore(job.id);
        await until(() => recovery.listRestores()[0].status !== 'running');
        expect(results(recovery.listRestores()[0])).toEqual({ first: 'unknown', second: 'restored' });
        expect(recovery.listRestores()[0].status).toBe('cancelled');
        expect(drive.nodes.get('second').trashTime).toBeUndefined();
        expect(after[0].uids).toEqual(['first', 'second']);
    });

    test('missing SDK results stay unconfirmed rather than becoming successes', async () => {
        const { recovery, drive } = fixture([node('file')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        drive.omitted.add('file');
        const job = await run(recovery, 'drive', ['file']);
        expect(results(job)).toEqual({ file: 'unknown' });
        expect(job.results[0].error).toContain('Refresh Trash');
    });

    test('an SDK success that has not left Trash is reported as unconfirmed', async () => {
        const { recovery, drive } = fixture([node('file')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        drive.unapplied.add('file');
        const job = await run(recovery, 'drive', ['file']);
        expect(results(job)).toEqual({ file: 'unknown' });
        expect(job.results[0].error).toContain('still in Trash');
    });

    test('Photos restores include related still/video assets, albums, and folders using the Photos client', async () => {
        const main = node('main', 'photo'); main.photo.relatedPhotoNodeUids = ['video'];
        const { recovery, drive, photos, after } = fixture([], [main, node('video', 'photo'), node('album', 'album'), node('folder', 'folder')]);
        await recovery.list({ source: 'photos', requestId: 'photos' });
        photos!.failures.set('video', 'The related video could not be restored.');
        const job = await run(recovery, 'photos', ['main', 'album', 'folder']);
        expect(results(job)).toEqual({ main: 'restored', album: 'restored', folder: 'restored', video: 'failed' });
        expect(drive.calls).toEqual([]);
        expect(photos!.calls.flat()).toContain('video');
        expect(after[0].source).toBe('photos');
    });

    test('selecting a photo companion follows its main photo and restores the whole family once', async () => {
        const main = node('main', 'photo'); main.photo.relatedPhotoNodeUids = ['video', 'still'];
        const video = node('video', 'photo'); video.photo.mainPhotoNodeUid = 'main';
        const still = node('still', 'photo'); still.photo.mainPhotoNodeUid = 'main';
        const { recovery, photos } = fixture([], [main, video, still]);
        await recovery.list({ source: 'photos', requestId: 'companions' });
        const job = await run(recovery, 'photos', ['video']);
        expect(results(job)).toEqual({ video: 'restored', main: 'restored', still: 'restored' });
        expect(photos!.calls.flat().sort()).toEqual(['main', 'still', 'video']);
    });

    test('a refresh failure does not erase a successful remote restore', async () => {
        const drive = new OfflineTrash([node('file')]);
        const recovery = new TrashRecovery(async () => drive, async () => {}, async () => { throw new Error('offline'); });
        await recovery.list({ source: 'drive', requestId: 'list' });
        const job = await run(recovery, 'drive', ['file']);
        expect(results(job)).toEqual({ file: 'restored' });
        expect(job.refreshError).toContain('offline');
    });

    test('sign-out waits for cancellations and clears account-scoped jobs and listing identities', async () => {
        const { recovery, drive } = fixture([node('file')]);
        await recovery.list({ source: 'drive', requestId: 'list' });
        drive.block = blocked;
        recovery.start('drive', ['file']);
        await until(() => drive.calls.length > 0);
        await recovery.stop(true);
        expect(recovery.listRestores()).toEqual([]);
        expect(() => recovery.start('drive', ['file'])).toThrow('no longer listed');
    });
});
