import type { EventScheduler, DriveEvent, NodeEntity, NodeResult } from '@protontech/drive-sdk';
import { MemberRole } from '@protontech/drive-sdk/dist/interface/nodes.js';
import { PhotoTag } from '@protontech/drive-sdk/dist/interface/photos.js';
import type { PhotoNode } from '@protontech/drive-sdk/dist/interface/photos.js';
import type { ProtonDrivePhotosClient } from '@protontech/drive-sdk/dist/protonDrivePhotosClient.js';

export type PhotosClient = Pick<ProtonDrivePhotosClient,
    'getMyPhotosRootFolder' | 'iterateTimeline' | 'iterateAlbum' | 'iterateAlbums' |
    'iterateNodes' | 'getNode' | 'iterateThumbnails' | 'getFileDownloader' |
    'getEventScheduler' | 'iterateEvents' | 'trashNodes' | 'iterateSharedWithMeNodeUids' |
    'createAlbum' | 'updateAlbum' | 'deleteAlbum' | 'addPhotosToAlbum' | 'removePhotosFromAlbum' |
    'savePhotosToTimeline' | 'updatePhotos'>;

const refreshers = new WeakMap<PhotosClient, (uids: string[]) => Promise<void>>();
export function registerPhotoRefresh(client: PhotosClient, refresh: (uids: string[]) => Promise<void>): void {
    refreshers.set(client, refresh);
}
const sameVolume = (a: string, b: string) => a.split('~')[0] === b.split('~')[0];

export type Photo = {
    uid: string;
    name: string;
    captureTime: number;
    size: number | null;
    mediaType: string;
    revisionUid: string;
    favourite: boolean;
    relatedUids: string[];
    error: string | null;
    canFavourite: boolean;
    canTrash: boolean;
};
export type PhotoAlbum = { uid: string; name: string; photoCount: number; coverPhotoUid: string | null;
    sharedWithMe: boolean; canWrite: boolean; canDelete: boolean };
export type PhotoManagementRequest = { operationId: string; action: 'favourite' | 'add' | 'remove';
    uids: string[]; albumUid?: string; favourite?: boolean };
export type PhotoManagementResult = { results: PhotoTrashResult[]; cancelled: boolean; revision: number };
export type PhotoQuery = { albumUid?: string; cursor?: string; limit?: number; search?: string; kind?: string; month?: string; year?: string };
type Placeholder = { nodeUid: string; captureTime: Date; tags?: number[] };
type Collection = { entries: Placeholder[]; seen: Set<string>; iterator: AsyncIterator<Placeholder>; done: boolean };
export type PhotoTrashResult = { uid: string; ok: boolean; error: string | null };
export type PhotoPage = { photos: Photo[]; nextCursor: string | null; revision: number };

export function photoFromNode(node: PhotoNode, rootUid?: string): Photo {
    return {
        uid: node.uid,
        name: node.name.ok ? node.name.value : 'Unavailable photo',
        captureTime: (node.photo?.captureTime ?? node.creationTime).getTime(),
        size: node.activeRevision?.claimedSize ?? null,
        mediaType: node.mediaType ?? '',
        revisionUid: node.activeRevision?.uid ?? '',
        favourite: node.photo?.tags.includes(PhotoTag.Favorites) ?? false,
        relatedUids: node.photo?.relatedPhotoNodeUids ?? [],
        error: node.name.ok ? null : 'The photo name could not be decrypted.',
        canFavourite: !!rootUid && sameVolume(node.uid, rootUid),
        canTrash: !!rootUid && sameVolume(node.uid, rootUid),
    };
}

/** An account-scoped, lazy gallery. No plaintext metadata or thumbnails on disk. */
export class PhotoLibrary {
    private collections = new Map<string, Collection>();
    private nodes = new Map<string, PhotoNode>();
    private root?: NodeEntity;
    private scheduler?: EventScheduler;
    private removeEventScope?: (scope: string) => void;
    private eventCursors = new Map<string, string | undefined>();
    private operations = new Map<string, AbortController>();
    private revision = 0;
    private lifetime = new AbortController();
    private ready?: Promise<PhotosClient | null>;
    private tail: Promise<unknown> = Promise.resolve();
    private thumbnails = new Map<string, string>();
    private thumbnailBytes = 0;

    private readonly getClient: () => Promise<PhotosClient | null>;
    private readonly changed: (revision: number) => void;
    private readonly reportError: (error: unknown) => void;
    constructor(getClient: () => Promise<PhotosClient | null>, changed: (revision: number) => void = () => {},
        reportError: (error: unknown) => void = () => {},
        private readonly getWritableClient: () => Promise<PhotosClient | null> = getClient) {
        this.getClient = getClient; this.changed = changed; this.reportError = reportError;
    }

    private exclusive<T>(work: () => Promise<T>): Promise<T> {
        const result = this.tail.then(work, work);
        this.tail = result.catch(() => {});
        return result;
    }

    private async initialise(): Promise<PhotosClient | null> {
        if (!this.ready) {
            const signal = this.lifetime.signal;
            this.ready = (async () => {
                const client = await this.getClient();
                signal.throwIfAborted();
                if (!client) return null;
                const root = await client.getMyPhotosRootFolder();
                signal.throwIfAborted();
                // Establish the cursor before listing so concurrent uploads
                // cannot slip between the initial enumeration and events.
                let cursor: string | undefined;
                for await (const event of client.iterateEvents(root.treeEventScopeId, undefined, signal)) {
                    signal.throwIfAborted();
                    cursor = event.eventId;
                }
                this.eventCursors.set(root.treeEventScopeId, cursor);
                const activeScopes = new Set<string>();
                const scheduler = await client.getEventScheduler(async (scope) => {
                    activeScopes.add(scope);
                    try {
                        if (signal.aborted || !this.eventCursors.has(scope)) return;
                        try { await this.exclusive(() => this.pullEvents(client, scope, signal)); }
                        catch (error) { if (!signal.aborted) this.reportError(error); }
                    } finally {
                        activeScopes.delete(scope);
                        if (signal.aborted || !this.eventCursors.has(scope)) {
                            // The pinned scheduler rearms in promise.finally,
                            // even after removal. Keep its scope registered
                            // until that runs, then cancel the new timer too.
                            setTimeout(() => {
                                if (signal.aborted || !this.eventCursors.has(scope)) scheduler.removeScope(scope);
                            }, 0).unref();
                        }
                    }
                });
                signal.throwIfAborted();
                this.root = root;
                this.scheduler = scheduler;
                this.removeEventScope = scope => {
                    if (!activeScopes.has(scope)) scheduler.removeScope(scope);
                };
                scheduler.addScope(this.root.treeEventScopeId);
                return client;
            })().catch((error) => { if (!signal.aborted) this.ready = undefined; throw error; });
        }
        return this.ready;
    }

    async list(query: PhotoQuery): Promise<PhotoPage> {
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            signal.throwIfAborted();
            const client = await this.initialise();
            signal.throwIfAborted();
            if (!client) {
                this.ready = undefined; // Another device can add its first photo later.
                return { photos: [], nextCursor: null, revision: this.revision };
            }
            const key = query.albumUid ?? '';
            const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 60)));
            let offset = 0;
            if (query.cursor) {
                const match = /^(\d+):(\d+)$/.exec(query.cursor);
                if (!match || Number(match[1]) !== this.revision) throw new Error('Your photo library changed. Reload the photos to continue.');
                offset = Number(match[2]);
            }
            let collection = this.collections.get(key);
            if (!collection) {
                collection = { entries: [], seen: new Set(), done: false, iterator: key
                    ? client.iterateAlbum(key, signal)[Symbol.asyncIterator]()
                    : client.iterateTimeline(signal)[Symbol.asyncIterator]() };
                this.collections.set(key, collection);
            }
            if (offset > collection.entries.length) throw new Error('The photo page is no longer available. Reload the photos.');
            // A filter examines at most 600 placeholders per request. Empty
            // filtered pages can still carry a cursor, keeping calls bounded.
            const result: Photo[] = [];
            let examined = 0;
            while (result.length < limit && examined < 600) {
                while (collection.entries.length < offset + 30 && !collection.done) {
                    let next: IteratorResult<Placeholder>;
                    try { next = await collection.iterator.next(); }
                    catch (error) {
                        signal.throwIfAborted();
                        // A throwing async generator is closed. A user retry
                        // must be able to resume past the placeholders retained
                        // here, instead of mistaking that closure for the end.
                        collection.iterator = key ? client.iterateAlbum(key, signal)[Symbol.asyncIterator]()
                            : client.iterateTimeline(signal)[Symbol.asyncIterator]();
                        throw error;
                    }
                    signal.throwIfAborted();
                    if (next.done) { collection.done = true; break; }
                    if (!collection.seen.has(next.value.nodeUid)) {
                        collection.seen.add(next.value.nodeUid);
                        collection.entries.push(next.value);
                    }
                }
                const batch = collection.entries.slice(offset, offset + Math.min(30, limit - result.length));
                if (!batch.length) break;
                // The SDK's timeline/album placeholders already include dates.
                // Jumping to an older year must not decrypt every newer photo.
                const inPeriod = (item: Placeholder) => {
                    const date = item.captureTime.toISOString();
                    return (!query.year || date.startsWith(`${query.year}-`)) && (!query.month || date.startsWith(`${query.month}-`));
                };
                const missing = batch.filter(p => inPeriod(p) && !this.nodes.has(p.nodeUid)).map(p => p.nodeUid);
                for await (const node of client.iterateNodes(missing, signal)) {
                    signal.throwIfAborted();
                    if (!('missingUid' in node)) this.nodes.set(node.uid, node);
                }
                for (const item of batch) {
                    offset++; examined++;
                    if (!inPeriod(item)) continue;
                    const node = this.nodes.get(item.nodeUid);
                    if (!node || node.trashTime) continue;
                    const photo = photoFromNode(node, this.root?.uid);
                    const month = new Date(photo.captureTime).toISOString().slice(0, 7);
                    if (query.month && month !== query.month) continue;
                    if (query.search && !photo.name.toLocaleLowerCase().includes(query.search.toLocaleLowerCase())) continue;
                    if (query.kind === 'favourites' && !photo.favourite) continue;
                    if (query.kind === 'videos' && !photo.mediaType.startsWith('video/')) continue;
                    result.push(photo);
                }
            }
            return { photos: result, nextCursor: collection.done && offset >= collection.entries.length
                ? null : `${this.revision}:${offset}`, revision: this.revision };
        });
    }

    async listAlbums(): Promise<PhotoAlbum[]> {
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            signal.throwIfAborted();
            const client = await this.initialise();
            signal.throwIfAborted();
            if (!client) { this.ready = undefined; return []; }
            // Explicit album browsing/reload also discovers accepted/revoked
            // shares, which the SDK's volume event stream does not enumerate.
            const albums: PhotoAlbum[] = [];
            const scopes = new Set([this.root!.treeEventScopeId]);
            for await (const node of client.iterateAlbums(signal)) {
                signal.throwIfAborted();
                if (node.name.ok && !node.trashTime) albums.push(await this.albumFromNode(client, node, signal));
            }
            const sharedUids: string[] = [];
            for await (const uid of client.iterateSharedWithMeNodeUids(signal)) sharedUids.push(uid);
            await refreshers.get(client)?.(sharedUids);
            for await (const node of client.iterateNodes(sharedUids, signal)) {
                signal.throwIfAborted();
                if ('missingUid' in node || node.type !== 'album' || node.trashTime || !node.name.ok || albums.some(a => a.uid === node.uid)) continue;
                albums.push(await this.albumFromNode(client, node, signal));
                scopes.add(node.treeEventScopeId);
                if (!this.eventCursors.has(node.treeEventScopeId)) {
                    let cursor: string | undefined;
                    for await (const event of client.iterateEvents(node.treeEventScopeId, undefined, signal)) {
                        signal.throwIfAborted();
                        cursor = event.eventId;
                    }
                    this.eventCursors.set(node.treeEventScopeId, cursor);
                    this.scheduler?.addScope(node.treeEventScopeId);
                }
            }
            for (const scope of this.eventCursors.keys()) if (!scopes.has(scope)) {
                this.eventCursors.delete(scope); this.removeEventScope?.(scope);
            }
            return albums.sort((a, b) => a.name.localeCompare(b.name));
        });
    }

    async getPhoto(uid: string): Promise<Photo> {
        const signal = this.lifetime.signal;
        const client = await this.initialise();
        signal.throwIfAborted();
        if (!client) throw new Error('No photos have been added to Proton Drive yet.');
        const node = await client.getNode(uid);
        signal.throwIfAborted();
        if (node.type !== 'photo' || node.trashTime) throw new Error('This photo is no longer available.');
        return photoFromNode(node, this.root?.uid);
    }

    async getThumbnails(uids: string[], preview = false): Promise<Array<{ uid: string; data: string | null; error: string | null }>> {
        if (uids.length > 12) throw new Error('Request at most 12 photo thumbnails at a time.');
        const signal = this.lifetime.signal;
        const client = await this.getClient();
        signal.throwIfAborted();
        if (!client) return [];
        const type = preview ? 2 : 1;
        const result = new Map<string, { uid: string; data: string | null; error: string | null }>();
        const missing: string[] = [];
        for (const uid of [...new Set(uids)]) {
            const key = `${type}:${uid}`;
            const data = this.thumbnails.get(key);
            if (data) {
                this.thumbnails.delete(key); this.thumbnails.set(key, data);
                result.set(uid, { uid, data, error: null });
            } else missing.push(uid);
        }
        for await (const thumb of client.iterateThumbnails(missing, type, signal)) {
            signal.throwIfAborted();
            if (thumb.ok && thumb.thumbnail.byteLength <= 3 * 1024 * 1024) {
                const data = Buffer.from(thumb.thumbnail).toString('base64');
                const key = `${type}:${thumb.nodeUid}`;
                this.thumbnailBytes -= this.thumbnails.get(key)?.length ?? 0;
                this.thumbnailBytes += data.length;
                this.thumbnails.set(key, data);
                while (this.thumbnailBytes > 32 * 1024 * 1024) {
                    const oldest = this.thumbnails.keys().next().value!;
                    this.thumbnailBytes -= this.thumbnails.get(oldest)!.length;
                    this.thumbnails.delete(oldest);
                }
                result.set(thumb.nodeUid, { uid: thumb.nodeUid, data, error: null });
            } else result.set(thumb.nodeUid, { uid: thumb.nodeUid, data: null,
                error: thumb.ok ? 'The preview is too large to display.' : thumb.error });
        }
        return uids.map(uid => result.get(uid) ?? { uid, data: null, error: 'No preview is available.' });
    }

    private async pullEvents(client: PhotosClient, scope: string, signal: AbortSignal): Promise<void> {
        if (signal.aborted || !this.eventCursors.has(scope)) return;
        let changed = false;
        try {
            for await (const event of client.iterateEvents(scope, this.eventCursors.get(scope), signal)) {
                signal.throwIfAborted();
                changed = (await this.applyEvent(client, event, signal)) || changed;
                if (event.type === 'tree_remove') {
                    this.eventCursors.delete(scope); this.removeEventScope?.(scope);
                    // The SDK throws the volume 404 after yielding removal.
                    // Stop here: removal is already a complete invalidation.
                    break;
                }
                if (event.eventId !== 'none') this.eventCursors.set(scope, event.eventId);
            }
        } finally {
            if (changed && !signal.aborted) this.changed(++this.revision);
        }
    }

    private async applyEvent(client: PhotosClient, event: DriveEvent, signal: AbortSignal): Promise<boolean> {
        if (event.type === 'fast_forward') return false;
        if (event.type === 'shared_with_me_updated') { this.collections.clear(); this.nodes.clear(); return true; }
        if (event.type === 'tree_refresh' || event.type === 'tree_remove') {
            // Re-enumeration is reserved for the SDK's explicit refresh event.
            this.collections.clear(); this.nodes.clear();
            this.thumbnails.clear(); this.thumbnailBytes = 0;
            return true;
        }
        this.nodes.delete(event.nodeUid);
        for (const type of [1, 2]) {
            const key = `${type}:${event.nodeUid}`;
            this.thumbnailBytes -= this.thumbnails.get(key)?.length ?? 0;
            this.thumbnails.delete(key);
        }
        if (event.type === 'node_deleted' || event.isTrashed) {
            this.collections.delete(event.nodeUid);
            for (const collection of this.collections.values()) {
                collection.entries = collection.entries.filter(p => p.nodeUid !== event.nodeUid);
                collection.seen.delete(event.nodeUid);
            }
            return true;
        }
        const node = await client.getNode(event.nodeUid);
        signal.throwIfAborted();
        if (node.type === 'album') { this.collections.delete(node.uid); return true; }
        if (node.type !== 'photo' || node.photo?.mainPhotoNodeUid) return false;
        this.nodes.set(node.uid, node);
        for (const [key, collection] of this.collections) {
            const included = key ? node.photo?.albums.some(a => a.nodeUid === key) : node.parentUid === this.root?.uid;
            collection.entries = collection.entries.filter(p => p.nodeUid !== node.uid);
            if (included) {
                collection.seen.add(node.uid);
                collection.entries.push({ nodeUid: node.uid, captureTime: node.photo?.captureTime ?? node.creationTime });
                collection.entries.sort((a, b) => b.captureTime.getTime() - a.captureTime.getTime());
            } else collection.seen.delete(node.uid);
        }
        return true;
    }

    private invalidate(): void {
        // Action-driven invalidation also covers cross-volume copies whose new
        // UID is not exposed by the SDK's NodeResult. No periodic enumeration.
        this.collections.clear(); this.nodes.clear();
        this.changed(++this.revision);
    }

    private async invalidateAfterWrite(client: PhotosClient, uids: string[], lifetime: AbortSignal): Promise<void> {
        if (lifetime.aborted) return;
        // A server write can finish even if its reply is lost, before the SDK
        // marks the old metadata stale. Explicit reload must read actual state.
        try { await refreshers.get(client)?.(uids); }
        catch (error) { if (!lifetime.aborted) this.reportError(error); }
        if (!lifetime.aborted) this.invalidate();
    }

    private async albumFromNode(client: PhotosClient, node: PhotoNode, signal: AbortSignal): Promise<PhotoAlbum> {
        const owned = !!this.root && sameVolume(node.uid, this.root.uid);
        let canWrite = owned;
        const seen = new Set<string>();
        let ancestor: PhotoNode | undefined = node;
        while (!owned && ancestor && !seen.has(ancestor.uid) && seen.size < 64) {
            signal.throwIfAborted();
            seen.add(ancestor.uid);
            const roles = [ancestor.directRole, ancestor.membership?.role];
            canWrite ||= roles.includes(MemberRole.Editor) || roles.includes(MemberRole.Admin);
            if (!ancestor.parentUid) break;
            try {
                await refreshers.get(client)?.([ancestor.parentUid]);
                ancestor = await client.getNode(ancestor.parentUid);
            } catch (error) {
                signal.throwIfAborted();
                // A directly shared node can remain accessible when its parent
                // is not. Traverse accessible parents for the highest role;
                // stop at the share boundary, never invent inherited access.
                if (ancestor.membership || ancestor.directRole !== MemberRole.Inherited) break;
                throw error;
            }
        }
        return { uid: node.uid, name: node.name.ok ? node.name.value : 'Unavailable album',
            photoCount: node.album?.photoCount ?? 0, coverPhotoUid: node.album?.coverPhotoNodeUid ?? null,
            sharedWithMe: !owned, canWrite, canDelete: owned };
    }

    private async requireAlbum(client: PhotosClient, uid: string, signal: AbortSignal, deleting = false): Promise<PhotoAlbum> {
        if (typeof uid !== 'string' || !uid) throw new Error('Choose an album.');
        // Permission changes can race the UI. Check fresh metadata before writes.
        await refreshers.get(client)?.([uid]);
        const node = await client.getNode(uid);
        signal.throwIfAborted();
        if (node.type !== 'album' || node.trashTime) throw new Error('This album is no longer available.');
        const album = await this.albumFromNode(client, node, signal);
        if (deleting ? !album.canDelete : !album.canWrite) {

            throw new Error(deleting ? 'Only albums you own can be deleted here.' : 'This album is read-only. Editing access is required.');
        }
        return album;
    }

    private albumName(name: string): string {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 255 || /[\x00-\x1f/\\]/.test(name)) {
            throw new Error('Enter an album name of at most 255 characters without slashes or control characters.');
        }
        return name.trim();
    }

    async createAlbum(name: string): Promise<PhotoAlbum> {
        name = this.albumName(name);
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            signal.throwIfAborted();
            const existing = await this.initialise();
            const client = existing ?? await this.getWritableClient();
            signal.throwIfAborted();
            if (!client) throw new Error('Your photo library is no longer available.');
            // Explicit creation may initialise a Photos volume, browsing may not.
            const root = this.root ?? await client.getMyPhotosRootFolder();
            signal.throwIfAborted();
            this.root = root;
            try {
                const node = await client.createAlbum(name);
                signal.throwIfAborted();
                return await this.albumFromNode(client, node, signal);
            } finally {
                if (!signal.aborted && !existing) this.ready = undefined;
                await this.invalidateAfterWrite(client, [], signal);
            }
        });
    }

    async renameAlbum(uid: string, name: string): Promise<PhotoAlbum> {
        name = this.albumName(name);
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            const client = await this.initialise();
            signal.throwIfAborted();
            if (!client) throw new Error('Your photo library is no longer available.');
            await this.requireAlbum(client, uid, signal);
            try {
                const node = await client.updateAlbum(uid, { name });
                signal.throwIfAborted();
                return await this.albumFromNode(client, node, signal);
            } finally { await this.invalidateAfterWrite(client, [uid], signal); }
        });
    }

    async deleteAlbum(uid: string): Promise<void> {
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            const client = await this.initialise();
            signal.throwIfAborted();
            if (!client) throw new Error('Your photo library is no longer available.');
            await this.requireAlbum(client, uid, signal, true);
            try {
                // Never force: SDK saves album-only originals first and refuses
                // deletion if any save fails (including related photo assets).
                await client.deleteAlbum(uid, { saveToTimeline: true });
                signal.throwIfAborted();
            } finally { await this.invalidateAfterWrite(client, [uid], signal); }
        });
    }

    cancelOperation(id: string): void { this.operations.get(id)?.abort(); }

    async manage(input: PhotoManagementRequest): Promise<PhotoManagementResult> {
        if (!input || !['favourite', 'add', 'remove'].includes(input.action) || !Array.isArray(input.uids) ||
            !input.uids.length || input.uids.length > 100 || input.uids.some(uid => typeof uid !== 'string' || !uid)) {
            throw new Error('Choose between 1 and 100 photos and a valid photo action.');
        }
        if (typeof input.operationId !== 'string' || !/^[\w-]{1,80}$/.test(input.operationId) || this.operations.has(input.operationId)) {
            throw new Error('This photo action has an invalid or active operation ID.');
        }
        if (input.action === 'favourite' ? typeof input.favourite !== 'boolean' : typeof input.albumUid !== 'string' || !input.albumUid) {
            throw new Error('Choose an album or a favourite setting.');
        }
        const controller = new AbortController();
        const lifetime = this.lifetime.signal;
        const signal = AbortSignal.any([lifetime, controller.signal]);
        this.operations.set(input.operationId, controller);
        const uids = [...new Set(input.uids)];
        return this.exclusive(async () => {
            const results = new Map<string, PhotoTrashResult>();
            const touched = new Set<string>();
            let attempted = false;
            let confirmedExisting = false;
            let client: PhotosClient | null = null;
            const collect = async (iterator: AsyncIterable<NodeResult>, expected: string[]) => {
                const found = new Map<string, PhotoTrashResult>();
                try {
                    for await (const result of iterator) {
                        found.set(result.uid, { uid: result.uid, ok: result.ok, error: result.ok ? null : result.error.message });
                    }
                } catch (error) {
                    for (const uid of expected) if (!found.has(uid)) found.set(uid, { uid, ok: false,
                        error: signal.aborted ? 'Cancelled; this change could not be confirmed.' : `${error instanceof Error ? error.message : String(error)} Change could not be confirmed.` });
                }
                return expected.map(uid => found.get(uid) ?? { uid, ok: false, error: 'This change could not be confirmed. Reload before trying again.' });
            };
            try {
                signal.throwIfAborted();
                client = await this.initialise();
                signal.throwIfAborted();
                if (!client) throw new Error('Your photo library is no longer available.');
                if (input.action !== 'favourite') await this.requireAlbum(client, input.albumUid!, signal);
                for (const uid of uids) {
                    if (signal.aborted) break;
                    try {
                        await refreshers.get(client)?.([uid]);
                        const node = await client.getNode(uid);
                        signal.throwIfAborted();
                        if (node.type !== 'photo' || node.trashTime || node.photo?.mainPhotoNodeUid) throw new Error('This photo is no longer available. Select its main photo.');
                        if (input.action === 'favourite' && !sameVolume(node.uid, this.root!.uid)) throw new Error('Only photos in your own library can have their favourites changed here.');
                        if (input.action === 'remove' && !node.photo?.albums.some(a => a.nodeUid === input.albumUid)) throw new Error('This photo is no longer in the album.');
                        if (input.action === 'add' && node.photo?.albums.some(a => a.nodeUid === input.albumUid)) {
                            const related = [...new Set(node.photo.relatedPhotoNodeUids)];
                            await refreshers.get(client)?.(related);
                            let complete = true;
                            for (const assetUid of related) {
                                const asset = await client.getNode(assetUid);
                                signal.throwIfAborted();
                                complete &&= asset.type === 'photo' && !asset.trashTime && !!asset.photo?.albums.some(a => a.nodeUid === input.albumUid);
                            }
                            if (complete) { confirmedExisting = true; results.set(uid, { uid, ok: true, error: null }); continue; }
                        }
                        // Let the SDK batch additions and favourite preparation.
                        // Removal needs preservation confirmed per main photo.
                        if (input.action !== 'remove') continue;
                        attempted = true;
                        touched.add(uid);
                        if (input.albumUid) touched.add(input.albumUid);
                        // Removing the last membership must not strand an
                        // album-only original. Saving includes related assets;
                        // shared-volume photos are copied into our timeline.
                        if (node.parentUid !== this.root!.uid) {
                            const [saved] = await collect(client.savePhotosToTimeline([uid], signal), [uid]);
                            if (!saved.ok) { results.set(uid, { ...saved, error: `Photo kept in the album: ${saved.error}` }); continue; }
                        }
                        signal.throwIfAborted();
                        const assets = [...new Set([uid, ...(node.photo?.relatedPhotoNodeUids ?? [])])];
                        if (assets.length > 1000) throw new Error('This photo has too many linked files to remove at once.');
                        for (const asset of assets) touched.add(asset);
                        // Unlike add, the pinned remove API does not expand
                        // related assets. Confirm every component explicitly.
                        const removed = await collect(client.removePhotosFromAlbum(input.albumUid!, assets, signal), assets);
                        const failed = removed.find(r => !r.ok);
                        results.set(uid, { uid, ok: !failed, error: failed ? `Some album membership changes could not be completed: ${failed.error}` : null });
                    } catch (error) {
                        results.set(uid, { uid, ok: false, error: signal.aborted ? 'Cancelled; this change could not be confirmed.' : error instanceof Error ? error.message : String(error) });
                    }
                }
                const eligible = uids.filter(uid => !results.has(uid));
                if (input.action !== 'remove' && eligible.length && !signal.aborted) {
                    attempted = true;
                    for (const uid of eligible) touched.add(uid);
                    if (input.albumUid) touched.add(input.albumUid);
                    // Favourite tags belong to main photos. The SDK includes
                    // live/motion assets when it moves them into the timeline.
                    const iterator = input.action === 'favourite'
                        ? client.updatePhotos(eligible.map(nodeUid => ({ nodeUid,
                            ...(input.favourite ? { tagsToAdd: [PhotoTag.Favorites] } : { tagsToRemove: [PhotoTag.Favorites] }) })), signal)
                        : client.addPhotosToAlbum(input.albumUid!, eligible, signal);
                    for (const result of await collect(iterator, eligible)) results.set(result.uid, result);
                }
            } catch (error) {
                if (!signal.aborted) throw error;
            } finally {
                if (this.operations.get(input.operationId) === controller) this.operations.delete(input.operationId);
                if (attempted && client) await this.invalidateAfterWrite(client, [...touched], lifetime);
                else if (confirmedExisting && !lifetime.aborted) this.invalidate();
            }
            lifetime.throwIfAborted();
            return { results: uids.map(uid => results.get(uid) ?? { uid, ok: false, error: 'Cancelled before this photo was changed.' }),
                cancelled: controller.signal.aborted, revision: this.revision };
        });
    }

    async trash(uids: string[]): Promise<PhotoTrashResult[]> {
        if (!uids.length || uids.length > 100 || uids.some(uid => typeof uid !== 'string' || !uid)) {
            throw new Error('Choose between 1 and 100 photos to move to Trash.');
        }
        const signal = this.lifetime.signal;
        return this.exclusive(async () => {
            signal.throwIfAborted();
            const client = await this.initialise();
            signal.throwIfAborted();
            if (!client) throw new Error('Your photo library is no longer available.');
            const nodes = new Set<string>();
            const pending = [...new Set(uids)];
            while (pending.length) {
                const uid = pending.shift()!;
                if (nodes.has(uid)) continue;
                if (nodes.size >= 1000) throw new Error('Choose fewer photos to move to Trash at once.');
                const node = await client.getNode(uid);
                signal.throwIfAborted();
                if (node.type !== 'photo') throw new Error('Only photos and videos can be moved to Trash here.');
                if (!this.root || !sameVolume(node.uid, this.root.uid)) throw new Error('Only photos in your own library can be moved to Trash here.');
                nodes.add(uid);
                pending.push(...(node.photo?.relatedPhotoNodeUids ?? []).filter(id => !nodes.has(id)));
            }
            const results: PhotoTrashResult[] = [];
            let changed = false;
            try {
                for await (const result of client.trashNodes([...nodes], signal)) {
                    signal.throwIfAborted();
                    results.push({ uid: result.uid, ok: result.ok, error: result.ok ? null : result.error.message });
                    if (result.ok) {
                        changed = true;
                        await this.applyEvent(client, {type:'node_deleted',nodeUid:result.uid,eventId:'none'} as DriveEvent, signal);
                    }
                }
                for (const uid of nodes) if (!results.some(r => r.uid === uid)) results.push({uid, ok:false, error:'Could not confirm that this photo was moved to Trash.'});
                return results;
            } finally { if (changed && !signal.aborted) this.changed(++this.revision); }
        });
    }

    async refreshUploaded(uid: string): Promise<void> {
        const signal = this.lifetime.signal;
        await this.exclusive(async () => {
            if (!this.root) { this.changed(++this.revision); return; }
            const client = await this.initialise();
            signal.throwIfAborted();
            if (client && await this.applyEvent(client, { type: 'node_created', nodeUid: uid, eventId: 'none' } as DriveEvent, signal)) {
                this.changed(++this.revision);
            }
        });
    }

    reset(): void {
        this.lifetime.abort();
        for (const scope of this.eventCursors.keys()) this.removeEventScope?.(scope);
        this.scheduler = undefined; this.removeEventScope = undefined; this.root = undefined; this.eventCursors.clear();
        this.operations.clear();
        this.lifetime = new AbortController(); this.ready = undefined;
        this.collections.clear(); this.nodes.clear();
        this.thumbnails.clear(); this.thumbnailBytes = 0;
        this.changed(++this.revision);
    }
}
