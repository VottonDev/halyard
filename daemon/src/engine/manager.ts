import type { EventScheduler, ProtonDriveClient } from '@protontech/drive-sdk';
import { watch, type FSWatcher } from 'chokidar';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { DriveSession } from '../drive/session.js';
import { getLogger } from '../log.js';
import { SyncDatabase } from './db.js';
import type { Progress } from './execute.js';
import { isIgnoredName } from './localScan.js';
import { PairSyncer } from './pair.js';
import type { Conflict, Pair } from './types.js';

const logger = getLogger('manager');

/** Local changes are bursty; wait for quiet before acting on them. */
const LOCAL_DEBOUNCE_MS = 2_000;
/** Backstop cycle, in case an event or filesystem notification is missed. */
const PERIODIC_SYNC_MS = 15 * 60_000;

export type Status = {
    version: string;
    loggedIn: boolean;
    email: string | null;
    paused: boolean;
    online: boolean;
    activity: (Progress & { pairId: string }) | null;
    pairs: Array<{
        id: string;
        localPath: string;
        remotePath: string;
        remoteUid: string;
        enabled: boolean;
        status: string;
        lastSyncAt: number | null;
        error: string | null;
        stats: PairSyncer['stats'];
    }>;
};

/**
 * Owns every pair: their watchers, their schedules, and the shared Drive event
 * subscription. Everything the D-Bus layer exposes goes through here.
 */
export class SyncManager {
    private readonly db = new SyncDatabase();
    private syncers = new Map<string, PairSyncer>();
    private watchers = new Map<string, FSWatcher>();
    private debounces = new Map<string, NodeJS.Timeout>();
    private scheduler?: EventScheduler;
    private periodic?: NodeJS.Timeout;
    private abort = new AbortController();

    private activity: (Progress & { pairId: string }) | null = null;
    private paused: boolean;
    private statusListeners: Array<(status: Status) => void> = [];
    private notifyListeners: Array<(kind: 'info' | 'warning' | 'error', title: string, body: string) => void> = [];
    private emitTimer?: NodeJS.Timeout;

    constructor(private readonly session: DriveSession) {
        this.paused = this.db.getSetting('paused') === '1';
    }

    onStatusChanged(listener: (status: Status) => void): void {
        this.statusListeners.push(listener);
    }

    onNotify(listener: (kind: 'info' | 'warning' | 'error', title: string, body: string) => void): void {
        this.notifyListeners.push(listener);
    }

    private notify(kind: 'info' | 'warning' | 'error', title: string, body: string): void {
        for (const listener of this.notifyListeners) {
            listener(kind, title, body);
        }
    }

    /**
     * Status is emitted on a short timer rather than synchronously: transfer
     * progress fires continuously, and pushing every update straight onto the
     * bus would flood it for no visible benefit.
     */
    private scheduleEmit(): void {
        if (this.emitTimer) {
            return;
        }
        this.emitTimer = setTimeout(() => {
            this.emitTimer = undefined;
            const status = this.getStatus();
            for (const listener of this.statusListeners) {
                try {
                    listener(status);
                } catch (error) {
                    logger.error('Status listener failed', error);
                }
            }
        }, 250);
    }

    async start(): Promise<void> {
        if (!this.session.isLoggedIn()) {
            logger.info('Not signed in; sync is idle until sign-in completes');
            this.scheduleEmit();
            return;
        }

        // start() runs again after a sign-in, so clear anything a previous
        // call left behind rather than stacking a second timer on top.
        if (this.periodic) {
            clearInterval(this.periodic);
            this.periodic = undefined;
        }

        for (const pair of this.db.listPairs()) {
            this.ensureSyncer(pair);
            if (pair.enabled) {
                this.startWatching(pair);
            }
        }

        await this.startEventScheduler();

        this.periodic = setInterval(() => {
            void this.syncAll();
        }, PERIODIC_SYNC_MS);

        void this.syncAll();
        this.scheduleEmit();
    }

    /**
     * Subscribes to Drive events. The SDK decides the polling cadence — Proton
     * requires event-based sync and treats independent polling as abuse, so we
     * let the scheduler drive rather than inventing our own interval.
     */
    private async startEventScheduler(): Promise<void> {
        if (this.scheduler) {
            return;
        }
        try {
            const client = this.session.getClient();
            this.scheduler = await client.getEventScheduler(async (scopeId: string) => {
                const affected = [...this.syncers.values()].filter(
                    (syncer) => syncer.pair.treeEventScopeId === scopeId && syncer.pair.enabled,
                );
                for (const syncer of affected) {
                    await this.runSync(syncer);
                }
            });

            for (const syncer of this.syncers.values()) {
                if (syncer.pair.treeEventScopeId) {
                    this.scheduler.addScope(syncer.pair.treeEventScopeId);
                }
            }
        } catch (error) {
            logger.error('Could not start the Drive event scheduler', error);
        }
    }

    private ensureSyncer(pair: Pair): PairSyncer {
        const existing = this.syncers.get(pair.id);
        if (existing) {
            existing.updatePair(pair);
            return existing;
        }
        const syncer = new PairSyncer(
            pair,
            this.db,
            this.session.getClient(),
            (progress) => {
                this.activity = progress ? { ...progress, pairId: pair.id } : null;
                this.scheduleEmit();
            },
            () => this.scheduleEmit(),
        );
        this.syncers.set(pair.id, syncer);
        return syncer;
    }

    private startWatching(pair: Pair): void {
        if (this.watchers.has(pair.id)) {
            return;
        }
        const watcher = watch(pair.localPath, {
            ignoreInitial: true,
            persistent: true,
            followSymlinks: false,
            // Wait for writes to settle: syncing a file mid-save uploads a
            // truncated copy and then immediately has to upload it again.
            awaitWriteFinish: { stabilityThreshold: 1_500, pollInterval: 200 },
            ignored: (target: string) => target.split(path.sep).some((segment) => isIgnoredName(segment)),
        });

        watcher.on('all', () => this.onLocalChange(pair.id));
        watcher.on('error', (error) => logger.warn(`Watcher for pair ${pair.id} failed: ${error}`));
        this.watchers.set(pair.id, watcher);
        logger.info(`Watching ${pair.localPath}`);
    }

    private stopWatching(pairId: string): void {
        const watcher = this.watchers.get(pairId);
        if (watcher) {
            void watcher.close();
            this.watchers.delete(pairId);
        }
        const timer = this.debounces.get(pairId);
        if (timer) {
            clearTimeout(timer);
            this.debounces.delete(pairId);
        }
    }

    private onLocalChange(pairId: string): void {
        const existing = this.debounces.get(pairId);
        if (existing) {
            clearTimeout(existing);
        }
        this.debounces.set(
            pairId,
            setTimeout(() => {
                this.debounces.delete(pairId);
                const syncer = this.syncers.get(pairId);
                if (syncer) {
                    void this.runSync(syncer);
                }
            }, LOCAL_DEBOUNCE_MS),
        );
    }

    private async runSync(syncer: PairSyncer): Promise<void> {
        if (this.paused || !syncer.pair.enabled || !this.session.isLoggedIn()) {
            return;
        }
        const before = syncer.status;
        await syncer.sync(this.abort.signal);

        if (syncer.status === 'error' && before !== 'error' && syncer.error) {
            this.notify('error', 'Sync problem', `${path.basename(syncer.pair.localPath)}: ${syncer.error}`);
        }
        this.scheduleEmit();
    }

    async syncAll(pairId?: string): Promise<void> {
        const targets = pairId
            ? [this.syncers.get(pairId)].filter((value): value is PairSyncer => !!value)
            : [...this.syncers.values()];
        // Sequential on purpose: pairs share one API session and one rate
        // limit, and hammering Drive from several pairs at once is exactly
        // what gets a client throttled.
        for (const syncer of targets) {
            await this.runSync(syncer);
        }
    }

    // ---- Operations exposed over D-Bus

    listPairs(): Pair[] {
        return this.db.listPairs();
    }

    async addPair(input: { localPath: string; remoteUid: string; remotePath: string }): Promise<Pair> {
        // Check before writing anything: creating the syncer needs a Drive
        // client, and failing after the insert would leave an orphaned pair.
        if (!this.session.isLoggedIn()) {
            throw new Error('Sign in to Proton Drive before adding a folder pair');
        }

        const localPath = await this.validateTarget(input.localPath, input.remoteUid, input.remotePath);

        // If these exact folders were paired before and the state was kept,
        // pick up where we left off rather than starting from scratch.
        const revived = this.db.findRemovedPair(localPath, input.remoteUid);
        let pair: Pair;
        if (revived) {
            logger.info(`Reviving previously removed pair for ${localPath}`);
            this.db.markPairRemoved(revived.id, false);
            pair = { ...revived, enabled: true };
        } else {
            pair = {
                id: `p_${randomUUID().slice(0, 8)}`,
                localPath,
                remoteUid: input.remoteUid,
                remotePath: input.remotePath,
                enabled: true,
                treeEventScopeId: null,
                eventCursor: null,
                createdAt: Date.now(),
                lastSyncAt: null,
            };
            this.db.insertPair(pair);
        }

        const syncer = this.ensureSyncer(pair);
        this.startWatching(pair);
        void this.runSync(syncer).then(() => {
            if (syncer.pair.treeEventScopeId) {
                this.scheduler?.addScope(syncer.pair.treeEventScopeId);
            }
        });

        this.scheduleEmit();
        return pair;
    }

    /**
     * Checks a prospective pair target and returns the resolved local path.
     * Overlapping pairs would fight over the same files, so they are refused.
     */
    private async validateTarget(
        rawLocalPath: string,
        remoteUid: string,
        remotePath: string,
        ignorePairId?: string,
    ): Promise<string> {
        const localPath = path.resolve(rawLocalPath.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));

        const stats = await fsp.stat(localPath).catch(() => null);
        if (!stats) {
            await fsp.mkdir(localPath, { recursive: true });
        } else if (!stats.isDirectory()) {
            throw new Error(`${localPath} is not a folder`);
        }

        for (const existing of this.db.listPairs()) {
            if (existing.id === ignorePairId) {
                continue;
            }
            if (
                existing.localPath === localPath ||
                localPath.startsWith(existing.localPath + path.sep) ||
                existing.localPath.startsWith(localPath + path.sep)
            ) {
                throw new Error(`${localPath} overlaps the existing pair for ${existing.localPath}`);
            }
            if (existing.remoteUid === remoteUid) {
                throw new Error(`${remotePath} is already synced to ${existing.localPath}`);
            }
        }

        return localPath;
    }

    /**
     * Applies changes to a pair. Beyond enabling and disabling, a pair can be
     * re-pointed at different folders — which invalidates everything we knew
     * about it, since the recorded state refers to the old paths and node ids.
     *
     * Discarding that state is safe: with no base, the next sync treats both
     * sides as new and merges them. Nothing is deleted, and files that differ
     * become conflicts with both copies kept.
     */
    async updatePair(id: string, patch: Partial<Pair>): Promise<Pair> {
        const existing = this.db.getPair(id);
        if (!existing) {
            throw new Error(`No such pair: ${id}`);
        }

        const wantsLocal = patch.localPath !== undefined;
        const wantsRemote = patch.remoteUid !== undefined;
        let nextLocalPath = existing.localPath;

        if (wantsLocal || wantsRemote) {
            nextLocalPath = await this.validateTarget(
                patch.localPath ?? existing.localPath,
                patch.remoteUid ?? existing.remoteUid,
                patch.remotePath ?? existing.remotePath,
                id,
            );
        }

        const retargeted =
            nextLocalPath !== existing.localPath ||
            (wantsRemote && patch.remoteUid !== existing.remoteUid);

        // The watcher holds the old path; stop it before anything moves.
        this.stopWatching(id);

        this.db.updatePair(id, { ...patch, localPath: nextLocalPath });

        if (retargeted) {
            logger.info(`Pair ${id} re-targeted; discarding stale sync state`);
            this.db.clearBase(id);
            this.db.clearRemoteNodes(id);
            this.db.updatePair(id, { treeEventScopeId: null, eventCursor: null, lastSyncAt: null });
        }

        const updated = this.db.getPair(id)!;
        const syncer = this.syncers.get(id);
        syncer?.updatePair(updated);
        if (retargeted && syncer) {
            syncer.stats = { pending: 0, conflicts: 0, filesUp: 0, filesDown: 0, bytesUp: 0, bytesDown: 0 };
        }

        if (updated.enabled) {
            this.startWatching(updated);
            if (syncer) {
                void this.runSync(syncer);
            }
        }

        this.scheduleEmit();
        return updated;
    }

    removePair(id: string, deleteLocalState: boolean): void {
        this.stopWatching(id);
        const syncer = this.syncers.get(id);
        if (syncer?.pair.treeEventScopeId) {
            const stillUsed = [...this.syncers.values()].some(
                (other) => other.pair.id !== id && other.pair.treeEventScopeId === syncer.pair.treeEventScopeId,
            );
            if (!stillUsed) {
                this.scheduler?.removeScope(syncer.pair.treeEventScopeId);
            }
        }
        this.syncers.delete(id);

        if (deleteLocalState) {
            this.db.deletePair(id);
        } else {
            // Keep the sync state but hide the pair. Re-adding the same folders
            // then resumes from what we already know instead of re-hashing and
            // re-transferring the lot. The user's files are untouched either way.
            this.db.markPairRemoved(id, true);
        }
        this.scheduleEmit();
    }

    setPaused(paused: boolean): void {
        this.paused = paused;
        this.db.setSetting('paused', paused ? '1' : '0');
        if (!paused) {
            void this.syncAll();
        }
        this.scheduleEmit();
    }

    isPaused(): boolean {
        return this.paused;
    }

    listConflicts(pairId?: string): Conflict[] {
        return this.db.listConflicts(pairId);
    }

    async resolveConflict(id: string, resolution: 'keepLocal' | 'keepRemote' | 'dismiss'): Promise<void> {
        const conflict = this.db.getConflict(id);
        if (!conflict) {
            throw new Error(`No such conflict: ${id}`);
        }
        const pair = this.db.getPair(conflict.pairId);
        if (!pair) {
            this.db.deleteConflict(id);
            return;
        }

        if (resolution === 'keepLocal' && conflict.keptCopyPath && conflict.keptCopyPath !== conflict.path) {
            // Promote the preserved local copy over the remote version.
            const kept = path.join(pair.localPath, conflict.keptCopyPath);
            const target = path.join(pair.localPath, conflict.path);
            await fsp.rename(kept, target);
            this.db.deleteBaseEntry(pair.id, conflict.path);
            this.db.deleteBaseEntry(pair.id, conflict.keptCopyPath);
        } else if (resolution === 'keepRemote' && conflict.keptCopyPath && conflict.keptCopyPath !== conflict.path) {
            // The remote version already holds the canonical path; retire the copy.
            const kept = path.join(pair.localPath, conflict.keptCopyPath);
            await fsp.rm(kept, { force: true }).catch(() => undefined);
            this.db.deleteBaseEntry(pair.id, conflict.keptCopyPath);
        }

        this.db.deleteConflict(id);
        const syncer = this.syncers.get(pair.id);
        if (syncer) {
            syncer.stats.conflicts = this.db.countConflicts(pair.id);
            void this.runSync(syncer);
        }
        this.scheduleEmit();
    }

    getStatus(): Status {
        const account = this.session.isLoggedIn();
        return {
            version: process.env.HALYARD_VERSION ?? '0.1.0',
            loggedIn: account,
            email: this.cachedEmail,
            paused: this.paused,
            online: true,
            activity: this.activity,
            pairs: this.db.listPairs().map((pair) => {
                const syncer = this.syncers.get(pair.id);
                return {
                    id: pair.id,
                    localPath: pair.localPath,
                    remotePath: pair.remotePath,
                    remoteUid: pair.remoteUid,
                    enabled: pair.enabled,
                    status: !pair.enabled ? 'paused' : this.paused ? 'paused' : (syncer?.status ?? 'idle'),
                    lastSyncAt: pair.lastSyncAt,
                    error: syncer?.error ?? null,
                    stats: syncer?.stats ?? {
                        pending: 0,
                        conflicts: this.db.countConflicts(pair.id),
                        filesUp: 0,
                        filesDown: 0,
                        bytesUp: 0,
                        bytesDown: 0,
                    },
                };
            }),
        };
    }

    private cachedEmail: string | null = null;

    setEmail(email: string | null): void {
        this.cachedEmail = email;
        this.scheduleEmit();
    }

    /** Called after a successful sign-in, to bring everything online. */
    async onSignedIn(): Promise<void> {
        this.abort = new AbortController();
        await this.start();
    }

    /**
     * Called on sign-out. Stops all activity and drops the syncers, which hold
     * a Drive client bound to the session that no longer exists.
     */
    onSignedOut(): void {
        this.abort.abort();
        if (this.periodic) {
            clearInterval(this.periodic);
            this.periodic = undefined;
        }
        for (const id of [...this.watchers.keys()]) {
            this.stopWatching(id);
        }
        this.syncers.clear();
        this.scheduler = undefined;
        this.activity = null;
        this.cachedEmail = null;
        this.scheduleEmit();
    }

    async stop(): Promise<void> {
        this.abort.abort();
        if (this.periodic) {
            clearInterval(this.periodic);
        }
        for (const id of [...this.watchers.keys()]) {
            this.stopWatching(id);
        }
        this.syncers.clear();
        this.db.close();
    }
}
