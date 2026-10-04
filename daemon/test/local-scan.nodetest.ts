/** Exercise cancellation using the same Node filesystem and streams as the daemon. */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { hashFile, scanLocal } from '../src/engine/localScan.js';

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
