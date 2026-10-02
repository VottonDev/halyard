import type { EventScheduler, DriveEvent, NodeEntity } from '@protontech/drive-sdk';
import type { PhotoNode } from '@protontech/drive-sdk/dist/interface/photos.js';
import type { ProtonDrivePhotosClient } from '@protontech/drive-sdk/dist/protonDrivePhotosClient.js';

export type PhotosClient = Pick<ProtonDrivePhotosClient,
    'getMyPhotosRootFolder' | 'iterateTimeline' | 'iterateAlbum' | 'iterateAlbums' |
    'iterateNodes' | 'getNode' | 'iterateThumbnails' | 'getFileDownloader' |
    'getEventScheduler' | 'iterateEvents' | 'trashNodes'>;

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
};
export type PhotoAlbum = { uid: string; name: string; photoCount: number; coverPhotoUid: string | null };
export type PhotoQuery = { albumUid?: string; cursor?: string; limit?: number; search?: string; kind?: string; month?: string };
type Placeholder = { nodeUid: string; captureTime: Date; tags?: number[] };
type Collection = { entries: Placeholder[]; seen: Set<string>; iterator: AsyncIterator<Placeholder>; done: boolean };
export type PhotoTrashResult = { uid: string; ok: boolean; error: string | null };
export type PhotoPage = { photos: Photo[]; nextCursor: string | null; revision: number };

export function photoFromNode(node: PhotoNode): Photo {
    return {
        uid: node.uid,
        name: node.name.ok ? node.name.value : 'Unavailable photo',
        captureTime: (node.photo?.captureTime ?? node.creationTime).getTime(),
        size: node.activeRevision?.claimedSize ?? null,
        mediaType: node.mediaType ?? '',
        revisionUid: node.activeRevision?.uid ?? '',
        favourite: node.photo?.tags.includes(0) ?? false,
        relatedUids: node.photo?.relatedPhotoNodeUids ?? [],
        error: node.name.ok ? null : 'The photo name could not be decrypted.',
    };
}

/** An account-scoped, lazy gallery. No plaintext metadata or thumbnails on disk. */
export class PhotoLibrary {
    private collections = new Map<string, Collection>();
    private nodes = new Map<string, PhotoNode>();
    private albums: PhotoAlbum[] | null = null;
    private root?: NodeEntity;
    private scheduler?: EventScheduler;
    private eventCursor?: string;
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
        reportError: (error: unknown) => void = () => {}) {
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
                for await (const event of client.iterateEvents(root.treeEventScopeId, undefined, signal)) {
                    signal.throwIfAborted();
                    this.eventCursor = event.eventId;
                }
                const scheduler = await client.getEventScheduler(async (scope) => {
                    if (signal.aborted) return;
                    try { await this.exclusive(() => this.pullEvents(client, scope, signal)); }
                    catch (error) { if (!signal.aborted) this.reportError(error); }
                });
                signal.throwIfAborted();
                this.root = root;
                this.scheduler = scheduler;
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
                    const next = await collection.iterator.next();
                    signal.throwIfAborted();
                    if (next.done) { collection.done = true; break; }
                    if (!collection.seen.has(next.value.nodeUid)) {
                        collection.seen.add(next.value.nodeUid);
                        collection.entries.push(next.value);
                    }
                }
                const batch = collection.entries.slice(offset, offset + Math.min(30, limit - result.length));
                if (!batch.length) break;
                const missing = batch.filter(p => !this.nodes.has(p.nodeUid)).map(p => p.nodeUid);
                for await (const node of client.iterateNodes(missing, signal)) {
                    signal.throwIfAborted();
                    if (!('missingUid' in node)) this.nodes.set(node.uid, node);
                }
                for (const item of batch) {
                    offset++; examined++;
                    const node = this.nodes.get(item.nodeUid);
                    if (!node || node.trashTime) continue;
                    const photo = photoFromNode(node);
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
            if (this.albums) return this.albums;
            const albums: PhotoAlbum[] = [];
            for await (const node of client.iterateAlbums(signal)) {
                signal.throwIfAborted();
                if (node.name.ok && !node.trashTime) albums.push({ uid: node.uid, name: node.name.value,
                    photoCount: node.album?.photoCount ?? 0, coverPhotoUid: node.album?.coverPhotoNodeUid ?? null });
            }
            return this.albums = albums.sort((a, b) => a.name.localeCompare(b.name));
        });
    }

    async getPhoto(uid: string): Promise<Photo> {
        const signal = this.lifetime.signal;
        const client = await this.getClient();
        signal.throwIfAborted();
        if (!client) throw new Error('No photos have been added to Proton Drive yet.');
        const node = await client.getNode(uid);
        signal.throwIfAborted();
        if (node.type !== 'photo' || node.trashTime) throw new Error('This photo is no longer available.');
        return photoFromNode(node);
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
        let changed = false;
        for await (const event of client.iterateEvents(scope, this.eventCursor, signal)) {
            signal.throwIfAborted();
            changed = (await this.applyEvent(client, event, signal)) || changed;
            if (event.eventId !== 'none') this.eventCursor = event.eventId;
        }
        if (changed) this.changed(++this.revision);
    }

    private async applyEvent(client: PhotosClient, event: DriveEvent, signal: AbortSignal): Promise<boolean> {
        if (event.type === 'fast_forward' || event.type === 'shared_with_me_updated') return false;
        if (event.type === 'tree_refresh' || event.type === 'tree_remove') {
            // Re-enumeration is reserved for the SDK's explicit refresh event.
            this.collections.clear(); this.nodes.clear(); this.albums = null;
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
            for (const collection of this.collections.values()) {
                collection.entries = collection.entries.filter(p => p.nodeUid !== event.nodeUid);
                collection.seen.delete(event.nodeUid);
            }
            this.albums = null;
            return true;
        }
        const node = await client.getNode(event.nodeUid);
        signal.throwIfAborted();
        if (node.type === 'album') { this.albums = null; return true; }
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
        this.albums = null;
        return true;
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
        if (this.root) this.scheduler?.removeScope(this.root.treeEventScopeId);
        this.scheduler = undefined; this.root = undefined; this.eventCursor = undefined;
        this.lifetime = new AbortController(); this.ready = undefined;
        this.collections.clear(); this.nodes.clear(); this.albums = null;
        this.thumbnails.clear(); this.thumbnailBytes = 0;
        this.changed(++this.revision);
    }
}
