import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PhotoLibrary, type PhotosClient } from '../src/photos/library.js';
import { PhotoDownloads, downloadDestination, safePhotoName } from '../src/photos/downloads.js';
import { PhotoUploads, imageMediaType, type UploadClient } from '../src/photos/uploads.js';
import { HttpClient } from '../src/drive/httpClient.js';

function photo(i: number): any {
    return { uid: `photo-${i}`, type: 'photo', name: { ok: true, value: i === 1 ? 'same.jpg' : `image-${i}.jpg` },
        parentUid: 'root', creationTime: new Date('2026-10-01'), mediaType: i % 2 ? 'image/jpeg' : 'video/mp4',
        activeRevision: { uid: `revision-${i}`, claimedSize: 4 },
        photo: { captureTime: new Date(Date.UTC(2026, 9, 1) - i * 1000), tags: i % 3 === 0 ? [0] : [], relatedPhotoNodeUids: [], albums: [] } };
}
function gallery(count = 100) {
    const nodes = new Map(Array.from({ length: count }, (_, i) => [photo(i).uid, photo(i)]));
    let walks = 0, events: any[] = [];
    let tick: (scope: string) => Promise<void> = async () => {};
    const client = {
        async getMyPhotosRootFolder() { return { uid: 'root', treeEventScopeId: 'scope' }; },
        async *iterateTimeline() { walks++; for (const node of nodes.values()) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async *iterateAlbum() { for (const node of nodes.values()) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async *iterateAlbums() {},
        async *iterateNodes(uids: string[]) { for (const uid of uids) if (nodes.has(uid)) yield nodes.get(uid); },
        async getNode(uid: string) { if (!nodes.has(uid)) throw new Error('missing'); return nodes.get(uid); },
        async *iterateThumbnails(uids: string[]) { for (const uid of uids) yield { ok: true, nodeUid: uid, thumbnail: new Uint8Array([1,2,3]) }; },
        async getEventScheduler(callback: typeof tick) { tick = callback; return { addScope() {}, removeScope() {} }; },
        async *iterateEvents(_scope: string, cursor?: string) { if (!cursor) yield { type: 'fast_forward', eventId: 'baseline' }; else { const batch = events; events = []; for (const event of batch) yield event; } },
    } as unknown as PhotosClient;
    return { client, nodes, walks: () => walks, async event(event: any) { events.push(event); await tick('scope'); } };
}
async function settle(read: () => any[]) {
    for (let i = 0; i < 400; i++) {
        const jobs = read();
        if (jobs.length && jobs.every(j => !['queued','downloading','uploading','paused'].includes(j.status))) return jobs;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('transfer did not settle');
}
async function temporary(work: (home: string) => Promise<void>) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'halyard-photos-'));
    try { await work(home); } finally { await fs.rm(home, { recursive: true, force: true }); }
}

describe('photo library', () => {
    test('pages one lazy iterator, filters, and retains the timeline on revisit', async () => {
        const g = gallery(); const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ limit: 17 });
            expect(first.photos.length).toBe(17);
            const second = await library.list({ limit: 17, cursor: first.nextCursor! });
            expect(second.photos[0].uid).toBe('photo-17'); expect(g.walks()).toBe(1);
            expect((await library.list({ kind: 'favourites', search: 'image', limit: 6 })).photos.every(p => p.favourite)).toBe(true);
            await library.list({ limit: 17 }); expect(g.walks()).toBe(1);
            expect((await library.getThumbnails(['photo-1']))[0].data).toBe('AQID');
        } finally { library.reset(); }
    });
    test('events update collections and invalidate cursors without a recursive walk', async () => {
        const g = gallery(35); const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ limit: 10 }); g.nodes.delete('photo-2');
            await g.event({ type: 'node_deleted', nodeUid: 'photo-2', eventId: 'next' });
            await expect(library.list({ cursor: first.nextCursor! })).rejects.toThrow('changed');
            expect((await library.list({ limit: 10 })).photos.some(p => p.uid === 'photo-2')).toBe(false);
            expect(g.walks()).toBe(1);
            const node = photo(-1); g.nodes.set(node.uid, node); await library.refreshUploaded(node.uid);
            expect((await library.list({ limit: 1 })).photos[0].uid).toBe(node.uid);
        } finally { library.reset(); }
    });
    test('empty galleries and account resets do not leak delayed thumbnail results', async () => {
        let resolve: (client: PhotosClient | null) => void = () => {};
        const library = new PhotoLibrary(() => new Promise(r => { resolve = r; }));
        const request = library.getThumbnails(['photo-1']); library.reset(); resolve(gallery().client);
        await expect(request).rejects.toThrow();
        const empty = new PhotoLibrary(async () => null); expect((await empty.list({})).photos).toEqual([]); empty.reset();
    });
    test('Trash validates node types before writes and updates only successful removals', async () => {
        const g = gallery(3); let writes = 0;
        (g.client as any).trashNodes = async function* (uids: string[]) {
            writes++;
            for (const uid of uids) yield uid === 'photo-1' ? {uid, ok:false, error:new Error('Permission denied')} : {uid, ok:true};
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            await library.list({});
            g.nodes.get('photo-0').photo.relatedPhotoNodeUids = ['photo-2'];
            const results = await library.trash(['photo-0','photo-1']);
            expect(results.find(r => r.uid === 'photo-2')?.ok).toBe(true);
            expect(results.find(r => r.uid === 'photo-1')?.error).toBe('Permission denied');
            expect((await library.list({})).photos.map(p => p.uid)).toEqual(['photo-1']);
            g.nodes.get('photo-1').type = 'album';
            await expect(library.trash(['photo-1'])).rejects.toThrow('Only photos');
            expect(writes).toBe(1);
        } finally {library.reset();}
    });
    test('browsing explicitly blocks SDK volume creation', async () => {
        let requests = 0;
        const http = new HttpClient({ authenticatedRequest: async () => { requests++; return new Response(); } } as any, true);
        await expect(http.fetchJson({ url: 'https://example.test/drive/photos/volumes', method: 'POST' } as any)).rejects.toThrow('No photos');
        expect(requests).toBe(0);
    });
});
function downloaderClient(nodes: Map<string, any>, failed = new Set<string>()) {
    return { async getNode(uid: string) { return nodes.get(uid); },
        async getFileDownloader(uid: string, signal: AbortSignal) {
            return { getClaimedSizeInBytes: () => 4, downloadToStream(stream: WritableStream, progress: (n: number) => void) {
                const writer = stream.getWriter();
                const done = (async () => { signal.throwIfAborted(); if (failed.has(uid)) { await writer.abort(new Error('failed')); throw new Error('failed'); }
                    await writer.write(new Uint8Array([1,2,3,4])); progress(4); await writer.close(); })();
                return { pause() {}, resume() {}, completion: () => done, isDownloadCompleteWithSignatureIssues: () => false };
            } };
        } } as unknown as PhotosClient;
}
describe('photo downloads', () => {
    test('keeps collisions and symlinks, includes related assets and retries only failed files', async () => temporary(async home => {
        const destination = path.join(home, 'pictures'); await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'same.jpg'), 'original');
        await fs.symlink(path.join(destination, 'same.jpg'), path.join(destination, 'same (1).jpg'));
        const main = photo(1), related = photo(2); main.photo.relatedPhotoNodeUids = [related.uid];
        const nodes = new Map([[main.uid, main], [related.uid, related]]), failed = new Set([related.uid]);
        const downloads = new PhotoDownloads(async () => downloaderClient(nodes, failed), undefined, undefined, home);
        try {
            const job = await downloads.start([main.uid], destination); await settle(() => downloads.list());
            expect(downloads.list()[0].status).toBe('failed');
            expect(await fs.readFile(path.join(destination, 'same.jpg'), 'utf8')).toBe('original');
            expect((await fs.lstat(path.join(destination, 'same (1).jpg'))).isSymbolicLink()).toBe(true);
            expect(downloads.list()[0].files[0].path).toEndWith('same (2).jpg');
            failed.clear(); downloads.control(job.id, 'retry'); await settle(() => downloads.list());
            expect(downloads.list()[0].status).toBe('completed');
            expect((await fs.readdir(destination)).filter(n => n.includes('halyard-part'))).toEqual([]);
            expect((await fs.readdir(destination)).filter(n => n.startsWith('same'))).toHaveLength(3);
        } finally { await downloads.stop(); }
    }));
    test('rejects home escapes before creating a destination', async () => temporary(async home => {
        await fs.symlink(os.tmpdir(), path.join(home, 'escape'));
        await expect(downloadDestination(path.join(home, 'escape', 'halyard-must-not-create'), home)).rejects.toThrow('home directory');
        expect(safePhotoName('../name.jpg')).toBe('.._name.jpg'); expect(() => safePhotoName('..')).toThrow();
    }));
    test('cancels pending work without saving files', async () => temporary(async home => {
        let release: (c: PhotosClient) => void = () => {};
        const client = downloaderClient(new Map([[photo(1).uid, photo(1)]])); let calls = 0;
        const downloads = new PhotoDownloads(async () => ++calls === 1 ? client : new Promise(r => { release = r; }), undefined, undefined, home);
        const job = await downloads.start(['photo-1'], home); await new Promise(r => setTimeout(r, 10));
        downloads.control(job.id, 'cancel'); release(client); await downloads.stop();
        expect(downloads.list()[0].status).toBe('cancelled'); expect(await fs.readdir(home)).toEqual([]);
    }));
});
const jpeg = Buffer.from([255,216,255,224,0,2,255,217]);
const previews = [1,2].map(type => ({ type, data: jpeg.toString('base64') }));
describe('photo uploads', () => {
    test('uploads original bytes with size, checksum and date; skips identical photos', async () => temporary(async home => {
        const local = path.join(home, 'chosen.jpg'); await fs.writeFile(local, jpeg);
        let uploads = 0, metadata: any;
        const client: UploadClient = {
            async findPhotoDuplicates(_name, hash) { await hash(); return uploads ? ['already-there'] : []; },
            async getFileUploader(_name, info) {
                uploads++; metadata = info;
                return { async uploadFromStream(input: ReadableStream, thumbnails: any[]) {
                    expect(thumbnails.map(t => t.type)).toEqual([1,2]);
                    const reader = input.getReader(); const chunks = [];
                    while (true) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(Buffer.from(chunk.value)); }
                    expect(Buffer.concat(chunks)).toEqual(jpeg);
                    return { pause() {}, resume() {}, completion: async () => ({ nodeUid: 'new-photo', nodeRevisionUid: 'new-revision' }) };
                } } as any;
            },
        };
        const queue = new PhotoUploads(async () => client, undefined, undefined, undefined, home);
        try {
            await queue.start([{ path: local, thumbnails: previews }]); await settle(() => queue.list());
            expect(queue.list()[0].status).toBe('completed'); expect(metadata.expectedSize).toBe(jpeg.length);
            expect(metadata.expectedSha1).toBe(createHash('sha1').update(jpeg).digest('hex')); expect(metadata.captureTime).toBeInstanceOf(Date);
            expect(await fs.readFile(local)).toEqual(jpeg);
            await queue.start([{ path: local, thumbnails: previews }]); await settle(() => queue.list());
            expect(queue.list()[0].files[0].status).toBe('skipped'); expect(uploads).toBe(1);
        } finally { await queue.stop(); }
    }));
    test('rejects non-images and outside paths before accessing the SDK', async () => temporary(async home => {
        let calls = 0; const queue = new PhotoUploads(async () => { calls++; throw new Error('must not access SDK'); }, undefined, undefined, undefined, home);
        const bad = path.join(home, 'not-an-image.jpg'); await fs.writeFile(bad, 'not an image');
        await expect(queue.start([{ path: bad, thumbnails: previews }])).rejects.toThrow('JPEG');
        await expect(queue.start([{ path: path.join(home, '..', 'outside.jpg'), thumbnails: previews }])).rejects.toThrow();
        expect(calls).toBe(0); expect(() => imageMediaType(new Uint8Array([0,1,2]))).toThrow(); await queue.stop();
    }));
});
