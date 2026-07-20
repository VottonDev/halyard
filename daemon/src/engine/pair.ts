import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

import { getLogger } from '../log.js';
import type { SyncDatabase } from './db.js';
import { compileExcludes, filterExcluded } from './exclude.js';
import { Executor, type Progress } from './execute.js';
import { fillRequiredHashes, scanLocal } from './localScan.js';
import { reconcile } from './reconcile.js';
import { RemoteTree } from './remote.js';
import type { Pair } from './types.js';

const logger = getLogger('pair');

export type PairStatus = 'setup' | 'scanning' | 'syncing' | 'idle' | 'paused' | 'error';

export type PairStats = {
    pending: number;
    conflicts: number;
    filesUp: number;
    filesDown: number;
    bytesUp: number;
    bytesDown: number;
};

/**
 * Drives one folder pair through a full sync cycle:
 * scan both sides, reconcile, execute.
 */
export class PairSyncer {
    private tree: RemoteTree;
    private running = false;
    /** Set when a change arrives mid-sync, so we immediately run again. */
    private dirty = false;

    status: PairStatus = 'idle';
    error: string | null = null;
    /** Enumeration progress, so a long first sync is visible rather than silent. */
    seedProgress: { folders: number; nodes: number } | null = null;
    stats: PairStats = { pending: 0, conflicts: 0, filesUp: 0, filesDown: 0, bytesUp: 0, bytesDown: 0 };

    constructor(
        public pair: Pair,
        private readonly db: SyncDatabase,
        private readonly client: ProtonDriveClient,
        private readonly onProgress: (progress: Progress | null) => void,
        private readonly onChanged: () => void,
    ) {
        this.tree = new RemoteTree(db, client, pair, (folders, nodes) => {
            this.seedProgress = { folders, nodes };
            this.onChanged();
        });
        this.stats.conflicts = db.countConflicts(pair.id);
    }

    updatePair(pair: Pair): void {
        this.pair = pair;
        this.tree.setPair(pair);
    }

    markDirty(): void {
        this.dirty = true;
    }

    isRunning(): boolean {
        return this.running;
    }

    private setStatus(status: PairStatus, error: string | null = null): void {
        this.status = status;
        this.error = error;
        this.onChanged();
    }

    /**
     * Runs sync cycles until nothing is left to do. Changes arriving while a
     * cycle is in flight set the dirty flag, so we loop rather than miss them.
     */
    async sync(signal?: AbortSignal): Promise<void> {
        if (this.running) {
            this.dirty = true;
            return;
        }
        this.running = true;
        try {
            let guard = 0;
            do {
                this.dirty = false;
                await this.runOnce(signal);
                // A cycle can legitimately cause the next one to find work
                // (a conflict copy needs uploading, for example), but it must
                // converge. Stop looping if it does not.
                // A resumable enumeration can need several passes before any
                // syncing happens, so the guard has to be generous. It exists
                // only to stop a genuine oscillation running forever.
                if (++guard >= 50) {
                    logger.warn(`Pair ${this.pair.id}: stopping after ${guard} passes without settling`);
                    break;
                }
            } while (this.dirty && !signal?.aborted);
        } finally {
            this.running = false;
        }
    }

    private async runOnce(signal?: AbortSignal): Promise<void> {
        const pair = this.pair;

        // A previously-synced local root that has vanished was almost certainly
        // moved, deleted, or unmounted out from under us — not emptied file by
        // file. If we recreate it empty below and then reconcile, every synced
        // file reads as a local deletion and we trash the user's Drive copies.
        // Refuse instead, exactly as we refuse to reconcile a half-enumerated
        // remote. Recreating it empty would also risk writing a phantom folder
        // into a bare mountpoint, hiding the real data behind it.
        const rootExists = await fsp
            .stat(pair.localPath)
            .then((stats) => stats.isDirectory())
            .catch(() => false);
        if (!rootExists && this.db.getBase(pair.id).size > 0) {
            this.setStatus(
                'error',
                `${pair.localPath} is missing. It may have been moved or its drive unmounted — ` +
                    `sync is paused so your Proton Drive copies aren't deleted. ` +
                    `Restore the folder or re-point this pair to resume.`,
            );
            return;
        }

        try {
            await fsp.mkdir(pair.localPath, { recursive: true });
        } catch (error) {
            this.setStatus('error', `Local folder is not usable: ${error}`);
            return;
        }

        try {
            // --- Remote side: enumerate once, then follow the event stream.
            if (!this.pair.seeded) {
                this.setStatus('setup');
                await this.tree.seed(signal);
            } else {
                this.setStatus('scanning');
                const { needsReseed } = await this.tree.pull(signal);
                if (needsReseed) {
                    this.db.updatePair(this.pair.id, { seeded: false });
                    this.pair = { ...this.pair, seeded: false };
                    this.tree.setPair(this.pair);
                    await this.tree.seed(signal);
                }
            }
            this.pair = this.db.getPair(pair.id) ?? pair;
            this.tree.setPair(this.pair);

            // Never reconcile against a half-enumerated remote view. Files we
            // have not listed yet look exactly like files deleted on Drive, and
            // acting on that would trash the local copies (or, with a base in
            // place, the remote ones). Resume the enumeration instead.
            if (!this.pair.seeded) {
                logger.info(`Pair ${this.pair.id}: enumeration incomplete, continuing before syncing`);
                this.dirty = true;
                this.setStatus('setup');
                return;
            }

            // --- Local side.
            this.setStatus('scanning');
            const isExcluded = compileExcludes(this.pair.excludes ?? []);

            // Exclusions are applied to all three views together. Filtering
            // only the local scan would leave files present in the base and on
            // Drive but missing locally, which reads as a deletion — and would
            // trash the user's remote copies the moment they excluded a folder.
            const local = filterExcluded(await scanLocal(this.pair.localPath, isExcluded), isExcluded);
            const remote = filterExcluded(this.tree.snapshot(), isExcluded);
            const base = filterExcluded(this.db.getBase(this.pair.id), isExcluded);

            // The same protection as the missing-root check above, for a root
            // that still exists but scans empty (a stale mountpoint, say): a
            // pair that was previously non-empty and now has no local files at
            // all must not be allowed to propagate a full-tree deletion to
            // Drive. A genuine "delete everything" is rare, recoverable from
            // Proton's Trash if intended, and worth pausing on either way.
            if (local.size === 0 && base.size > 0) {
                this.setStatus(
                    'error',
                    `${this.pair.localPath} is empty but was previously synced. ` +
                        `It may have been moved or its drive unmounted — sync is paused so your ` +
                        `Proton Drive copies aren't deleted. Restore the folder or re-point this pair to resume.`,
                );
                return;
            }

            await fillRequiredHashes(this.pair.localPath, local, base, remote);

            // --- Decide.
            const plan = reconcile({ base, local, remote, now: Date.now() });
            this.stats.pending = plan.actions.filter(
                (action) => action.kind !== 'refreshBase' && action.kind !== 'dropBase',
            ).length;

            if (plan.actions.length === 0) {
                this.db.updatePair(this.pair.id, { lastSyncAt: Date.now() });
                this.pair = { ...this.pair, lastSyncAt: Date.now() };
                this.setStatus('idle');
                return;
            }

            logger.info(`Pair ${this.pair.id}: ${plan.actions.length} action(s), ${plan.conflicts.length} conflict(s)`);
            this.setStatus('syncing');

            for (const conflict of plan.conflicts) {
                this.db.insertConflict({ ...conflict, id: `c_${randomUUID().slice(0, 8)}`, pairId: this.pair.id });
            }
            this.stats.conflicts = this.db.countConflicts(this.pair.id);

            // --- Act.
            const executor = new Executor({
                pair: this.pair,
                db: this.db,
                client: this.client,
                local,
                remote,
                signal,
                onProgress: this.onProgress,
            });
            const result = await executor.run(plan.actions);

            this.stats.filesUp += result.filesUp;
            this.stats.filesDown += result.filesDown;
            this.stats.bytesUp += result.bytesUp;
            this.stats.bytesDown += result.bytesDown;
            this.stats.pending = result.failed.length;

            const now = Date.now();
            this.db.updatePair(this.pair.id, { lastSyncAt: now });
            this.pair = { ...this.pair, lastSyncAt: now };

            if (result.failed.length > 0) {
                const first = result.failed[0];
                this.setStatus(
                    'error',
                    result.failed.length === 1
                        ? first.error
                        : `${result.failed.length} items failed to sync. First error: ${first.error}`,
                );
                // Something failed but the rest succeeded; retry next cycle.
                this.dirty = true;
            } else {
                this.setStatus('idle');
            }
        } catch (error) {
            if (signal?.aborted) {
                this.setStatus('idle');
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Sync failed for pair ${this.pair.id}`, error);
            this.setStatus('error', message);
        }
    }
}
