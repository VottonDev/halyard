/** Exercise scanning and hashing using the same Node filesystem and streams as the daemon. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { fillRequiredHashes, hashFile, scanLocal } from '../src/engine/localScan.js';
import { reconcile } from '../src/engine/reconcile.js';
import type { BaseEntry, RemoteItem } from '../src/engine/types.js';

test('local enumeration stops when a pair is cancelled while descending', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-scan-cancel-'));
    try {
        await fsp.mkdir(path.join(root, 'nested'));
        await fsp.writeFile(path.join(root, 'nested', 'file.txt'), 'local file');
        const abort = new AbortController();
        const reason = new Error('pair removed');
        const visited: string[] = [];
        await assert.rejects(scanLocal(root, relative => {
            visited.push(relative);
            abort.abort(reason);
            return false;
        }, abort.signal), reason);
        assert.deepEqual(visited, ['nested']);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('cancelling a file hash rejects rather than continuing or treating it as unreadable', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-hash-cancel-'));
    try {
        const file = path.join(root, 'large.bin');
        await fsp.writeFile(file, '');
        await fsp.truncate(file, 16 * 1024 * 1024);
        const abort = new AbortController();
        const hashing = hashFile(file, abort.signal);
        abort.abort();
        await assert.rejects(hashing, { name: 'AbortError' });
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});


const digest = (text: string): string => createHash('sha1').update(text).digest('hex');

for (const scenario of [
    { name: 'unilateral size-changing edit', content: 'changed', expected: ['upload'], hashed: false },
    { name: 'edit beats missing remote', content: 'changed', deleted: true, expected: ['upload'], hashed: false },
    { name: 'edit beats trashed remote', content: 'changed', trashed: true, expected: ['upload'], hashed: false },
    { name: 'file replaced remotely by folder', content: 'changed', remoteFolder: true, expected: ['moveLocal', 'createLocalFolder', 'upload'], hashed: true },
    { name: 'same-size timestamp touch', content: 'old', expected: ['refreshBase'], hashed: true },
    { name: 'same-size edit', content: 'new', expected: ['upload'], hashed: true },
    { name: 'matching simultaneous edits', content: 'changed', remoteContent: 'changed', expected: ['refreshBase'], hashed: true },
    { name: 'different simultaneous edits', content: 'changed', remoteContent: 'different', expected: ['moveLocal', 'download', 'upload'], hashed: true },
    { name: 'matching independent creations', content: 'changed', creation: true, remoteContent: 'changed', expected: ['refreshBase'], hashed: true },
    { name: 'different independent creations', content: 'changed', creation: true, remoteContent: 'different', expected: ['moveLocal', 'download', 'upload'], hashed: true },
    { name: 'remote rename and matching edits', content: 'changed', remoteMove: true, remoteContent: 'changed', expected: ['moveLocal', 'refreshBase'], hashed: true },
    { name: 'local rename and matching edits', content: 'changed', localMove: true, remoteContent: 'changed', expected: ['moveRemote', 'refreshBase'], hashed: true },
    { name: 'local rename and timestamp touch', content: 'old', localMove: true, expected: ['moveRemote', 'refreshBase'], hashed: true },
]) {
    test(`required hashes: ${scenario.name}`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-required-hash-'));
        try {
            const localPath = scenario.localMove ? 'renamed.txt' : 'file.txt';
            await fsp.writeFile(path.join(root, localPath), scenario.content);
            const local = await scanLocal(root);
            const item = local.get(localPath)!;
            const entry: BaseEntry = {
                path: 'file.txt', type: 'file', localMtime: item.mtime - 1000,
                localSize: 3, localInode: item.inode, localDevice: item.device,
                localHash: digest('old'), remoteUid: 'uid', remoteRevisionUid: 'revision',
                remoteHash: digest('old'), remoteSize: 3, remoteMtime: 1,
            };
            const base = new Map(scenario.creation ? [] : [[entry.path, entry]]);
            const remotePath = scenario.remoteMove ? 'renamed.txt' : 'file.txt';
            const remoteItem: RemoteItem = {
                path: remotePath, type: scenario.remoteFolder ? 'folder' : 'file', uid: 'uid', parentUid: null,
                revisionUid: scenario.remoteContent ? 'new-revision' : 'revision',
                hash: digest(scenario.remoteContent ?? 'old'), size: (scenario.remoteContent ?? 'old').length,
                mtime: 2, trashed: scenario.trashed ?? false,
            };
            const remote = new Map(scenario.deleted ? [] : [[remotePath, remoteItem]]);
            await fillRequiredHashes(root, local, base, remote);
            assert.equal(item.hash, scenario.hashed ? digest(scenario.content) : undefined);
            const plan = reconcile({ local, base, remote, now: 0 });
            assert.deepEqual(plan.actions.map(action => action.kind), scenario.expected);
            assert.equal(plan.conflicts.length, scenario.deleted || scenario.trashed || scenario.remoteFolder || scenario.remoteContent === 'different' ? 1 : 0);
        } finally {
            await fsp.rm(root, { recursive: true, force: true });
        }
    });
}

for (const differentDevice of [false, true]) {
    test(`rename over a deleted durable destination ${differentDevice ? 'does not match another device inode' : 'retains competing equality hash'}`, async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'halyard-hash-rebase-'));
        try {
            await fsp.writeFile(path.join(root, 'b.txt'), 'changed');
            const local = await scanLocal(root);
            const item = local.get('b.txt')!;
            const entry = (name: string, contents: string, inode: number, uid: string): BaseEntry => ({
                path: name, type: 'file', localMtime: item.mtime - 1000, localSize: contents.length,
                localInode: inode, localDevice: item.device, localHash: digest(contents),
                remoteUid: uid, remoteRevisionUid: 'old-revision', remoteHash: digest(contents),
                remoteSize: contents.length, remoteMtime: 1,
            });
            const source = entry('a.txt', 'old', item.inode, 'uid-a');
            if (differentDevice) source.localDevice = item.device + 1;
            const base = new Map([
                ['a.txt', source], ['b.txt', entry('b.txt', 'gone', item.inode + 1, 'uid-b')],
            ]);
            const remote = new Map<string, RemoteItem>([['a.txt', {
                path: 'a.txt', type: 'file', uid: 'uid-a', parentUid: null,
                revisionUid: 'new-revision', hash: digest('changed'), size: 7, mtime: 2, trashed: false,
            }]]);
            await fillRequiredHashes(root, local, base, remote);
            assert.equal(item.hash, differentDevice ? undefined : digest('changed'));
            const plan = reconcile({ local, base, remote, now: 0 });
            if (!differentDevice) {
                assert.deepEqual(plan.actions.map(action => action.kind), ['moveRemote', 'refreshBase']);
                assert.equal(plan.conflicts.length, 0);
            } else {
                assert(!plan.actions.some(action => action.kind === 'moveRemote'));
                assert(plan.actions.some(action => action.kind === 'upload' && action.path === 'b.txt'));
            }
        } finally {
            await fsp.rm(root, { recursive: true, force: true });
        }
    });
}
