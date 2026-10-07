import * as dbus from 'dbus-next';

import { VERSION } from '../config.js';
import { createRemoteFolder, listRemoteFolders } from '../drive/folders.js';
import type { DriveSession } from '../drive/session.js';
import type { SyncManager } from '../engine/manager.js';
import type { HistoryFilter, SyncEventAction } from '../engine/types.js';
import { getLogger } from '../log.js';
import type { PhotoLibrary, PhotoQuery, PhotoManagementRequest } from '../photos/library.js';
import type { PhotoVideos } from '../photos/videos.js';
import type { PhotoUploads, UploadInput } from '../photos/uploads.js';
import type { PhotoDownloads } from '../photos/downloads.js';

const logger = getLogger('dbus');

/** Accepted `ListHistory` action filters, mirroring SyncEventAction. */
const HISTORY_ACTIONS = new Set<string>([
    'downloaded',
    'updatedLocal',
    'uploaded',
    'updatedRemote',
    'deletedLocal',
    'trashedRemote',
    'movedLocal',
    'movedRemote',
    'createdLocalFolder',
    'createdRemoteFolder',
] satisfies SyncEventAction[]);

export const BUS_NAME = 'io.github.votton.Halyard.Daemon';
export const OBJECT_PATH = '/io/github/votton/Halyard/Daemon';
export const INTERFACE_NAME = 'io.github.votton.Halyard.Daemon';
const ERROR_NAME = 'io.github.votton.Halyard.Error.Failed';

const { Interface } = dbus.interface;

/** Coerces untrusted JSON into a clean string list. */
function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function fail(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    throw new dbus.DBusError(ERROR_NAME, message);
}

/**
 * The daemon's public surface.
 *
 * Structured payloads cross the bus as JSON strings rather than typed D-Bus
 * structures. See docs/dbus-api.md. Sync state is a nested, still-changing
 * shape, and marshalling it as a{sv} would make both ends brittle without
 * buying any real type safety.
 */
export class HalyardInterface extends Interface {
    private signingOut = false;

    private requirePhotoAccess(): void {
        if (this.signingOut) throw new Error('Wait for sign-out to finish before starting a photo transfer.');
        this.session.getClient();
    }
    constructor(
        private readonly manager: SyncManager,
        private readonly session: DriveSession,
        private readonly onQuit: () => void,
        private readonly photos: PhotoLibrary,
        private readonly downloads: PhotoDownloads,
        private readonly uploads: PhotoUploads,
        private readonly videos: PhotoVideos,
    ) {
        super(INTERFACE_NAME);
    }

    // ---- Account

    async GetAccount(): Promise<string> {
        try {
            return JSON.stringify(await this.session.getAccount());
        } catch (error) {
            return fail(error);
        }
    }

    async BeginLogin(): Promise<string> {
        try {
            const signInUrl = await this.session.beginLogin();
            return JSON.stringify({ signInUrl });
        } catch (error) {
            return fail(error);
        }
    }

    CancelLogin(): void {
        this.session.cancelLogin();
    }

    async Logout(): Promise<void> {
        if (this.signingOut) fail(new Error('Sign-out is already in progress.'));
        this.signingOut = true;
        try {
            await this.downloads.stop(true);
            await this.uploads.stop(true);
            await this.videos.stop();
            this.photos.reset();
            await this.session.logout();
            // Tear down sync as well: the syncers hold a Drive client bound to
            // a session that no longer exists.
            this.manager.onSignedOut();
        } catch (error) {
            fail(error);
        } finally { this.signingOut = false; }
    }

    // ---- Pairs

    ListPairs(): string {
        try {
            return JSON.stringify(this.manager.getStatus().pairs);
        } catch (error) {
            return fail(error);
        }
    }

    async AddPair(newPair: string): Promise<string> {
        try {
            const input = JSON.parse(newPair) as Record<string, unknown>;
            const localPath = typeof input.localPath === 'string' ? input.localPath : '';
            const remoteUid = typeof input.remoteUid === 'string' ? input.remoteUid : '';
            const createRemote = input.createRemote === true;
            if (!localPath) {
                throw new Error('localPath is required');
            }
            // Either point at an existing folder, or ask for a new one at the
            // My Files root. One of the two is required.
            if (!remoteUid && !createRemote) {
                throw new Error('remoteUid is required unless createRemote is set');
            }

            const pair = await this.manager.addPair({
                localPath,
                remoteUid,
                remotePath: typeof input.remotePath === 'string' ? input.remotePath : '',
                excludes: toStringArray(input.excludes),
                createRemote,
                remoteName: typeof input.remoteName === 'string' ? input.remoteName : '',
            });
            const status = this.manager.getStatus().pairs.find((entry) => entry.id === pair.id);
            return JSON.stringify(status ?? pair);
        } catch (error) {
            return fail(error);
        }
    }

    async UpdatePair(id: string, patch: string): Promise<string> {
        try {
            const parsed = JSON.parse(patch) as Record<string, unknown>;

            // Whitelist rather than pass through: the patch arrives as
            // untyped JSON and must not be able to set internal fields like
            // the event cursor.
            const allowed: Record<string, unknown> = {};
            if (typeof parsed.enabled === 'boolean') {
                allowed.enabled = parsed.enabled;
            }
            if (typeof parsed.localPath === 'string' && parsed.localPath) {
                allowed.localPath = parsed.localPath;
            }
            if (typeof parsed.remoteUid === 'string' && parsed.remoteUid) {
                allowed.remoteUid = parsed.remoteUid;
            }
            if (typeof parsed.remotePath === 'string' && parsed.remotePath) {
                allowed.remotePath = parsed.remotePath;
            }
            // Present-but-empty is meaningful here: it clears every exclusion.
            if (parsed.excludes !== undefined) {
                allowed.excludes = toStringArray(parsed.excludes);
            }
            if (Object.keys(allowed).length === 0) {
                throw new Error('No supported fields in patch');
            }

            await this.manager.updatePair(id, allowed);
            const status = this.manager.getStatus().pairs.find((entry) => entry.id === id);
            return JSON.stringify(status);
        } catch (error) {
            return fail(error);
        }
    }

    async RemovePair(id: string, deleteLocalState: boolean): Promise<void> {
        try {
            await this.manager.removePair(id, deleteLocalState);
        } catch (error) {
            fail(error);
        }
    }

    SyncNow(id: string): void {
        void this.manager.syncAll(id || undefined).catch((error) => logger.error('Manual sync failed', error));
    }

    SetPaused(paused: boolean): void {
        this.manager.setPaused(paused);
    }

    // ---- Remote browsing

    async ListRemoteFolders(parentUid: string): Promise<string> {
        try {
            return JSON.stringify(await listRemoteFolders(this.session.getClient(), parentUid));
        } catch (error) {
            return fail(error);
        }
    }

    async CreateRemoteFolder(parentUid: string, name: string): Promise<string> {
        try {
            return JSON.stringify(await createRemoteFolder(this.session.getClient(), parentUid, name));
        } catch (error) {
            return fail(error);
        }
    }

    // ---- Status and conflicts

    async ListPhotos(filter: string): Promise<string> {
        try {
            const input = JSON.parse(filter || '{}') as Record<string, unknown>;
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The photo filter is invalid.');
            const query: PhotoQuery = {};
            for (const field of ['albumUid', 'cursor', 'search', 'month', 'year'] as const) {
                if (typeof input[field] === 'string') query[field] = input[field].slice(0, 512);
            }
            if (query.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) throw new Error('Choose a valid month.');
            if (query.year && !/^\d{4}$/.test(query.year)) throw new Error('Choose a valid year.');
            if (typeof input.limit === 'number' && Number.isFinite(input.limit)) query.limit = input.limit;
            if (input.kind === 'favourites' || input.kind === 'videos') query.kind = input.kind;
            return JSON.stringify(await this.photos.list(query));
        } catch (error) { return fail(error); }
    }

    async ListPhotoAlbums(): Promise<string> {
        try { return JSON.stringify(await this.photos.listAlbums()); }
        catch (error) { return fail(error); }
    }

    async GetPhoto(uid: string): Promise<string> {
        try { return JSON.stringify(await this.photos.getPhoto(uid)); }
        catch (error) { return fail(error); }
    }

    async CreatePhotoAlbum(name: string): Promise<string> {
        try { this.requirePhotoAccess(); return JSON.stringify(await this.photos.createAlbum(name)); }
        catch (error) { return fail(error); }
    }

    async RenamePhotoAlbum(request: string): Promise<string> {
        try {
            this.requirePhotoAccess();
            if (request.length > 4096) throw new Error('Choose an album and a name of at most 255 characters.');
            const input = JSON.parse(request) as { uid?: unknown; name?: unknown } | null;
            if (!input || typeof input.uid !== 'string' || typeof input.name !== 'string') throw new Error('Choose an album and enter its new name.');
            return JSON.stringify(await this.photos.renameAlbum(input.uid, input.name));
        } catch (error) { return fail(error); }
    }

    async DeletePhotoAlbum(uid: string): Promise<void> {
        try { this.requirePhotoAccess(); await this.photos.deleteAlbum(uid); }
        catch (error) { fail(error); }
    }

    async ManagePhotos(request: string): Promise<string> {
        try {
            this.requirePhotoAccess();
            if (request.length > 128 * 1024) throw new Error('Choose fewer photos at once.');
            return JSON.stringify(await this.photos.manage(JSON.parse(request) as PhotoManagementRequest));
        } catch (error) { return fail(error); }
    }

    CancelPhotoOperation(id: string): void {
        try { this.requirePhotoAccess(); this.photos.cancelOperation(id); }
        catch (error) { fail(error); }
    }

    async GetPhotoThumbnails(request: string): Promise<string> {
        try {
            const input = JSON.parse(request) as { uids?: unknown; preview?: unknown };
            if (!Array.isArray(input.uids) || input.uids.some(uid => typeof uid !== 'string' || !uid)) {
                throw new Error('Choose the photos to preview.');
            }
            return JSON.stringify(await this.photos.getThumbnails(input.uids, input.preview === true));
        } catch (error) { return fail(error); }
    }

    async StartPhotoDownload(request: string): Promise<string> {
        try {
            this.requirePhotoAccess();
            const input = JSON.parse(request) as { uids?: unknown; destination?: unknown };
            if (!Array.isArray(input.uids) || typeof input.destination !== 'string') throw new Error('Choose photos and a download folder.');
            return JSON.stringify(await this.downloads.start(input.uids, input.destination));
        } catch (error) { return fail(error); }
    }

    ListPhotoDownloads(): string {
        try { this.session.getClient(); return JSON.stringify(this.downloads.list()); }
        catch (error) { return fail(error); }
    }

    ControlPhotoDownload(id: string, action: string): void {
        try { this.session.getClient(); this.downloads.control(id, action); }
        catch (error) { fail(error); }
    }

    async TrashPhotos(request: string): Promise<string> {
        try {
            this.requirePhotoAccess();
            const input = JSON.parse(request) as {uids?: unknown};
            if (!Array.isArray(input.uids)) throw new Error('Choose photos to move to Trash.');
            const results = await this.photos.trash(input.uids);
            for (const result of results) if (result.ok) this.videos.releasePhoto(result.uid);
            return JSON.stringify(results);
        } catch (error) {return fail(error);}
    }
    async StartVideoPreview(uid: string): Promise<string> {
        try {this.requirePhotoAccess();return JSON.stringify(await this.videos.start(uid));}
        catch (error) {return fail(error);}
    }
    ReleaseVideoPreview(id: string): void {this.videos.release(id);}

    async StartPhotoUpload(request: string): Promise<string> {
        try {
            this.requirePhotoAccess();
            if (request.length > 34 * 1024 * 1024) throw new Error('Choose fewer images to upload at once.');
            const input = JSON.parse(request) as { files?: UploadInput[] };
            return JSON.stringify(await this.uploads.start(input.files!));
        } catch (error) { return fail(error); }
    }
    ListPhotoUploads(): string {
        try { this.session.getClient(); return JSON.stringify(this.uploads.list()); }
        catch (error) { return fail(error); }
    }
    ControlPhotoUpload(id: string, action: string): void {
        try { this.session.getClient(); this.uploads.control(id, action); }
        catch (error) { fail(error); }
    }

    GetStatus(): string {
        try {
            return JSON.stringify(this.manager.getStatus());
        } catch (error) {
            return fail(error);
        }
    }

    ListConflicts(pairId: string): string {
        try {
            return JSON.stringify(this.manager.listConflicts(pairId || undefined));
        } catch (error) {
            return fail(error);
        }
    }

    async ResolveConflict(conflictId: string, resolution: string): Promise<void> {
        try {
            if (!['keepLocal', 'keepRemote', 'dismiss'].includes(resolution)) {
                throw new Error(`Unknown resolution: ${resolution}`);
            }
            await this.manager.resolveConflict(conflictId, resolution as 'keepLocal' | 'keepRemote' | 'dismiss');
        } catch (error) {
            fail(error);
        }
    }

    // ---- Activity log

    ListHistory(filter: string): string {
        try {
            const parsed = (filter ? JSON.parse(filter) : {}) as Record<string, unknown>;

            // Whitelisted like UpdatePair: this arrives as untyped JSON and
            // feeds a SQL query, so nothing unrecognised gets through.
            const query: HistoryFilter = {};
            if (typeof parsed.pairId === 'string' && parsed.pairId) {
                query.pairId = parsed.pairId;
            }
            const actions = toStringArray(parsed.actions).filter((action): action is SyncEventAction =>
                HISTORY_ACTIONS.has(action),
            );
            if (actions.length > 0) {
                query.actions = actions;
            }
            if (parsed.outcome === 'ok' || parsed.outcome === 'failed') {
                query.outcome = parsed.outcome;
            }
            if (typeof parsed.search === 'string' && parsed.search.trim()) {
                query.search = parsed.search.trim();
            }
            if (typeof parsed.beforeId === 'number' && Number.isFinite(parsed.beforeId)) {
                query.beforeId = Math.floor(parsed.beforeId);
            }
            if (typeof parsed.limit === 'number' && Number.isFinite(parsed.limit)) {
                query.limit = Math.floor(parsed.limit);
            }

            return JSON.stringify(this.manager.listHistory(query));
        } catch (error) {
            return fail(error);
        }
    }

    ClearHistory(pairId: string): void {
        try {
            this.manager.clearHistory(pairId || undefined);
        } catch (error) {
            fail(error);
        }
    }

    GetVersion(): string {
        return VERSION;
    }

    Quit(): void {
        this.onQuit();
    }

    // ---- Signals (dbus-next emits when these are called)

    StatusChanged(status: string): string {
        return status;
    }

    LoginStateChanged(state: string): string {
        return state;
    }

    Notify(notification: string): string {
        return notification;
    }

    PhotosChanged(change: string): string { return change; }
    PhotoDownloadsChanged(downloads: string): string { return downloads; }
    PhotoUploadsChanged(uploads: string): string { return uploads; }
    VideoPreviewChanged(preview: string): string { return preview; }
}

HalyardInterface.configureMembers({
    methods: {
        GetAccount: { inSignature: '', outSignature: 's' },
        BeginLogin: { inSignature: '', outSignature: 's' },
        CancelLogin: { inSignature: '', outSignature: '' },
        Logout: { inSignature: '', outSignature: '' },

        ListPairs: { inSignature: '', outSignature: 's' },
        AddPair: { inSignature: 's', outSignature: 's' },
        UpdatePair: { inSignature: 'ss', outSignature: 's' },
        RemovePair: { inSignature: 'sb', outSignature: '' },
        SyncNow: { inSignature: 's', outSignature: '' },
        SetPaused: { inSignature: 'b', outSignature: '' },

        ListRemoteFolders: { inSignature: 's', outSignature: 's' },
        CreateRemoteFolder: { inSignature: 'ss', outSignature: 's' },
        ListPhotos: { inSignature: 's', outSignature: 's' },
        ListPhotoAlbums: { inSignature: '', outSignature: 's' },
        GetPhoto: { inSignature: 's', outSignature: 's' },
        CreatePhotoAlbum: { inSignature: 's', outSignature: 's' },
        RenamePhotoAlbum: { inSignature: 's', outSignature: 's' },
        DeletePhotoAlbum: { inSignature: 's', outSignature: '' },
        ManagePhotos: { inSignature: 's', outSignature: 's' },
        CancelPhotoOperation: { inSignature: 's', outSignature: '' },
        GetPhotoThumbnails: { inSignature: 's', outSignature: 's' },
        StartPhotoDownload: { inSignature: 's', outSignature: 's' },
        TrashPhotos: { inSignature: 's', outSignature: 's' },
        StartVideoPreview: { inSignature: 's', outSignature: 's' },
        ReleaseVideoPreview: { inSignature: 's', outSignature: '' },
        StartPhotoUpload: { inSignature: 's', outSignature: 's' },
        ListPhotoUploads: { inSignature: '', outSignature: 's' },
        ControlPhotoUpload: { inSignature: 'ss', outSignature: '' },
        ListPhotoDownloads: { inSignature: '', outSignature: 's' },
        ControlPhotoDownload: { inSignature: 'ss', outSignature: '' },

        GetStatus: { inSignature: '', outSignature: 's' },
        ListConflicts: { inSignature: 's', outSignature: 's' },
        ResolveConflict: { inSignature: 'ss', outSignature: '' },
        ListHistory: { inSignature: 's', outSignature: 's' },
        ClearHistory: { inSignature: 's', outSignature: '' },
        GetVersion: { inSignature: '', outSignature: 's' },
        Quit: { inSignature: '', outSignature: '' },
    },
    signals: {
        StatusChanged: { signature: 's' },
        LoginStateChanged: { signature: 's' },
        Notify: { signature: 's' },
        PhotosChanged: { signature: 's' },
        PhotoDownloadsChanged: { signature: 's' },
        PhotoUploadsChanged: { signature: 's' },
        VideoPreviewChanged: { signature: 's' },
    },
});
