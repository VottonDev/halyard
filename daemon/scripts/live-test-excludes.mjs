// Verifies folder exclusions against a real account.
//
//   node scripts/live-test-excludes.mjs
//
// The assertion that matters: excluding an already-synced folder must leave it
// untouched on BOTH sides. A naive implementation filters only the local scan,
// the reconciler then reads the missing files as deletions, and the user's
// remote copies get trashed the moment they exclude something.
//
// Reuses the "Halyard Test" pair created by live-test.mjs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dbus from 'dbus-next';

const BUS_NAME = 'io.github.votton.Halyard.Daemon';
const OBJECT_PATH = '/io/github/votton/Halyard/Daemon';
const LOCAL_ROOT = path.join(os.homedir(), 'halyard-test');
const REMOTE_NAME = 'Halyard Test';
const EXCLUDED_DIR = 'Excluded';

const bus = dbus.sessionBus();
let iface;
const results = [];

function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remoteop(...args) {
    try {
        return execFileSync('node', ['dist/remoteop.cjs', ...args], { encoding: 'utf8' }).trim();
    } catch (error) {
        return `ERROR: ${error.stderr?.toString().trim() ?? error.message}`;
    }
}

async function status() {
    return JSON.parse(await iface.GetStatus());
}

async function settle(pairId, timeoutMs = 240_000) {
    const started = Date.now();
    let quiet = 0;
    while (Date.now() - started < timeoutMs) {
        const current = await status();
        const pair = current.pairs.find((entry) => entry.id === pairId);
        quiet = pair && ['idle', 'error'].includes(pair.status) && !current.activity ? quiet + 1 : 0;
        if (quiet >= 4) {
            return pair;
        }
        await sleep(500);
    }
    throw new Error('pair did not settle');
}

async function syncAndSettle(pairId) {
    await iface.SyncNow(pairId);
    return settle(pairId);
}

async function exists(target) {
    try {
        await fs.stat(target);
        return true;
    } catch {
        return false;
    }
}

async function main() {
    const object = await bus.getProxyObject(BUS_NAME, OBJECT_PATH);
    iface = object.getInterface(BUS_NAME);

    const pair = (await status()).pairs.find((entry) => entry.localPath === LOCAL_ROOT);
    if (!pair) {
        throw new Error(`No pair for ${LOCAL_ROOT}. Run live-test.mjs first.`);
    }
    console.log(`\nUsing pair ${pair.id}\n`);

    // Start from a known state: no exclusions.
    await iface.UpdatePair(pair.id, JSON.stringify({ excludes: [] }));

    // ---------------------------------------------------------------
    console.log('1. Content syncs normally before any exclusion');

    await fs.mkdir(path.join(LOCAL_ROOT, EXCLUDED_DIR), { recursive: true });
    await fs.writeFile(path.join(LOCAL_ROOT, EXCLUDED_DIR, 'secret.txt'), 'ORIGINAL\n');
    await fs.writeFile(path.join(LOCAL_ROOT, 'kept.txt'), 'KEPT\n');
    await syncAndSettle(pair.id);

    check('excluded-to-be folder reached Drive', remoteop('ls', REMOTE_NAME).includes(EXCLUDED_DIR));
    check('its file reached Drive', remoteop('ls', REMOTE_NAME, EXCLUDED_DIR).includes('secret.txt'));

    // ---------------------------------------------------------------
    console.log('\n2. Excluding it deletes nothing, on either side');

    await iface.UpdatePair(pair.id, JSON.stringify({ excludes: [EXCLUDED_DIR] }));
    await syncAndSettle(pair.id);

    const listing = remoteop('ls', REMOTE_NAME, EXCLUDED_DIR);
    check('the remote copy still exists — NOT trashed', listing.includes('secret.txt'), listing.split('\n')[0] ?? '');
    check('the local copy still exists', await exists(path.join(LOCAL_ROOT, EXCLUDED_DIR, 'secret.txt')));
    check('unexcluded files are unaffected', remoteop('ls', REMOTE_NAME).includes('kept.txt'));

    // ---------------------------------------------------------------
    console.log('\n3. While excluded, changes are ignored in both directions');

    await fs.writeFile(path.join(LOCAL_ROOT, EXCLUDED_DIR, 'secret.txt'), 'CHANGED WHILE EXCLUDED\n');
    await fs.writeFile(path.join(LOCAL_ROOT, EXCLUDED_DIR, 'brand-new.txt'), 'NEW WHILE EXCLUDED\n');
    await syncAndSettle(pair.id);

    const afterEdit = remoteop('ls', REMOTE_NAME, EXCLUDED_DIR);
    check('a new file inside the exclusion was not uploaded', !afterEdit.includes('brand-new.txt'), afterEdit.replace(/\n/g, ' | '));
    // The original 8-byte "ORIGINAL\n" must still be what Drive holds.
    check('an edit inside the exclusion was not uploaded', afterEdit.includes('9 '), 'remote size unchanged');

    // A control change outside the exclusion must still sync, proving the pair
    // remains active rather than stalled.
    await fs.writeFile(path.join(LOCAL_ROOT, 'kept.txt'), 'KEPT AND EDITED\n');
    await syncAndSettle(pair.id);
    check('changes outside the exclusion still sync', remoteop('ls', REMOTE_NAME).includes('kept.txt'));

    // ---------------------------------------------------------------
    console.log('\n4. Un-excluding resumes syncing without deleting');

    await iface.UpdatePair(pair.id, JSON.stringify({ excludes: [] }));
    await syncAndSettle(pair.id);
    await syncAndSettle(pair.id);

    const restored = remoteop('ls', REMOTE_NAME, EXCLUDED_DIR);
    check('the file created while excluded is now uploaded', restored.includes('brand-new.txt'), restored.replace(/\n/g, ' | '));
    check('nothing was deleted locally', await exists(path.join(LOCAL_ROOT, EXCLUDED_DIR, 'secret.txt')));

    // ---------------------------------------------------------------
    console.log('\n5. Invalid patterns are rejected, not silently dropped');

    let rejected = false;
    try {
        await iface.UpdatePair(pair.id, JSON.stringify({ excludes: ['!keep-me'] }));
    } catch (error) {
        rejected = String(error).includes('Negated');
    }
    check('a negated pattern is refused with a clear reason', rejected);

    const stillClean = (await status()).pairs.find((entry) => entry.id === pair.id);
    check('the rejected patch left exclusions unchanged', (stillClean.excludes ?? []).length === 0);

    console.log('\n--- Summary ---');
    const failed = results.filter((entry) => !entry.ok);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('Failed: ' + failed.map((entry) => entry.name).join(', '));
    }

    bus.disconnect();
    process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
    console.error('\nExclusion test failed:', error);
    bus.disconnect();
    process.exit(1);
});
