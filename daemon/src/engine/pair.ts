import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';

import { getLogger } from '../log.js';
import type { SyncDatabase } from './db.js';
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
    stats: PairStats = { pending: 0, conflicts: 0, filesUp: 0, filesDown: 0, bytesUp: 0, bytesDown: 0 };

    constructor(
        public pair: Pair,
        private readonly db: SyncDatabase,
        private readonly client: ProtonDriveClient,
        private readonly onProgress: (progress: Progress | null) => void,
        private readonly onChanged: () => void,
    ) {
        this.tree = new RemoteTree(db, client, pair);
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
                if (++guard >= 5) {
                    break;
                }
            } while (this.dirty && !signal?.aborted);
        } finally {
            this.running = false;
        }
    }

    private async runOnce(signal?: AbortSignal): Promise<void> {
        const pair = this.pair;

        try {
            await fsp.mkdir(pair.localPath, { recursive: true });
        } catch (error) {
            this.setStatus('error', `Local folder is not usable: ${error}`);
            return;
        }

        try {
            // --- Remote side: seed once, then follow the event stream.
            if (!pair.treeEventScopeId || !pair.eventCursor) {
                this.setStatus('setup');
                await this.tree.seed(signal);
            } else {
                this.setStatus('scanning');
                const { needsReseed } = await this.tree.pull(signal);
                if (needsReseed) {
                    await this.tree.seed(signal);
                }
            }
            this.pair = this.db.getPair(pair.id) ?? pair;
            this.tree.setPair(this.pair);

            // --- Local side.
            this.setStatus('scanning');
            const local = await scanLocal(this.pair.localPath);
            const remote = this.tree.snapshot();
            const base = this.db.getBase(this.pair.id);

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
