import { NodeType } from '@protontech/drive-sdk';
import * as dbus from 'dbus-next';

import { VERSION } from '../config.js';
import type { DriveSession } from '../drive/session.js';
import type { SyncManager } from '../engine/manager.js';
import type { HistoryFilter, SyncEventAction } from '../engine/types.js';
import { getLogger } from '../log.js';

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
 * structures — see docs/dbus-api.md. Sync state is a nested, still-evolving
 * shape, and marshalling it as a{sv} would make both ends brittle without
 * buying any real type safety.
 */
export class HalyardInterface extends Interface {
    constructor(
        private readonly manager: SyncManager,
        private readonly session: DriveSession,
        private readonly onQuit: () => void,
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
        try {
            await this.session.logout();
            // Tear down sync as well: the syncers hold a Drive client bound to
            // a session that no longer exists.
            this.manager.onSignedOut();
        } catch (error) {
            fail(error);
        }
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
            // My Files root — never neither.
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

    RemovePair(id: string, deleteLocalState: boolean): void {
        try {
            this.manager.removePair(id, deleteLocalState);
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
            const client = this.session.getClient();

            let uid = parentUid;
            let basePath = '';
            if (!uid) {
                const root = await client.getMyFilesRootFolder();
                uid = root.uid;
            } else {
                const hierarchy = await client.getNodeHierarchy(uid);
                basePath = hierarchy
                    .slice(1)
                    .map((node) => (node.name.ok ? node.name.value : '?'))
                    .join('/');
                basePath = basePath ? `/${basePath}` : '';
            }

            const childUids: string[] = [];
            for await (const childUid of client.iterateFolderChildrenNodeUids(uid, { type: NodeType.Folder })) {
                childUids.push(childUid);
            }

            const folders: Array<{ uid: string; name: string; path: string; hasChildren: boolean }> = [];
            for await (const node of client.iterateNodes(childUids)) {
                if ('missingUid' in node || node.type !== NodeType.Folder || node.trashTime) {
                    continue;
                }
                const name = node.name.ok ? node.name.value : null;
                if (!name) {
                    continue;
                }
                folders.push({
                    uid: node.uid,
                    name,
                    path: `${basePath}/${name}`,
                    hasChildren: await this.hasSubfolders(node.uid),
                });
            }

            folders.sort((a, b) => a.name.localeCompare(b.name));
            return JSON.stringify(folders);
        } catch (error) {
            return fail(error);
        }
    }

    /** Peeks for a single child so the picker can show a meaningful expander. */
    private async hasSubfolders(uid: string): Promise<boolean> {
        try {
            const client = this.session.getClient();
            for await (const _child of client.iterateFolderChildrenNodeUids(uid, { type: NodeType.Folder })) {
                return true;
            }
        } catch {
            // Not worth failing the whole listing over.
        }
        return false;
    }

    async CreateRemoteFolder(parentUid: string, name: string): Promise<string> {
        try {
            const client = this.session.getClient();
            const uid = parentUid || (await client.getMyFilesRootFolder()).uid;
            const node = await client.createFolder(uid, name);
            return JSON.stringify({
                uid: node.uid,
                name,
                path: name,
                hasChildren: false,
            });
        } catch (error) {
            return fail(error);
        }
    }

    // ---- Status and conflicts

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
    },
});
