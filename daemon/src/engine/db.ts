import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dataDir } from '../config.js';
import type { BaseEntry, Conflict, HistoryFilter, NodeKind, Pair, SyncEvent } from './types.js';

/**
 * How much history to keep. Generous enough to answer "what happened to that
 * file last month", bounded so the database cannot grow without limit on a
 * busy folder.
 */
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_ROWS = 20_000;

/**
 * Persistent sync state.
 *
 * This database is the daemon's memory of what it has already reconciled. If
 * it is lost, sync still converges — but every pair has to be re-walked and
 * every file re-hashed, and deletions cannot be distinguished from
 * never-having-seen-it, so it is treated as durable state, not a cache.
 */
export class SyncDatabase {
    private readonly db: DatabaseSync;

    constructor(file = path.join(dataDir, 'sync.sqlite')) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.migrate();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS pairs (
                id TEXT PRIMARY KEY,
                local_path TEXT NOT NULL,
                remote_uid TEXT NOT NULL,
                remote_path TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                excludes TEXT NOT NULL DEFAULT '[]',
                tree_event_scope_id TEXT,
                event_cursor TEXT,
                created_at INTEGER NOT NULL,
                last_sync_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS base_entries (
                pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                type TEXT NOT NULL,
                local_mtime INTEGER NOT NULL,
                local_size INTEGER NOT NULL,
                local_inode INTEGER,
                local_device INTEGER,
                local_hash TEXT,
                remote_uid TEXT NOT NULL,
                remote_revision_uid TEXT,
                remote_hash TEXT,
                remote_size INTEGER NOT NULL DEFAULT 0,
                remote_mtime INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (pair_id, path)
            );
            CREATE INDEX IF NOT EXISTS base_entries_uid ON base_entries (pair_id, remote_uid);

            -- Mirror of the remote tree, kept current from Drive events so we
            -- never have to recursively re-list the folder.
            CREATE TABLE IF NOT EXISTS remote_nodes (
                pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
                uid TEXT NOT NULL,
                parent_uid TEXT,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                revision_uid TEXT,
                hash TEXT,
                size INTEGER NOT NULL DEFAULT 0,
                mtime INTEGER NOT NULL DEFAULT 0,
                trashed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (pair_id, uid)
            );
            CREATE INDEX IF NOT EXISTS remote_nodes_parent ON remote_nodes (pair_id, parent_uid);

            CREATE TABLE IF NOT EXISTS conflicts (
                id TEXT PRIMARY KEY,
                pair_id TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                kind TEXT NOT NULL,
                detected_at INTEGER NOT NULL,
                kept_copy_path TEXT,
                local_modified_at INTEGER,
                remote_modified_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS conflicts_pair ON conflicts (pair_id);

            -- Append-only record of what sync actually did, for the activity
            -- log. Not load-bearing: losing it costs the user an explanation,
            -- not their data, so it is pruned on a retention policy while
            -- base_entries never is.
            CREATE TABLE IF NOT EXISTS sync_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pair_id TEXT NOT NULL,
                at INTEGER NOT NULL,
                action TEXT NOT NULL,
                path TEXT NOT NULL,
                to_path TEXT,
                type TEXT NOT NULL,
                size INTEGER,
                outcome TEXT NOT NULL,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS sync_events_recent ON sync_events (pair_id, id DESC);

            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        `);

        // Removed-but-remembered pairs: dropping a pair without discarding its
        // state lets the user re-add the same folders later without re-hashing
        // and re-transferring everything.
        this.ensureColumn('pairs', 'removed', 'INTEGER NOT NULL DEFAULT 0');
        // Inode numbers alone do not identify a file on btrfs, where they are
        // unique only within a subvolume. Databases written before this column
        // existed get null devices, which simply means no move is detected for
        // those rows until they are rewritten — correct, just not optimal.
        this.ensureColumn('base_entries', 'local_device', 'INTEGER');
        this.ensureColumn('pairs', 'excludes', "TEXT NOT NULL DEFAULT '[]'");
        // Seeding a large remote tree takes thousands of API calls. Recording
        // how far it got lets an interrupted seed resume instead of starting
        // over, which on a big folder meant it could never finish at all.
        this.ensureColumn('pairs', 'seeded', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureColumn('remote_nodes', 'children_listed', 'INTEGER NOT NULL DEFAULT 0');
    }

    private ensureColumn(table: string, column: string, definition: string): void {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        if (!columns.some((existing) => existing.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }

    // ---- Settings

    getSetting(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        return row?.value;
    }

    setSetting(key: string, value: string): void {
        this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }

    // ---- Pairs

    listPairs(): Pair[] {
        const rows = this.db
            .prepare('SELECT * FROM pairs WHERE removed = 0 ORDER BY created_at')
            .all() as Record<string, unknown>[];
        return rows.map(rowToPair);
    }

    getPair(id: string): Pair | undefined {
        const row = this.db.prepare('SELECT * FROM pairs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? rowToPair(row) : undefined;
    }

    /** Finds a previously removed pair covering the same folders, for revival. */
    findRemovedPair(localPath: string, remoteUid: string): Pair | undefined {
        const row = this.db
            .prepare('SELECT * FROM pairs WHERE removed = 1 AND local_path = ? AND remote_uid = ?')
            .get(localPath, remoteUid) as Record<string, unknown> | undefined;
        return row ? rowToPair(row) : undefined;
    }

    markPairRemoved(id: string, removed: boolean): void {
        this.db.prepare('UPDATE pairs SET removed = ?, enabled = ? WHERE id = ?').run(removed ? 1 : 0, removed ? 0 : 1, id);
    }

    insertPair(pair: Pair): void {
        this.db
            .prepare(
                `INSERT INTO pairs (id, local_path, remote_uid, remote_path, enabled, excludes, tree_event_scope_id, event_cursor, created_at, last_sync_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                pair.id,
                pair.localPath,
                pair.remoteUid,
                pair.remotePath,
                pair.enabled ? 1 : 0,
                JSON.stringify(pair.excludes ?? []),
                pair.treeEventScopeId,
                pair.eventCursor,
                pair.createdAt,
                pair.lastSyncAt,
            );
    }

    updatePair(id: string, patch: Partial<Pair>): void {
        const columns: Record<keyof Pair, string> = {
            id: 'id',
            localPath: 'local_path',
            remoteUid: 'remote_uid',
            remotePath: 'remote_path',
            enabled: 'enabled',
            excludes: 'excludes',
            seeded: 'seeded',
            treeEventScopeId: 'tree_event_scope_id',
            eventCursor: 'event_cursor',
            createdAt: 'created_at',
            lastSyncAt: 'last_sync_at',
        };

        const assignments: string[] = [];
        const values: Array<string | number | null> = [];
        for (const [key, value] of Object.entries(patch)) {
            const column = columns[key as keyof Pair];
            if (!column || key === 'id') {
                continue;
            }
            assignments.push(`${column} = ?`);
            if (Array.isArray(value)) {
                values.push(JSON.stringify(value));
            } else if (typeof value === 'boolean') {
                values.push(value ? 1 : 0);
            } else {
                values.push(value as string | number | null);
            }
        }
        if (assignments.length === 0) {
            return;
        }
        values.push(id);
        this.db.prepare(`UPDATE pairs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    }

    deletePair(id: string): void {
        // Explicit child deletes: SQLite only cascades when foreign_keys is on
        // for this connection, and we would rather not depend on that here.
        this.db.prepare('DELETE FROM base_entries WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM remote_nodes WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM conflicts WHERE pair_id = ?').run(id);
        // "Forget this folder's sync history" means the activity log too — it
        // names files the user has asked us to stop remembering.
        this.db.prepare('DELETE FROM sync_events WHERE pair_id = ?').run(id);
        this.db.prepare('DELETE FROM pairs WHERE id = ?').run(id);
    }

    // ---- Base entries

    getBase(pairId: string): Map<string, BaseEntry> {
        const rows = this.db.prepare('SELECT * FROM base_entries WHERE pair_id = ?').all(pairId) as Record<
            string,
            unknown
        >[];
        const map = new Map<string, BaseEntry>();
        for (const row of rows) {
            const entry = rowToBase(row);
            map.set(entry.path, entry);
        }
        return map;
    }

    setBaseEntry(pairId: string, entry: BaseEntry): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO base_entries
                 (pair_id, path, type, local_mtime, local_size, local_inode, local_device, local_hash,
                  remote_uid, remote_revision_uid, remote_hash, remote_size, remote_mtime)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                pairId,
                entry.path,
                entry.type,
                entry.localMtime,
                entry.localSize,
                entry.localInode,
                entry.localDevice,
                entry.localHash,
                entry.remoteUid,
                entry.remoteRevisionUid,
                entry.remoteHash,
                entry.remoteSize,
                entry.remoteMtime,
            );
    }

    deleteBaseEntry(pairId: string, entryPath: string): void {
        this.db.prepare('DELETE FROM base_entries WHERE pair_id = ? AND path = ?').run(pairId, entryPath);
        // A folder's descendants go with it.
        this.db.prepare('DELETE FROM base_entries WHERE pair_id = ? AND path LIKE ?').run(pairId, `${entryPath}/%`);
    }

    clearBase(pairId: string): void {
        this.db.prepare('DELETE FROM base_entries WHERE pair_id = ?').run(pairId);
    }

    // ---- Remote node mirror

    getRemoteNodes(pairId: string): RemoteNodeRow[] {
        return this.db.prepare('SELECT * FROM remote_nodes WHERE pair_id = ?').all(pairId) as RemoteNodeRow[];
    }

    upsertRemoteNode(pairId: string, node: RemoteNodeInput): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO remote_nodes
                 (pair_id, uid, parent_uid, name, type, revision_uid, hash, size, mtime, trashed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                pairId,
                node.uid,
                node.parentUid,
                node.name,
                node.type,
                node.revisionUid,
                node.hash,
                node.size,
                node.mtime,
                node.trashed ? 1 : 0,
            );
    }

    deleteRemoteNode(pairId: string, uid: string): void {
        this.db.prepare('DELETE FROM remote_nodes WHERE pair_id = ? AND uid = ?').run(pairId, uid);
    }

    /** Folder uids whose children have not been listed yet — the seed frontier. */
    getUnlistedFolders(pairId: string): string[] {
        const rows = this.db
            .prepare("SELECT uid FROM remote_nodes WHERE pair_id = ? AND type = 'folder' AND children_listed = 0")
            .all(pairId) as { uid: string }[];
        return rows.map((row) => row.uid);
    }

    markChildrenListed(pairId: string, uid: string): void {
        this.db.prepare('UPDATE remote_nodes SET children_listed = 1 WHERE pair_id = ? AND uid = ?').run(pairId, uid);
    }

    countRemoteNodes(pairId: string): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM remote_nodes WHERE pair_id = ?').get(pairId) as {
            n: number;
        };
        return row.n;
    }

    clearRemoteNodes(pairId: string): void {
        this.db.prepare('DELETE FROM remote_nodes WHERE pair_id = ?').run(pairId);
    }

    // ---- Conflicts

    listConflicts(pairId?: string): Conflict[] {
        const rows = (
            pairId
                ? this.db.prepare('SELECT * FROM conflicts WHERE pair_id = ? ORDER BY detected_at DESC').all(pairId)
                : this.db.prepare('SELECT * FROM conflicts ORDER BY detected_at DESC').all()
        ) as Record<string, unknown>[];
        return rows.map(rowToConflict);
    }

    countConflicts(pairId: string): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE pair_id = ?').get(pairId) as {
            n: number;
        };
        return row.n;
    }

    insertConflict(conflict: Conflict): void {
        this.db
            .prepare(
                `INSERT OR REPLACE INTO conflicts
                 (id, pair_id, path, kind, detected_at, kept_copy_path, local_modified_at, remote_modified_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                conflict.id,
                conflict.pairId,
                conflict.path,
                conflict.kind,
                conflict.detectedAt,
                conflict.keptCopyPath,
                conflict.localModifiedAt,
                conflict.remoteModifiedAt,
            );
    }

    getConflict(id: string): Conflict | undefined {
        const row = this.db.prepare('SELECT * FROM conflicts WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined;
        return row ? rowToConflict(row) : undefined;
    }

    deleteConflict(id: string): void {
        this.db.prepare('DELETE FROM conflicts WHERE id = ?').run(id);
    }

    // ---- Activity log

    /**
     * Appends events and prunes anything past the retention policy.
     *
     * Written as one transaction per batch rather than one per event: a sync
     * cycle can produce thousands, and a commit each would dominate the cost
     * of the sync itself.
     */
    recordEvents(pairId: string, events: Array<Omit<SyncEvent, 'id' | 'pairId'>>): void {
        if (events.length === 0) {
            return;
        }
        const insert = this.db.prepare(
            `INSERT INTO sync_events (pair_id, at, action, path, to_path, type, size, outcome, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.transaction(() => {
            for (const event of events) {
                insert.run(
                    pairId,
                    event.at,
                    event.action,
                    event.path,
                    event.toPath,
                    event.type,
                    event.size,
                    event.outcome,
                    event.error,
                );
            }
        });
        this.pruneEvents();
    }

    private pruneEvents(): void {
        this.db.prepare('DELETE FROM sync_events WHERE at < ?').run(Date.now() - HISTORY_MAX_AGE_MS);
        // Trim by id rather than by count so this stays a single statement:
        // anything below the id of the Nth-newest row is surplus.
        this.db
            .prepare(
                `DELETE FROM sync_events WHERE id < (
                     SELECT MIN(id) FROM (SELECT id FROM sync_events ORDER BY id DESC LIMIT ?)
                 )`,
            )
            .run(HISTORY_MAX_ROWS);
    }

    listEvents(filter: HistoryFilter = {}): SyncEvent[] {
        const clauses: string[] = [];
        const values: Array<string | number> = [];

        if (filter.pairId) {
            clauses.push('pair_id = ?');
            values.push(filter.pairId);
        }
        if (filter.actions?.length) {
            clauses.push(`action IN (${filter.actions.map(() => '?').join(', ')})`);
            values.push(...filter.actions);
        }
        if (filter.outcome) {
            clauses.push('outcome = ?');
            values.push(filter.outcome);
        }
        if (filter.search) {
            // LIKE is case-insensitive for ASCII in SQLite by default; the
            // escape clause keeps a literal % or _ in a filename from turning
            // into a wildcard.
            clauses.push("path LIKE ? ESCAPE '\\'");
            values.push(`%${filter.search.replace(/[\\%_]/g, '\\$&')}%`);
        }
        if (filter.beforeId !== undefined) {
            clauses.push('id < ?');
            values.push(filter.beforeId);
        }

        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
        values.push(limit);

        const rows = this.db
            .prepare(`SELECT * FROM sync_events ${where} ORDER BY id DESC LIMIT ?`)
            .all(...values) as Record<string, unknown>[];
        return rows.map(rowToEvent);
    }

    clearEvents(pairId?: string): void {
        if (pairId) {
            this.db.prepare('DELETE FROM sync_events WHERE pair_id = ?').run(pairId);
        } else {
            this.db.exec('DELETE FROM sync_events');
        }
    }

    transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    close(): void {
        this.db.close();
    }
}

export type RemoteNodeRow = {
    pair_id: string;
    uid: string;
    parent_uid: string | null;
    name: string;
    type: string;
    revision_uid: string | null;
    hash: string | null;
    size: number;
    mtime: number;
    trashed: number;
};

export type RemoteNodeInput = {
    uid: string;
    parentUid: string | null;
    name: string;
    type: NodeKind;
    revisionUid: string | null;
    hash: string | null;
    size: number;
    mtime: number;
    trashed: boolean;
};

/** Tolerant: a malformed value means "no exclusions", never a crash. */
function parseExcludes(value: unknown): string[] {
    if (typeof value !== 'string' || !value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
        return [];
    }
}

function rowToPair(row: Record<string, unknown>): Pair {
    return {
        id: row.id as string,
        localPath: row.local_path as string,
        remoteUid: row.remote_uid as string,
        remotePath: row.remote_path as string,
        enabled: !!row.enabled,
        excludes: parseExcludes(row.excludes),
        seeded: !!row.seeded,
        treeEventScopeId: (row.tree_event_scope_id as string | null) ?? null,
        eventCursor: (row.event_cursor as string | null) ?? null,
        createdAt: row.created_at as number,
        lastSyncAt: (row.last_sync_at as number | null) ?? null,
    };
}

function rowToBase(row: Record<string, unknown>): BaseEntry {
    return {
        path: row.path as string,
        type: row.type as NodeKind,
        localMtime: row.local_mtime as number,
        localSize: row.local_size as number,
        localInode: (row.local_inode as number | null) ?? null,
        localDevice: (row.local_device as number | null) ?? null,
        localHash: (row.local_hash as string | null) ?? null,
        remoteUid: row.remote_uid as string,
        remoteRevisionUid: (row.remote_revision_uid as string | null) ?? null,
        remoteHash: (row.remote_hash as string | null) ?? null,
        remoteSize: row.remote_size as number,
        remoteMtime: row.remote_mtime as number,
    };
}

function rowToEvent(row: Record<string, unknown>): SyncEvent {
    return {
        id: row.id as number,
        pairId: row.pair_id as string,
        at: row.at as number,
        action: row.action as SyncEvent['action'],
        path: row.path as string,
        toPath: (row.to_path as string | null) ?? null,
        type: row.type as NodeKind,
        size: (row.size as number | null) ?? null,
        outcome: row.outcome as SyncEvent['outcome'],
        error: (row.error as string | null) ?? null,
    };
}

function rowToConflict(row: Record<string, unknown>): Conflict {
    return {
        id: row.id as string,
        pairId: row.pair_id as string,
        path: row.path as string,
        kind: row.kind as Conflict['kind'],
        detectedAt: row.detected_at as number,
        keptCopyPath: (row.kept_copy_path as string | null) ?? null,
        localModifiedAt: (row.local_modified_at as number | null) ?? null,
        remoteModifiedAt: (row.remote_modified_at as number | null) ?? null,
    };
}
