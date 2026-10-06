import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { PhotoLibrary, registerPhotoRefresh, type PhotosClient } from '../src/photos/library.js';
import { PhotoTag } from '@protontech/drive-sdk';
import { EventScheduler } from '@protontech/drive-sdk/dist/internal/events/eventScheduler.js';
import { PhotoDownloads } from '../src/photos/downloads.js';
import { PhotoUploads, type UploadClient } from '../src/photos/uploads.js';
import { HttpClient } from '../src/drive/httpClient.js';

function photo(i: number): any {
    return { uid: `own~photo-${i}`, type: 'photo', name: { ok: true, value: i === 1 ? 'same.jpg' : `image-${i}.jpg` },
        parentUid: 'own~root', creationTime: new Date('2026-10-01'), mediaType: i % 2 ? 'image/jpeg' : 'video/mp4',
        activeRevision: { uid: `revision-${i}`, claimedSize: 4 },
        photo: { captureTime: new Date(Date.UTC(2026, 9, 1) - i * 1000), tags: i % 3 === 0 ? [0] : [], relatedPhotoNodeUids: [], albums: [] } };
}
function gallery(count = 100) {
    const nodes = new Map(Array.from({ length: count }, (_, i) => [photo(i).uid, photo(i)]));
    let walks = 0, events: any[] = [];
    let tick: (scope: string) => Promise<void> = async () => {};
    const client = {
        async getMyPhotosRootFolder() { return { uid: 'own~root', treeEventScopeId: 'scope' }; },
        async *iterateTimeline() { walks++; for (const node of nodes.values()) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async *iterateAlbum() { for (const node of nodes.values()) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async *iterateAlbums() {},
        async *iterateSharedWithMeNodeUids() {},
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
    test('a Trash restore invalidates views lazily and keeps the existing event subscription', async () => {
        const g = gallery(35); let changed = 0;
        const library = new PhotoLibrary(async () => g.client, () => changed++);
        try {
            const first = await library.list({ limit: 10 });
            g.nodes.set('photo-100', photo(100));
            await library.refreshRestored();
            expect(g.walks()).toBe(1); expect(changed).toBe(1);
            await expect(library.list({ cursor: first.nextCursor! })).rejects.toThrow('changed');
            const refreshed = await library.list({ limit: 100 });
            expect(refreshed.photos.some(p => p.uid === 'photo-100')).toBe(true);
            expect(g.walks()).toBe(2);
            g.nodes.delete('photo-2');
            await g.event({ type: 'node_deleted', nodeUid: 'photo-2', eventId: 'restored-followup' });
            expect((await library.list({ limit: 100 })).photos.some(p => p.uid === 'photo-2')).toBe(false);
            expect(g.walks()).toBe(2);
        } finally { library.reset(); }
    });
    test('pages one lazy iterator, filters, and retains the timeline on revisit', async () => {
        const g = gallery(); const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ limit: 17 });
            expect(first.photos.length).toBe(17);
            const second = await library.list({ limit: 17, cursor: first.nextCursor! });
            expect(second.photos[0].uid).toBe('own~photo-17'); expect(g.walks()).toBe(1);
            const favourites = (await library.list({ kind: 'favourites', search: 'image', limit: 6 })).photos;
            expect(favourites).toHaveLength(6);
            expect(favourites.every(p => p.favourite && p.name.includes('image'))).toBe(true);
            await library.list({ limit: 17 }); expect(g.walks()).toBe(1);
            expect((await library.getThumbnails(['own~photo-1']))[0].data).toBe('AQID');
        } finally { library.reset(); }
    });
    test('events update collections and invalidate cursors without a recursive walk', async () => {
        const g = gallery(35); const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ limit: 10 }); g.nodes.delete('own~photo-2');
            await g.event({ type: 'node_deleted', nodeUid: 'own~photo-2', eventId: 'next' });
            await expect(library.list({ cursor: first.nextCursor! })).rejects.toThrow('changed');
            expect((await library.list({ limit: 10 })).photos.some(p => p.uid === 'own~photo-2')).toBe(false);
            expect(g.walks()).toBe(1);
            const node = photo(-1); g.nodes.set(node.uid, node); await library.refreshUploaded(node.uid);
            expect((await library.list({ limit: 1 })).photos[0].uid).toBe(node.uid);
        } finally { library.reset(); }
    });
    test('empty galleries and account resets do not leak delayed thumbnail results', async () => {
        let resolve: (client: PhotosClient | null) => void = () => {};
        const library = new PhotoLibrary(() => new Promise(r => { resolve = r; }));
        const request = library.getThumbnails(['own~photo-1']); library.reset(); resolve(gallery().client);
        await expect(request).rejects.toThrow();
        const empty = new PhotoLibrary(async () => null); expect((await empty.list({})).photos).toEqual([]); empty.reset();
    });
    test('Trash validates node types before writes and updates only successful removals', async () => {
        const g = gallery(3); let writes = 0;
        (g.client as any).trashNodes = async function* (uids: string[]) {
            writes++;
            for (const uid of uids) yield uid === 'own~photo-1' ? {uid, ok:false, error:new Error('Permission denied')} : {uid, ok:true};
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            await library.list({});
            g.nodes.get('own~photo-0').photo.relatedPhotoNodeUids = ['own~photo-2'];
            const results = await library.trash(['own~photo-0','own~photo-1']);
            expect(results.find(r => r.uid === 'own~photo-2')?.ok).toBe(true);
            expect(results.find(r => r.uid === 'own~photo-1')?.error).toBe('Permission denied');
            expect((await library.list({})).photos.map(p => p.uid)).toEqual(['own~photo-1']);
            g.nodes.get('own~photo-1').type = 'album';
            await expect(library.trash(['own~photo-1'])).rejects.toThrow('Only photos');
            expect(writes).toBe(1);
        } finally {library.reset();}
    });
    test('browsing explicitly blocks SDK volume creation', async () => {
        let requests = 0;
        const http = new HttpClient({ authenticatedRequest: async () => { requests++; return new Response(); } } as any, true);
        await expect(http.fetchJson({ url: 'https://example.test/drive/photos/volumes', method: 'POST' } as any)).rejects.toThrow('No photos');
        expect(requests).toBe(0);
    });
    test('year/month jumps use placeholders and decrypt only photos in the chosen period', async () => {
        const g = gallery(650), loaded: string[] = [];
        for (const [uid, node] of g.nodes) if (Number(uid.split('-').pop()) >= 620) node.photo.captureTime = new Date('2017-06-01');
        const iterate = g.client.iterateNodes.bind(g.client);
        (g.client as any).iterateNodes = async function* (uids: string[]) { loaded.push(...uids); yield* iterate(uids); };
        const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ year: '2017', limit: 10 });
            expect(first.photos).toEqual([]); expect(first.nextCursor).not.toBeNull(); expect(loaded).toEqual([]);
            const second = await library.list({ year: '2017', cursor: first.nextCursor!, limit: 10 });
            expect(second.photos).toHaveLength(10);
            expect(loaded.every(uid => Number(uid.split('-').pop()) >= 620)).toBe(true);
            expect((await library.list({ year: '2017', month: '2017-07' })).photos).toEqual([]);
            expect(g.walks()).toBe(1);
        } finally { library.reset(); }
    });
    test('a failed SDK page can be retried without silently losing the remaining photos', async () => {
        const g = gallery(80);
        let fail = true;
        (g.client as any).iterateTimeline = async function* () {
            let index = 0;
            for (const node of g.nodes.values()) {
                if (index++ === 30 && fail) { fail = false; throw new Error('Temporary page failure'); }
                yield { nodeUid: node.uid, captureTime: node.photo.captureTime };
            }
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            const first = await library.list({ limit: 17 });
            await expect(library.list({ limit: 17, cursor: first.nextCursor! })).rejects.toThrow('Temporary page failure');
            const retry = await library.list({ limit: 17, cursor: first.nextCursor! });
            expect(retry.photos).toHaveLength(17); expect(retry.photos[0].uid).toBe('own~photo-17');
            expect(new Set(retry.photos.map(p => p.uid)).size).toBe(17);
        } finally { library.reset(); }
    });
    test('year/month pagination stops at its SDK frontier and keeps older photos available', async () => {
        for (const albumUid of [undefined, 'own~album']) {
            const g = gallery(1800);
            let yielded = 0;
            for (const [index, node] of [...g.nodes.values()].entries()) node.photo.captureTime = new Date(index < 75 ? '2026-10-02' : index < 130 ? '2026-09-02' : '2017-06-01');
            const iterator = async function* () {
                for (const node of g.nodes.values()) { yielded++; yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; }
            };
            (g.client as any).iterateTimeline = iterator;
            (g.client as any).iterateAlbum = iterator;
            const library = new PhotoLibrary(async () => g.client);
            try {
                const first = await library.list({ albumUid, year: '2026', month: '2026-10', limit: 60 });
                const last = await library.list({ albumUid, year: '2026', month: '2026-10', limit: 60, cursor: first.nextCursor! });
                expect(first.photos).toHaveLength(60); expect(last.photos).toHaveLength(15); expect(last.nextCursor).toBeNull();
                expect(yielded).toBeLessThan(150);
                const year = await library.list({ albumUid, year: '2026', limit: 100 });
                const yearLast = await library.list({ albumUid, year: '2026', limit: 100, cursor: year.nextCursor! });
                expect(year.photos.length + yearLast.photos.length).toBe(130); expect(yearLast.nextCursor).toBeNull();
                expect(yielded).toBeLessThan(180);
                expect((await library.list({ albumUid, year: '2027' })).nextCursor).toBeNull();
                expect((await library.list({ albumUid, month: '2026-11' })).photos).toEqual([]);
                expect((await library.list({ albumUid, month: '2017-06', limit: 10 })).photos).toHaveLength(10);
                let cursor: string | null = null, count = 0;
                do {
                    const page = await library.list({ albumUid, limit: 100, ...(cursor ? { cursor } : {}) });
                    count += page.photos.length; cursor = page.nextCursor;
                } while (cursor);
                expect(count).toBe(1800);
            } finally { library.reset(); }
        }
    });
    test('an event-injected old photo does not hide matching photos beyond the cached prefix', async () => {
        const g = gallery(100);
        for (const node of g.nodes.values()) node.photo.captureTime = new Date('2026-10-02');
        const library = new PhotoLibrary(async () => g.client);
        try {
            await library.list({ limit: 10 });
            const old = photo(101); old.photo.captureTime = new Date('2017-06-01'); g.nodes.set(old.uid, old);
            await g.event({ type: 'node_created', nodeUid: old.uid, eventId: 'old-added' });
            const first = await library.list({ year: '2026', month: '2026-10', limit: 60 });
            const last = await library.list({ year: '2026', month: '2026-10', cursor: first.nextCursor!, limit: 60 });
            expect(first.photos.length + last.photos.length).toBe(100); expect(last.nextCursor).toBeNull();
            expect((await library.list({ year: '2017' })).photos.map(p => p.uid)).toEqual([old.uid]);
        } finally { library.reset(); }
    });
});

function managementGallery() {
    const g = gallery(5);
    const album: any = { uid: 'own~album', type: 'album', name: { ok: true, value: 'Summer' },
        parentUid: 'own~root', directRole: 'inherited', creationTime: new Date(), treeEventScopeId: 'scope',
        album: { photoCount: 5 } };
    g.nodes.set(album.uid, album);
    for (const node of g.nodes.values()) if (node.photo) node.photo.albums = [{ nodeUid: album.uid }];
    const writes: any[] = [];
    Object.assign(g.client, {
        async *iterateAlbums() { for (const node of g.nodes.values()) if (node.type === 'album' && node.uid.startsWith('own~')) yield node; },
        async *iterateSharedWithMeNodeUids() { for (const node of g.nodes.values()) if (node.type === 'album' && !node.uid.startsWith('own~')) yield node.uid; },
        async *iterateTimeline() { for (const node of g.nodes.values()) if (node.type === 'photo' && node.parentUid === 'own~root' && !node.photo.mainPhotoNodeUid) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async *iterateAlbum(uid: string) { for (const node of g.nodes.values()) if (node.type === 'photo' && !node.photo.mainPhotoNodeUid && node.photo.albums.some((a: any) => a.nodeUid === uid)) yield { nodeUid: node.uid, captureTime: node.photo.captureTime }; },
        async createAlbum(name: string) { writes.push(['create', name]); const node = { ...album, uid: 'own~new-album', name: { ok: true, value: name } }; g.nodes.set(node.uid, node); return node; },
        async updateAlbum(uid: string, update: any) { writes.push(['rename', uid, update]); const node = g.nodes.get(uid); node.name.value = update.name; return node; },
        async deleteAlbum(uid: string, options: any) { writes.push(['delete', uid, options]); g.nodes.delete(uid); },
        async *updatePhotos(settings: any[], signal: AbortSignal) {
            signal.throwIfAborted(); writes.push(['favourite', settings, signal]);
            for (const item of settings) {
                const node = g.nodes.get(item.nodeUid);
                node.photo.tags = [...new Set([...node.photo.tags, ...(item.tagsToAdd ?? [])])].filter(t => !item.tagsToRemove?.includes(t));
                if (item.tagsToAdd?.includes(PhotoTag.Favorites)) node.parentUid = 'own~root';
                yield { uid: node.uid, ok: true };
            }
        },
        async *savePhotosToTimeline(uids: string[], signal: AbortSignal) {
            signal.throwIfAborted(); writes.push(['save', uids, signal]);
            for (const uid of uids) { g.nodes.get(uid).parentUid = 'own~root'; yield { uid, ok: true }; }
        },
        async *addPhotosToAlbum(uid: string, uids: string[], signal: AbortSignal) {
            signal.throwIfAborted(); writes.push(['add', uid, uids, signal]);
            for (const id of uids) { g.nodes.get(id).photo.albums.push({ nodeUid: uid }); yield { uid: id, ok: true }; }
        },
        async *removePhotosFromAlbum(uid: string, uids: string[], signal: AbortSignal) {
            signal.throwIfAborted(); writes.push(['remove', uid, uids, signal]);
            for (const id of uids) { const node = g.nodes.get(id); node.photo.albums = node.photo.albums.filter((a: any) => a.nodeUid !== uid); yield { uid: id, ok: true }; }
        },
    });
    return { ...g, album, writes };
}

describe('photo management', () => {
    test('explicit album creation can initialise an empty Photos volume without duplicating its scheduler', async () => {
        const g = managementGallery(); let available = false, writableRequests = 0, schedulers = 0;
        const create = g.client.createAlbum.bind(g.client), scheduler = g.client.getEventScheduler.bind(g.client);
        (g.client as any).createAlbum = async (name: string) => { available = true; return create(name); };
        (g.client as any).getEventScheduler = async (callback: any) => { schedulers++; return scheduler(callback); };
        const library = new PhotoLibrary(async () => available ? g.client : null, undefined, undefined,
            async () => { writableRequests++; return g.client; });
        try {
            expect((await library.list({})).photos).toEqual([]);
            expect(writableRequests).toBe(0); expect(schedulers).toBe(0);
            expect((await library.createAlbum('First')).canWrite).toBe(true);
            await library.listAlbums();
            await library.createAlbum('Second'); await library.listAlbums();
            expect(writableRequests).toBe(1); expect(schedulers).toBe(1);
        } finally { library.reset(); }
    });
    test('favourites update only the main tag, preserve other tags, and invalidate old cursors', async () => {
        const g = managementGallery(), changes: number[] = [];
        const node = g.nodes.get('own~photo-1');
        node.parentUid = g.album.uid; node.photo.tags = [PhotoTag.LivePhotos, PhotoTag.Portraits];
        node.photo.relatedPhotoNodeUids = ['own~photo-2'];
        const library = new PhotoLibrary(async () => g.client, revision => changes.push(revision));
        try {
            const first = await library.list({ limit: 1 });
            const result = await library.manage({ operationId: 'fav', action: 'favourite', uids: [node.uid, node.uid], favourite: true });
            expect(result.results).toEqual([{ uid: node.uid, ok: true, error: null }]);
            expect(node.photo.tags).toEqual([PhotoTag.LivePhotos, PhotoTag.Portraits, PhotoTag.Favorites]);
            expect(g.nodes.get('own~photo-2').photo.tags).toEqual([]);
            expect(node.parentUid).toBe('own~root'); expect(node.photo.albums).toHaveLength(1);
            await expect(library.list({ cursor: first.nextCursor! })).rejects.toThrow('changed');
            expect((await library.list({ kind: 'favourites' })).photos.some(p => p.uid === node.uid)).toBe(true);
            await library.manage({ operationId: 'unfav', action: 'favourite', uids: [node.uid], favourite: false });
            expect(node.photo.tags).toEqual([PhotoTag.LivePhotos, PhotoTag.Portraits]); expect(changes).toHaveLength(2);
            expect(g.writes[0][1][0]).toEqual({ nodeUid: node.uid, tagsToAdd: [PhotoTag.Favorites] });
        } finally { library.reset(); }
    });
    test('create, rename and safe delete use public album methods; failures are never success', async () => {
        const g = managementGallery(), library = new PhotoLibrary(async () => g.client);
        try {
            await expect(library.createAlbum('  ')).rejects.toThrow('album name');
            const created = await library.createAlbum(' New ');
            expect(created.name).toBe('New'); expect(created.canDelete).toBe(true);
            const renamed = await library.renameAlbum(created.uid, 'Renamed'); expect(renamed.name).toBe('Renamed');
            await library.deleteAlbum(created.uid);
            expect(g.writes[2]).toEqual(['delete', created.uid, { saveToTimeline: true }]);
            expect((await library.listAlbums()).some(a => a.uid === created.uid)).toBe(false);
            (g.client as any).deleteAlbum = async (_uid: string, options: any) => {
                expect(options).toEqual({ saveToTimeline: true }); throw new Error('Album-only photo could not be saved');
            };
            await expect(library.deleteAlbum(g.album.uid)).rejects.toThrow('could not be saved');
            expect((await library.listAlbums()).some(a => a.uid === g.album.uid)).toBe(true);
        } finally { library.reset(); }
    });
    test('accepted shared albums honour inherited roles, fresh permission checks, and ownership', async () => {
        const g = managementGallery();
        const shared: any = { ...g.album, uid: 'other~album', parentUid: 'other~parent', treeEventScopeId: 'other-scope' };
        g.nodes.set(shared.uid, shared);
        g.nodes.set('other~parent', { uid: 'other~parent', directRole: 'editor', membership: { role: 'editor' } });
        const library = new PhotoLibrary(async () => g.client);
        try {
            const album = (await library.listAlbums()).find(a => a.uid === shared.uid)!;
            expect(album).toMatchObject({ sharedWithMe: true, canWrite: true, canDelete: false });
            await library.renameAlbum(shared.uid, 'Shared name');
            await expect(library.deleteAlbum(shared.uid)).rejects.toThrow('own');
            registerPhotoRefresh(g.client, async uids => {
                if (uids.includes('other~parent')) g.nodes.get('other~parent').directRole = g.nodes.get('other~parent').membership.role = 'viewer';
            });
            await expect(library.manage({ operationId: 'readonly', action: 'add', uids: ['own~photo-1'], albumUid: shared.uid })).rejects.toThrow('read-only');
            expect(g.writes).toHaveLength(1);
            const sharedPhoto = { ...photo(9), uid: 'other~photo', parentUid: shared.uid };
            g.nodes.set(sharedPhoto.uid, sharedPhoto);
            const result = await library.manage({ operationId: 'shared-fav', action: 'favourite', uids: [sharedPhoto.uid], favourite: true });
            expect(result.results[0].ok).toBe(false);
            expect((await library.getPhoto(sharedPhoto.uid)).canFavourite).toBe(false);
            await expect(library.trash([sharedPhoto.uid])).rejects.toThrow('own library');
        } finally { library.reset(); }
    });
    test('album removal preserves album-only originals first and removes linked assets explicitly', async () => {
        const g = managementGallery();
        const main = g.nodes.get('own~photo-1'), related = g.nodes.get('own~photo-2');
        main.parentUid = g.album.uid; main.photo.relatedPhotoNodeUids = [related.uid]; related.photo.mainPhotoNodeUid = main.uid;
        const library = new PhotoLibrary(async () => g.client);
        try {
            const result = await library.manage({ operationId: 'remove', action: 'remove', uids: [main.uid], albumUid: g.album.uid });
            expect(result.results[0].ok).toBe(true);
            expect(g.writes.map(w => w[0])).toEqual(['save', 'remove']);
            expect(g.writes[1][2]).toEqual([main.uid, related.uid]);
            expect(g.nodes.has(main.uid) && g.nodes.has(related.uid)).toBe(true);
            expect((await library.list({ albumUid: g.album.uid })).photos.some(p => p.uid === main.uid)).toBe(false);
            expect((await library.list({})).photos.some(p => p.uid === main.uid)).toBe(true);
        } finally { library.reset(); }
    });
    test('shared membership at a child does not hide a higher accessible ancestor role', async () => {
        const g = managementGallery();
        const child: any = { ...g.album, uid: 'other~nested', parentUid: 'other~parent', directRole: 'viewer', membership: { role: 'viewer' }, treeEventScopeId: 'other-scope' };
        g.nodes.set(child.uid, child);
        g.nodes.set('other~parent', { uid: 'other~parent', directRole: 'editor', membership: { role: 'editor' } });
        const library = new PhotoLibrary(async () => g.client);
        try {
            expect((await library.listAlbums()).find(a => a.uid === child.uid)?.canWrite).toBe(true);
            await library.renameAlbum(child.uid, 'Allowed');
            g.nodes.delete('other~parent'); child.membership.role = child.directRole = 'editor';
            await library.renameAlbum(child.uid, 'Direct share');
            expect(g.writes).toHaveLength(2);
        } finally { library.reset(); }
    });
    test('shared scopes use separate event cursors and are removed after a share disappears', async () => {
        const g = managementGallery();
        const shared: any = { ...g.album, uid: 'other~album', parentUid: undefined, directRole: 'viewer', treeEventScopeId: 'other-scope' };
        g.nodes.set(shared.uid, shared);
        const added: string[] = [], removed: string[] = [], cursors: any[] = [];
        let tick: (scope: string) => Promise<void> = async () => {};
        (g.client as any).getEventScheduler = async (callback: typeof tick) => { tick = callback; return { addScope(scope: string) { added.push(scope); }, removeScope(scope: string) { removed.push(scope); } }; };
        (g.client as any).iterateEvents = async function* (scope: string, cursor?: string) {
            cursors.push([scope, cursor]);
            if (!cursor) yield { type: 'fast_forward', eventId: `${scope}-base` };
            else if (scope === 'other-scope') yield { type: 'node_updated', nodeUid: shared.uid, eventId: 'other-next' };
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            await library.listAlbums(); expect(added).toEqual(['scope', 'other-scope']);
            await tick('other-scope'); await tick('scope');
            expect(cursors.slice(-2)).toEqual([['other-scope', 'other-scope-base'], ['scope', 'scope-base']]);
            g.nodes.delete(shared.uid); await library.listAlbums();
            expect(removed).toEqual(['other-scope']);
            library.reset(); expect(removed).toEqual(['other-scope', 'scope']);
        } finally { library.reset(); }
    });
    test('a failed shared event baseline can be retried without losing its subscription', async () => {
        const g = managementGallery(), added: string[] = [];
        const shared = { ...g.album, uid: 'other~album', parentUid: undefined, directRole: 'viewer', treeEventScopeId: 'other-scope' };
        g.nodes.set(shared.uid, shared);
        let fail = true;
        (g.client as any).getEventScheduler = async () => ({ addScope(scope: string) { added.push(scope); }, removeScope() {} });
        (g.client as any).iterateEvents = async function* (scope: string) {
            if (scope === 'other-scope' && fail) { fail = false; throw new Error('Temporary event failure'); }
            yield { type: 'fast_forward', eventId: `${scope}-base` };
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            await expect(library.listAlbums()).rejects.toThrow('Temporary event failure');
            expect(added).toEqual(['scope']);
            expect((await library.listAlbums()).some(a => a.uid === shared.uid)).toBe(true);
            expect(added).toEqual(['scope', 'other-scope']);
        } finally { library.reset(); }
    });
    test('revoked scopes notify the gallery and stop the pinned scheduler after it rearms', async () => {
        const g = managementGallery(), changes: number[] = [], errors: unknown[] = [];
        const shared = { ...g.album, uid: 'other~album', parentUid: undefined, directRole: 'viewer', treeEventScopeId: 'other-scope' };
        g.nodes.set(shared.uid, shared);
        let revoked = false, calls = 0, scheduler: EventScheduler, tick: (scope: string) => Promise<void>;
        (g.client as any).getEventScheduler = async (callback: typeof tick) => {
            tick = callback; scheduler = new EventScheduler(callback, 'scope'); return scheduler;
        };
        (g.client as any).iterateEvents = async function* (scope: string, cursor?: string) {
            calls++;
            if (!cursor) yield { type: 'fast_forward', eventId: `${scope}-base` };
            else if (scope === 'other-scope' && revoked) {
                g.nodes.delete(shared.uid);
                yield { type: 'tree_remove', treeEventScopeId: scope, eventId: 'none' };
                throw new Error('Volume no longer accessible');
            }
        };
        const library = new PhotoLibrary(async () => g.client, revision => changes.push(revision), error => errors.push(error));
        try {
            await library.listAlbums();
            const page = await library.list({ limit: 1 });
            await new Promise(resolve => setTimeout(resolve, 10));
            const state = (scheduler! as any).scopes.get('other-scope');
            revoked = true; (scheduler! as any).poll(state);
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(changes).toHaveLength(1); expect(errors).toEqual([]);
            expect((scheduler! as any).scopes.has('other-scope')).toBe(false);
            expect(state.timeoutHandle).toBeUndefined();
            await expect(library.list({ cursor: page.nextCursor! })).rejects.toThrow('changed');
            const before = calls; await tick!('other-scope'); expect(calls).toBe(before);
            expect((await library.listAlbums()).some(a => a.uid === shared.uid)).toBe(false);
        } finally { library.reset(); await new Promise(resolve => setTimeout(resolve, 10)); }
    });
    test('events applied before a later stream failure still invalidate visible pages', async () => {
        const g = gallery(3), changes: number[] = [], errors: unknown[] = [];
        let fail = false;
        (g.client as any).iterateEvents = async function* (_scope: string, cursor?: string) {
            if (!cursor) yield { type: 'fast_forward', eventId: 'base' };
            else if (fail) {
                g.nodes.delete('own~photo-1');
                yield { type: 'node_deleted', nodeUid: 'own~photo-1', eventId: 'next' };
                throw new Error('Connection lost');
            }
        };
        const library = new PhotoLibrary(async () => g.client, revision => changes.push(revision), error => errors.push(error));
        try {
            const page = await library.list({ limit: 1 }); fail = true;
            await g.event({});
            expect(changes).toHaveLength(1); expect(errors).toHaveLength(1);
            await expect(library.list({ cursor: page.nextCursor! })).rejects.toThrow('changed');
            expect((await library.list({})).photos.some(p => p.uid === 'own~photo-1')).toBe(false);
        } finally { library.reset(); }
    });
    test('reset during an in-flight event callback cancels the pinned scheduler rearm', async () => {
        const g = gallery(2), changes: number[] = [], errors: unknown[] = [];
        let scheduler: EventScheduler, wait = false, release: () => void = () => {}, entered: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        (g.client as any).getEventScheduler = async (callback: (scope: string) => Promise<void>) => {
            scheduler = new EventScheduler(callback, 'scope'); return scheduler;
        };
        (g.client as any).iterateEvents = async function* (_scope: string, cursor?: string) {
            if (!cursor) yield { type: 'fast_forward', eventId: 'base' };
            else if (wait) {
                entered();
                await gate;
                yield { type: 'node_deleted', nodeUid: 'own~photo-1', eventId: 'next' };
            }
        };
        const library = new PhotoLibrary(async () => g.client, revision => changes.push(revision), error => errors.push(error));
        try {
            await library.list({}); await new Promise(resolve => setTimeout(resolve, 10));
            const state = (scheduler! as any).scopes.get('scope');
            wait = true; (scheduler! as any).poll(state);
            await started;
            library.reset(); release();
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(changes).toHaveLength(1); expect(errors).toEqual([]);
            expect((scheduler! as any).scopes.has('scope')).toBe(false);
            expect(state.timeoutHandle).toBeUndefined();
        } finally { release(); library.reset(); await new Promise(resolve => setTimeout(resolve, 10)); }
    });
    test('failed preservation keeps membership and partial linked removal is reported', async () => {
        const g = managementGallery(), main = g.nodes.get('own~photo-1'); main.parentUid = g.album.uid;
        (g.client as any).savePhotosToTimeline = async function* (uids: string[]) { yield { uid: uids[0], ok: false, error: new Error('Quota exceeded') }; };
        const library = new PhotoLibrary(async () => g.client);
        try {
            let result = await library.manage({ operationId: 'save-fail', action: 'remove', uids: [main.uid], albumUid: g.album.uid });
            expect(result.results[0].error).toContain('Photo kept'); expect(g.writes).toEqual([]);
            expect(main.photo.albums).toHaveLength(1);
            main.parentUid = 'own~root'; main.photo.relatedPhotoNodeUids = ['own~photo-2'];
            (g.client as any).removePhotosFromAlbum = async function* (_uid: string, uids: string[]) {
                yield { uid: uids[0], ok: true }; yield { uid: uids[1], ok: false, error: new Error('Permission denied') };
            };
            result = await library.manage({ operationId: 'partial', action: 'remove', uids: [main.uid], albumUid: g.album.uid });
            expect(result.results[0].ok).toBe(false); expect(result.results[0].error).toContain('Permission denied');
        } finally { library.reset(); }
    });
    test('add passes main photos to the SDK, per-item failures continue, missing replies stay unconfirmed', async () => {
        const g = managementGallery(), calls: string[] = [];
        for (const node of g.nodes.values()) if (node.photo) node.photo.albums = [];
        (g.client as any).addPhotosToAlbum = async function* (_album: string, uids: string[], signal: AbortSignal) {
            expect(signal.aborted).toBe(false); expect(uids).toHaveLength(4); calls.push(...uids);
            for (const uid of uids) {
                if (uid === 'own~photo-1') yield { uid, ok: false, error: new Error('Permission denied') };
                else if (uid !== 'own~photo-2') yield { uid, ok: true };
            }
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            const result = await library.manage({ operationId: 'add', action: 'add', uids: ['own~photo-0', 'missing', 'own~photo-1', 'own~photo-2', 'own~photo-3'], albumUid: g.album.uid });
            expect(result.results.map(r => r.ok)).toEqual([true, false, false, false, true]);
            expect(result.results[3].error).toContain('not be confirmed'); expect(calls).toHaveLength(4);
        } finally { library.reset(); }
    });
    test('existing album membership is confirmed only after checking related files', async () => {
        const g = managementGallery(), main = g.nodes.get('own~photo-1');
        main.photo.relatedPhotoNodeUids = ['own~photo-2'];
        const library = new PhotoLibrary(async () => g.client);
        try {
            const input = { operationId: 'already-added', action: 'add' as const, uids: [main.uid], albumUid: g.album.uid };
            expect((await library.manage(input)).results).toEqual([{ uid: main.uid, ok: true, error: null }]);
            expect(g.writes).toEqual([]);
            g.nodes.get('own~photo-2').photo.albums = [];
            (g.client as any).addPhotosToAlbum = async function* () { yield { uid: main.uid, ok: false, error: new Error('Photo already exists in the album.') }; };
            expect((await library.manage(input)).results[0].ok).toBe(false);
        } finally { library.reset(); }
    });
    test('cancellation retains confirmed work and aborts remaining photos; queued calls cancel before writes', async () => {
        const g = managementGallery(), library = new PhotoLibrary(async () => g.client);
        (g.client as any).updatePhotos = async function* (settings: any[], signal: AbortSignal) {
            expect(signal.aborted).toBe(false);
            library.cancelOperation('cancel'); yield { uid: settings[0].nodeUid, ok: true };
        };
        try {
            const result = await library.manage({ operationId: 'cancel', action: 'favourite', uids: ['own~photo-1','own~photo-2'], favourite: true });
            expect(result.cancelled).toBe(true); expect(result.results.map(r => r.ok)).toEqual([true, false]);
            const pending = library.manage({ operationId: 'queued', action: 'add', uids: ['own~photo-1'], albumUid: g.album.uid });
            library.cancelOperation('queued');
            expect((await pending).results[0].ok).toBe(false); expect(g.writes).toEqual([]);
        } finally { library.reset(); }
    });
    test('lost write replies stay unconfirmed while reload bypasses stale SDK metadata', async () => {
        const g = managementGallery(), cached = new Map<string, any>();
        (g.client as any).getNode = async (uid: string) => {
            if (!cached.has(uid)) cached.set(uid, structuredClone(g.nodes.get(uid)));
            return cached.get(uid);
        };
        (g.client as any).iterateNodes = async function* (uids: string[]) { for (const uid of uids) yield await g.client.getNode(uid); };
        registerPhotoRefresh(g.client, async uids => { for (const uid of uids) cached.delete(uid); });
        (g.client as any).updatePhotos = async function* () {
            g.nodes.get('own~photo-1').photo.tags.push(PhotoTag.Favorites);
            throw new Error('Reply lost');
        };
        const library = new PhotoLibrary(async () => g.client);
        try {
            expect((await library.list({})).photos.find(p => p.uid === 'own~photo-1')?.favourite).toBe(false);
            const result = await library.manage({ operationId: 'lost', action: 'favourite', uids: ['own~photo-1'], favourite: true });
            expect(result.results[0].ok).toBe(false);
            expect(result.results[0].error).toContain('could not be confirmed');
            expect((await library.list({})).photos.find(p => p.uid === 'own~photo-1')?.favourite).toBe(true);
        } finally { library.reset(); }
    });
    test('reset aborts delayed management without old-account callbacks or writes', async () => {
        const g = managementGallery(); let release: () => void = () => {}, started: () => void = () => {};
        const barrier = new Promise<void>(resolve => { started = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const getNode = g.client.getNode.bind(g.client);
        (g.client as any).getNode = async (uid: string) => { if (uid === 'own~photo-1') { started(); await gate; } return getNode(uid); };
        const changes: number[] = [], library = new PhotoLibrary(async () => g.client, revision => changes.push(revision));
        const pending = library.manage({ operationId: 'reset', action: 'add', uids: ['own~photo-1'], albumUid: g.album.uid });
        await barrier; library.reset(); release();
        await expect(pending).rejects.toThrow(); expect(g.writes).toEqual([]); expect(changes).toHaveLength(1);
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
        related.name.value = '../name.jpg';
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
            expect(await fs.readFile(path.join(destination, '.._name.jpg'))).toEqual(Buffer.from([1,2,3,4]));
            expect((await fs.readdir(destination)).filter(n => n.includes('halyard-part'))).toEqual([]);
            expect((await fs.readdir(destination)).filter(n => n.startsWith('same'))).toHaveLength(3);
        } finally { await downloads.stop(); }
    }));
    test('rejects home escapes before creating a destination and refuses invalid photo names', async () => temporary(async root => {
        const home = path.join(root, 'home'), outside = path.join(root, 'outside');
        await fs.mkdir(home); await fs.mkdir(outside);
        await fs.symlink(outside, path.join(home, 'escape'));
        const node = photo(1);
        const downloads = new PhotoDownloads(async () => downloaderClient(new Map([[node.uid, node]])), undefined, undefined, home);
        try {
            await expect(downloads.start([node.uid], path.join(home, 'escape', 'must-not-create'))).rejects.toThrow('home directory');
            await expect(fs.stat(path.join(outside, 'must-not-create'))).rejects.toMatchObject({ code: 'ENOENT' });
            node.name.value = '..';
            await expect(downloads.start([node.uid], home)).rejects.toThrow('valid file name');
            expect(downloads.list()).toEqual([]);
        } finally { await downloads.stop(); }
    }));
    test('cancels pending work without saving files', async () => temporary(async home => {
        let release: (c: PhotosClient) => void = () => {};
        const client = downloaderClient(new Map([[photo(1).uid, photo(1)]])); let calls = 0;
        const downloads = new PhotoDownloads(async () => ++calls === 1 ? client : new Promise(r => { release = r; }), undefined, undefined, home);
        const job = await downloads.start(['own~photo-1'], home); await new Promise(r => setTimeout(r, 10));
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
    test('rejects non-images and outside paths before accessing the SDK', async () => temporary(async root => {
        const home = path.join(root, 'home'); await fs.mkdir(home);
        let calls = 0; const queue = new PhotoUploads(async () => { calls++; throw new Error('must not access SDK'); }, undefined, undefined, undefined, home);
        try {
            const bad = path.join(home, 'not-an-image.jpg'); await fs.writeFile(bad, 'not an image');
            const outside = path.join(root, 'outside.jpg'); await fs.writeFile(outside, jpeg);
            await expect(queue.start([{ path: bad, thumbnails: previews }])).rejects.toThrow('JPEG');
            await expect(queue.start([{ path: outside, thumbnails: previews }])).rejects.toThrow('home directory');
            expect(calls).toBe(0); expect(queue.list()).toEqual([]);
        } finally { await queue.stop(); }
    }));
});
