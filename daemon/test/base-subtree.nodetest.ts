import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SyncDatabase } from '../src/engine/db.js';

let directory: string;
let db: SyncDatabase;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halyard-base-subtree-'));
    db = new SyncDatabase(path.join(directory, 'sync.sqlite'));
    for (const id of ['one', 'two']) {
        db.insertPair({
            id, localPath: directory, remoteUid: id, remotePath: id,
            enabled: true, excludes: [], treeEventScopeId: null, eventCursor: null,
            seeded: true, createdAt: 0, lastSyncAt: null,
        });
    }
});

afterEach(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function seed(paths: string[], pairId = 'one'): void {
    for (const entryPath of paths) {
        db.setBaseEntry(pairId, {
            path: entryPath, type: 'file', localMtime: 1, localSize: 1,
            localInode: null, localDevice: null, localHash: null,
            remoteUid: `${pairId}:${entryPath}`, remoteRevisionUid: null,
            remoteHash: null, remoteSize: 1, remoteMtime: 1,
        });
    }
}

for (const root of ['Folder', 'résumé_100%\\', '東京🦊']) {
    test(`subtree reads and deletes only exact descendants of ${root}`, () => {
        const expected = [root, `${root}/child`, `${root}/nested/grandchild`, `${root}/Ω`, `${root}/🦊`];
        const siblings = [`${root}-other`, `${root}.txt`, `${root}0`, `${root}0/child`, `${root}ish/child`];
        if (root === 'Folder') siblings.push('folder', 'folder/child', 'FOLDER/nested/grandchild');
        if (root.includes('%')) siblings.push('résuméX100anything\\/child', 'résumé_100%/child');
        seed([...expected, ...siblings]);
        seed(expected, 'two');
        assert.deepEqual(db.getBaseSubtree('one', root).map((entry) => entry.path).sort(), [...expected].sort());
        db.deleteBaseEntry('one', root);
        assert.deepEqual([...db.getBase('one').keys()].sort(), [...siblings].sort());
        assert.deepEqual([...db.getBase('two').keys()].sort(), [...expected].sort());
    });
}

test('descendants are found and removed even if their parent row is absent', () => {
    seed(['missing/child', 'missing/nested/grandchild', 'missing-other/child']);
    assert.equal(db.getBaseSubtree('one', 'missing').length, 2);
    db.deleteBaseEntry('one', 'missing');
    assert.deepEqual([...db.getBase('one').keys()], ['missing-other/child']);
});

test('file and missing-path deletes preserve unrelated durable rows across reopen', () => {
    seed(['file', 'file.txt', 'file0', 'unrelated/child']);
    assert.deepEqual(db.getBaseSubtree('one', 'file').map((entry) => entry.path), ['file']);
    db.deleteBaseEntry('one', 'file');
    db.deleteBaseEntry('one', 'absent');
    assert.deepEqual(db.getBaseSubtree('one', 'absent'), []);
    db.close();
    db = new SyncDatabase(path.join(directory, 'sync.sqlite'));
    assert.deepEqual([...db.getBase('one').keys()].sort(), ['file.txt', 'file0', 'unrelated/child']);
});

test('subtree removal participates in the caller transaction rollback', () => {
    const paths = ['folder', 'folder/child', 'folder/nested/grandchild'];
    seed(paths);
    assert.throws(() => db.transaction(() => {
        db.deleteBaseEntry('one', 'folder');
        assert.equal(db.getBaseSubtree('one', 'folder').length, 0);
        throw new Error('rollback');
    }), /rollback/);
    assert.deepEqual([...db.getBase('one').keys()].sort(), [...paths].sort());
});
