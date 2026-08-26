/**
 * Runs under Node rather than Bun (`bun run test:node`), hence the file name:
 * `SyncDatabase` needs `node:sqlite`, which Bun does not implement. Everything
 * pure stays in the `.test.ts` files that `bun test` picks up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { SyncDatabase } from '../src/engine/db.js';
import type { SyncEvent } from '../src/engine/types.js';

let directory: string;
let db: SyncDatabase;

/** A whole event bar the fields the caller cares about. */
function event(overrides: Partial<Omit<SyncEvent, 'id' | 'pairId'>> = {}): Omit<SyncEvent, 'id' | 'pairId'> {
    return {
        at: Date.now(),
        action: 'downloaded',
        path: 'notes/todo.md',
        toPath: null,
        type: 'file',
        size: 1024,
        outcome: 'ok',
        error: null,
        ...overrides,
    };
}

const paths = (events: SyncEvent[]): string[] => events.map((entry) => entry.path);

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halyard-history-'));
    db = new SyncDatabase(path.join(directory, 'sync.sqlite'));
});

afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('activity log', () => {
    test('round-trips an event', () => {
        db.recordEvents('p_1', [event({ action: 'deletedLocal', path: 'a/b.txt', size: null })]);

        const [entry] = db.listEvents();
        assert.equal(entry.pairId, 'p_1');
        assert.equal(entry.action, 'deletedLocal');
        assert.equal(entry.path, 'a/b.txt');
        assert.equal(entry.size, null);
        assert.equal(entry.outcome, 'ok');
    });

    test('returns newest first', () => {
        db.recordEvents('p_1', [event({ path: 'first.txt' })]);
        db.recordEvents('p_1', [event({ path: 'second.txt' })]);

        assert.deepEqual(paths(db.listEvents()), ['second.txt', 'first.txt']);
    });

    test('an empty batch writes nothing', () => {
        db.recordEvents('p_1', []);
        assert.equal(db.listEvents().length, 0);
    });

    test('filters by pair', () => {
        db.recordEvents('p_1', [event({ path: 'mine.txt' })]);
        db.recordEvents('p_2', [event({ path: 'theirs.txt' })]);

        assert.deepEqual(paths(db.listEvents({ pairId: 'p_1' })), ['mine.txt']);
    });

    test('filters by action', () => {
        db.recordEvents('p_1', [
            event({ action: 'deletedLocal', path: 'gone.txt' }),
            event({ action: 'uploaded', path: 'new.txt' }),
            event({ action: 'trashedRemote', path: 'trashed.txt' }),
        ]);

        const deletions = db.listEvents({ actions: ['deletedLocal', 'trashedRemote'] });
        assert.deepEqual(paths(deletions).sort(), ['gone.txt', 'trashed.txt']);
    });

    test('searches paths case-insensitively', () => {
        db.recordEvents('p_1', [event({ path: 'Notes/Budget.xlsx' }), event({ path: 'photos/cat.jpg' })]);

        assert.deepEqual(paths(db.listEvents({ search: 'budget' })), ['Notes/Budget.xlsx']);
    });

    test('treats wildcards in a search as literal characters', () => {
        // A filename really can contain % or _, and a user searching for one
        // means it literally. Otherwise "100%" would match every row.
        db.recordEvents('p_1', [event({ path: 'reports/100%.txt' }), event({ path: 'reports/summary.txt' })]);

        assert.deepEqual(paths(db.listEvents({ search: '100%' })), ['reports/100%.txt']);
        assert.deepEqual(paths(db.listEvents({ search: '%' })), ['reports/100%.txt']);
    });

    test('pages with beforeId', () => {
        db.recordEvents(
            'p_1',
            ['a.txt', 'b.txt', 'c.txt'].map((file) => event({ path: file })),
        );

        const firstPage = db.listEvents({ limit: 2 });
        assert.deepEqual(paths(firstPage), ['c.txt', 'b.txt']);

        const secondPage = db.listEvents({ limit: 2, beforeId: firstPage[firstPage.length - 1].id });
        assert.deepEqual(paths(secondPage), ['a.txt']);
    });

    test('records a failure with its message', () => {
        db.recordEvents('p_1', [event({ outcome: 'failed', error: 'Permission denied' })]);

        const [entry] = db.listEvents();
        assert.equal(entry.outcome, 'failed');
        assert.equal(entry.error, 'Permission denied');
    });

    test('keeps both ends of a move', () => {
        db.recordEvents('p_1', [event({ action: 'movedLocal', path: 'old/name.txt', toPath: 'new/name.txt' })]);

        const [entry] = db.listEvents();
        assert.equal(entry.path, 'old/name.txt');
        assert.equal(entry.toPath, 'new/name.txt');
    });

    test('prunes entries past the retention window', () => {
        const ancient = Date.now() - 91 * 24 * 60 * 60 * 1000;
        db.recordEvents('p_1', [event({ at: ancient, path: 'old.txt' })]);
        // Pruning happens on write, so the second batch is what evicts it.
        db.recordEvents('p_1', [event({ path: 'recent.txt' })]);

        assert.deepEqual(paths(db.listEvents()), ['recent.txt']);
    });

    test('clearing a pair leaves other pairs alone', () => {
        db.recordEvents('p_1', [event({ path: 'mine.txt' })]);
        db.recordEvents('p_2', [event({ path: 'theirs.txt' })]);

        db.clearEvents('p_1');

        assert.deepEqual(paths(db.listEvents()), ['theirs.txt']);
    });

    test('forgetting a pair discards its history', () => {
        db.insertPair({
            id: 'p_1',
            localPath: '/home/someone/Sync',
            remoteUid: 'uid_1',
            remotePath: '/Sync',
            enabled: true,
            excludes: [],
            seeded: true,
            treeEventScopeId: null,
            eventCursor: null,
            createdAt: Date.now(),
            lastSyncAt: null,
        });
        db.recordEvents('p_1', [event()]);

        db.deletePair('p_1');

        assert.equal(db.listEvents().length, 0);
    });
});
