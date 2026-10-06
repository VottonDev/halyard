import type { NodeEntity, NodeResult } from '@protontech/drive-sdk';
import type { PhotoNode } from '@protontech/drive-sdk/dist/interface/photos.js';
import { randomUUID } from 'node:crypto';

export type TrashSource = 'drive' | 'photos';
export type TrashItem = {
    uid: string; source: TrashSource; name: string; type: string;
    size: number | null; trashedAt: number | null; error: string | null;
};
export type TrashPage = { items: TrashItem[]; nextCursor: string | null };
export type TrashQuery = { source: TrashSource; requestId: string; cursor?: string };
export type TrashRestoreResult = TrashItem & {
    status: 'pending' | 'restored' | 'alreadyRestored' | 'failed' | 'unknown' | 'cancelled';
};
export type TrashRestore = {
    id: string; source: TrashSource; createdAt: number;
    status: 'running' | 'completed' | 'cancelled'; results: TrashRestoreResult[]; refreshError: string | null;
};
export type TrashClient = {
    iterateTrashedNodes(signal?: AbortSignal): AsyncGenerator<NodeEntity | PhotoNode>;
    getNode(uid: string): Promise<NodeEntity | PhotoNode>;
    restoreNodes(uids: string[], signal?: AbortSignal): AsyncGenerator<NodeResult>;
};
type Listing = { source: TrashSource; abort: AbortController; iterator?: AsyncIterator<NodeEntity | PhotoNode>;
    offset: number; busy: boolean; touched: number };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const supported = (source: TrashSource, node: NodeEntity) => source === 'drive'
    ? ['file', 'folder'].includes(node.type) : ['photo', 'album', 'folder'].includes(node.type);

function item(node: NodeEntity, source: TrashSource): TrashItem {
    return {
        uid: node.uid, source, name: node.name.ok ? node.name.value : 'Unavailable name', type: node.type,
        size: node.type === 'folder' || node.type === 'album' ? null : node.activeRevision?.claimedSize ?? null,
        trashedAt: node.trashTime?.getTime() ?? null,
        error: !supported(source, node) ? 'This type of item cannot be restored here.'
            : !node.name.ok ? 'The item name could not be decrypted. Use Proton Drive on the web to recover it.' : null,
    };
}

/** On-demand Trash only. No tree polling, permanent deletion or sync-base writes. */
export class TrashRecovery {
    private listings = new Map<string, Listing>();
    private known = new Map<string, TrashItem>();
    private calls = new Set<Promise<TrashPage>>();
    private jobs: TrashRestore[] = [];
    private current?: { job: TrashRestore; abort: AbortController; running: Promise<void> };
    private stopping = false;
    private emitTimer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly getClient: (source: TrashSource) => Promise<TrashClient | null>,
        private readonly refreshNodes: (uids: string[]) => Promise<void>,
        private readonly afterRestore: (source: TrashSource, uids: string[]) => Promise<void>,
        private readonly changed: (jobs: TrashRestore[]) => void = () => {},
        private readonly notify: (warning: boolean, body: string) => void = () => {},
    ) {}

    listRestores(): TrashRestore[] { return structuredClone(this.jobs); }

    list(query: TrashQuery): Promise<TrashPage> {
        if (this.stopping) return Promise.reject(new Error('Wait for Trash recovery to stop.'));
        const call = this.load(query);
        this.calls.add(call);
        void call.then(() => this.calls.delete(call), () => this.calls.delete(call));
        return call;
    }

    private async load(query: TrashQuery): Promise<TrashPage> {
        if (!['drive', 'photos'].includes(query.source) || !/^[a-zA-Z0-9_-]{1,80}$/.test(query.requestId)) {
            throw new Error('The Trash listing request is invalid.');
        }
        // Idle cursors are disposable. Bound memory without a polling timer.
        for (const [id, listing] of this.listings) {
            if (!listing.busy && Date.now() - listing.touched > 5 * 60_000) this.cancelListing(id);
        }
        let listing = this.listings.get(query.requestId);
        if (!query.cursor) {
            if (listing) throw new Error('This Trash listing is already open. Refresh to start a new listing.');
            if (this.listings.size >= 8) throw new Error('Close or refresh an existing Trash listing before opening another.');
            listing = { source: query.source, abort: new AbortController(), offset: 0, busy: false, touched: Date.now() };
            this.listings.set(query.requestId, listing);
        } else if (!listing || listing.source !== query.source || query.cursor !== `${query.requestId}:${listing.offset}`) {
            throw new Error('This Trash page has expired. Refresh to continue.');
        }
        if (listing.busy) throw new Error('Wait for the current Trash page to load.');
        listing.busy = true;
        const signal = listing.abort.signal;
        try {
            if (!listing.iterator) {
                const client = await this.getClient(query.source);
                signal.throwIfAborted();
                if (!client) { this.cancelListing(query.requestId); return { items: [], nextCursor: null }; }
                listing.iterator = client.iterateTrashedNodes(signal)[Symbol.asyncIterator]();
            }
            const items: TrashItem[] = [];
            let done = false;
            // Page in SDK order. A full last page may have an empty successor.
            for (let n = 0; n < 50; n++) {
                const next = await listing.iterator.next();
                signal.throwIfAborted();
                if (next.done) { done = true; break; }
                const entry = item(next.value, query.source);
                items.push(entry);
                this.known.set(`${query.source}:${entry.uid}`, entry);
                if (this.known.size > 20_000) this.known.delete(this.known.keys().next().value!);
            }
            listing.offset += items.length;
            listing.touched = Date.now();
            if (done) this.cancelListing(query.requestId);
            return { items, nextCursor: done ? null : `${query.requestId}:${listing.offset}` };
        } catch (error) {
            this.cancelListing(query.requestId);
            throw error;
        } finally { listing.busy = false; }
    }

    cancelListing(id: string): void {
        const listing = this.listings.get(id);
        if (!listing) return;
        listing.abort.abort();
        this.listings.delete(id);
        void listing.iterator?.return?.().catch(() => {});
    }

    start(source: TrashSource, uids: string[]): TrashRestore {
        if (this.stopping) throw new Error('Wait for Trash recovery to stop.');
        if (this.current) throw new Error('Wait for the current restore to finish or cancel it.');
        if (!['drive', 'photos'].includes(source) || !Array.isArray(uids) || !uids.length || uids.length > 100 ||
            uids.some(uid => typeof uid !== 'string' || !uid)) throw new Error('Select between 1 and 100 items to restore.');
        const results = [...new Set(uids)].map(uid => {
            const entry = this.known.get(`${source}:${uid}`);
            if (!entry) throw new Error('This Trash item is no longer listed. Refresh and select it again.');
            if (entry.error) throw new Error(entry.error);
            return { ...entry, status: 'pending' as const };
        });
        const job: TrashRestore = { id: randomUUID(), source, createdAt: Date.now(), status: 'running', results, refreshError: null };
        this.jobs.unshift(job); this.jobs = this.jobs.slice(0, 20);
        const abort = new AbortController();
        // Defer the worker so cancellation always sees an installed job.
        const running = Promise.resolve().then(() => this.restore(job, abort.signal)).finally(() => {
            this.current = undefined;
            this.emit();
        });
        this.current = { job, abort, running };
        this.emit();
        return structuredClone(job);
    }

    cancelRestore(id: string): void {
        const job = this.jobs.find(entry => entry.id === id);
        if (!job) throw new Error('This restore request is no longer available.');
        if (this.current?.job === job) this.current.abort.abort();
    }

    private async restore(job: TrashRestore, signal: AbortSignal): Promise<void> {
        const nodes = new Map<string, NodeEntity | PhotoNode>();
        const inFlight = new Set<string>();
        const related = new Set<string>();
        const resultFor = (uid: string) => job.results.find(entry => entry.uid === uid)!;
        try {
            signal.throwIfAborted();
            const client = await this.getClient(job.source);
            signal.throwIfAborted();
            if (!client) throw new Error('Your photo Trash is no longer available.');
            // Resolve related photo assets as well, so a live photo is not
            // silently restored without its still image or video companion.
            for (let index = 0; index < job.results.length; index++) {
                const result = job.results[index];
                try {
                    await this.refreshNodes([result.uid]);
                    signal.throwIfAborted();
                    const node = await client.getNode(result.uid);
                    signal.throwIfAborted();
                    const fresh = item(node, job.source);
                    Object.assign(result, fresh);
                    if (fresh.error) throw new Error(fresh.error);
                    if (related.has(node.uid) && node.type !== 'photo') throw new Error('A related photo asset is not a photo or video. Restore it separately on the web.');
                    if (!node.trashTime) result.status = 'alreadyRestored';
                    else nodes.set(node.uid, node);
                    if (job.source === 'photos' && node.type === 'photo') {
                        for (const uid of (node as PhotoNode).photo?.relatedPhotoNodeUids ?? []) {
                            if (job.results.some(entry => entry.uid === uid)) continue;
                            if (job.results.length >= 1000) throw new Error('This selection has too many related photo assets. Restore fewer photos at once.');
                            related.add(uid);
                            job.results.push({ uid, source: job.source, name: 'Related photo asset', type: 'photo', size: null,
                                trashedAt: null, error: null, status: 'pending' });
                        }
                    }
                } catch (error) {
                    if (signal.aborted) throw error;
                    result.status = 'failed'; result.error = message(error); nodes.delete(result.uid);
                }
            }
            this.emit();
            while (nodes.size) {
                signal.throwIfAborted();
                // A selected parent must finish before a child is restored.
                const ready = [...nodes.values()].filter(node => !node.parentUid || !nodes.has(node.parentUid));
                if (!ready.length) throw new Error('The original folder hierarchy could not be resolved. Restore it on the web.');
                const uids: string[] = [];
                for (const node of ready) {
                    const result = resultFor(node.uid);
                    try {
                        // Restoring a parent may already have restored this
                        // child. Refresh its own state before a second request.
                        await this.refreshNodes([node.uid]);
                        signal.throwIfAborted();
                        const current = await client.getNode(node.uid);
                        signal.throwIfAborted();
                        if (!current.trashTime) {
                            result.status = 'alreadyRestored'; nodes.delete(node.uid); continue;
                        }
                        if (!current.parentUid) throw new Error('The original parent is unavailable. Restore this item using Proton Drive on the web.');
                        await this.refreshNodes([current.parentUid]);
                        signal.throwIfAborted();
                        const parent = await client.getNode(current.parentUid);
                        signal.throwIfAborted();
                        if (parent.trashTime) throw new Error('The original parent folder is in Trash. Restore that folder first, then retry this item.');
                        uids.push(node.uid);
                    } catch (error) {
                        if (signal.aborted) throw error;
                        result.status = 'failed'; result.error = message(error); nodes.delete(node.uid);
                    }
                }
                if (!uids.length) continue;
                signal.throwIfAborted();
                uids.forEach(uid => inFlight.add(uid));
                try {
                    for await (const response of client.restoreNodes(uids, signal)) {
                        if (!inFlight.has(response.uid)) continue;
                        const result = resultFor(response.uid);
                        result.status = response.ok ? 'unknown' : 'failed';
                        result.error = response.ok ? 'The restore was reported successful; confirmation is pending.' : response.error.message;
                        if (response.ok) {
                            // Pinned SDK synthesises successful NodeResults
                            // for omitted per-link response entries. Confirm
                            // the actual node state with one targeted read.
                            try {
                                await this.refreshNodes([response.uid]);
                                const restored = await client.getNode(response.uid);
                                if (restored.trashTime) throw new Error('The item is still in Trash.');
                                result.status = 'restored'; result.error = null;
                            } catch (error) {
                                result.status = 'unknown';
                                result.error = `The restore was reported successful but could not be confirmed. Refresh Trash before retrying. ${message(error)}`;
                            }
                        }
                        inFlight.delete(response.uid); nodes.delete(response.uid);
                        this.emit(false);
                    }
                } catch (error) {
                    for (const uid of inFlight) {
                        resultFor(uid).status = 'unknown';
                        resultFor(uid).error = `Could not confirm the restore. Refresh Trash before retrying. ${message(error)}`;
                        nodes.delete(uid);
                    }
                }
                for (const uid of inFlight) {
                    resultFor(uid).status = 'unknown';
                    resultFor(uid).error ||= 'The server did not return a result for this item. Refresh Trash before retrying.';
                    nodes.delete(uid);
                }
                inFlight.clear();
            }
        } catch (error) {
            for (const result of job.results) if (result.status === 'pending') {
                result.status = signal.aborted ? 'cancelled' : 'failed';
                result.error = signal.aborted ? null : message(error);
            }
        } finally {
            const restored = job.results.filter(result => ['restored', 'alreadyRestored', 'unknown'].includes(result.status)).map(result => result.uid);
            if (restored.length) {
                for (const [id, listing] of this.listings) if (listing.source === job.source) this.cancelListing(id);
                try {
                    await this.refreshNodes(restored);
                    await this.afterRestore(job.source, restored);
                } catch (error) { job.refreshError = `Restore results are shown below, but refreshing the view failed: ${message(error)}`; }
            }
            job.status = signal.aborted ? 'cancelled' : 'completed';
            const count = job.results.filter(result => result.status === 'restored').length;
            const problems = job.results.filter(result => ['failed', 'unknown'].includes(result.status)).length;
            this.notify(!!problems || !!job.refreshError, `${count} ${count === 1 ? 'item restored' : 'items restored'}${problems ? `; ${problems} need attention` : ''}${signal.aborted ? '; remaining work cancelled' : ''}.`);
        }
    }

    async stop(clear = false): Promise<void> {
        this.stopping = true;
        for (const id of this.listings.keys()) this.cancelListing(id);
        this.current?.abort.abort();
        await Promise.allSettled([...this.calls, ...(this.current ? [this.current.running] : [])]);
        if (clear) { this.jobs = []; this.known.clear(); }
        this.stopping = false;
        this.emit();
    }

    private emit(immediate = true): void {
        if (immediate) {
            if (this.emitTimer) clearTimeout(this.emitTimer);
            this.emitTimer = undefined;
            this.changed(this.listRestores());
        } else if (!this.emitTimer) {
            this.emitTimer = setTimeout(() => {
                this.emitTimer = undefined;
                this.changed(this.listRestores());
            }, 250);
        }
    }
}
