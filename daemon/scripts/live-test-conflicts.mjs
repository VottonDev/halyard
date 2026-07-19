// Verifies the "never lose data" guarantees against a real account, using
// dist/remoteop.cjs as a stand-in for a second device making remote changes.
//
//   node scripts/live-test-conflicts.mjs
//
// Assumes the daemon is running and signed in, and reuses the "Halyard Test"
// pair created by live-test.mjs.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dbus from 'dbus-next';

const BUS_NAME = 'io.github.votton.Halyard.Daemon';
const OBJECT_PATH = '/io/github/votton/Halyard/Daemon';
const LOCAL_ROOT = path.join(os.homedir(), 'halyard-test');
const REMOTE_NAME = 'Halyard Test';
const TRASH = '.halyard-trash';

const bus = dbus.sessionBus();
let iface;
const results = [];

function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remoteop(...args) {
    return execFileSync('node', ['dist/remoteop.cjs', ...args], { encoding: 'utf8' }).trim();
}

async function status() {
    return JSON.parse(await iface.GetStatus());
}

async function settle(pairId, timeoutMs = 240_000) {
    const started = Date.now();
    let quietPolls = 0;
    while (Date.now() - started < timeoutMs) {
        const current = await status();
        const pair = current.pairs.find((entry) => entry.id === pairId);
        const quiet = pair && ['idle', 'error'].includes(pair.status) && !current.activity;
        quietPolls = quiet ? quietPolls + 1 : 0;
        if (quietPolls >= 4) {
            return pair;
        }
        await sleep(500);
    }
    throw new Error(`Pair did not settle in ${timeoutMs}ms`);
}

/** Remote changes reach us via the event stream, which is not instantaneous. */
async function syncUntil(pairId, predicate, attempts = 12) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        await iface.SyncNow(pairId);
        await settle(pairId);
        if (await predicate()) {
            return true;
        }
        await sleep(5_000);
    }
    return false;
}

async function readIfExists(file) {
    try {
        return await fs.readFile(file, 'utf8');
    } catch {
        return null;
    }
}

async function findConflictCopy(dir, stem) {
    const entries = await fs.readdir(dir).catch(() => []);
    return entries.find((name) => name.startsWith(stem) && name.includes('(conflict'));
}

async function findInTrash(root, filename) {
    const trashRoot = path.join(root, TRASH);
    const days = await fs.readdir(trashRoot).catch(() => []);
    for (const day of days) {
        const candidate = path.join(trashRoot, day, filename);
        try {
            await fs.stat(candidate);
            return candidate;
        } catch {
            // keep looking
        }
    }
    return null;
}

async function main() {
    const object = await bus.getProxyObject(BUS_NAME, OBJECT_PATH);
    iface = object.getInterface(BUS_NAME);

    const current = await status();
    const pair = current.pairs.find((entry) => entry.localPath === LOCAL_ROOT);
    if (!pair) {
        throw new Error(`No pair for ${LOCAL_ROOT}. Run live-test.mjs first.`);
    }
    console.log(`\nUsing pair ${pair.id} (${LOCAL_ROOT})\n`);

    // ---------------------------------------------------------------
    console.log('1. A file deleted in Drive is deleted locally too');

    await fs.writeFile(path.join(LOCAL_ROOT, 'doomed.txt'), 'SYNCED CONTENT\n');
    await iface.SyncNow(pair.id);
    await settle(pair.id);

    remoteop('trash', REMOTE_NAME, 'doomed.txt');
    console.log('   (trashed doomed.txt in Drive as another device would)');

    const vanishedLocally = await syncUntil(
        pair.id,
        async () => (await readIfExists(path.join(LOCAL_ROOT, 'doomed.txt'))) === null,
    );
    check('remote deletion removed the local file', vanishedLocally);

    // The deletion should be a real delete, not a quarantine copy: Proton
    // Drive's own Trash is the recovery path.
    const quarantined = await findInTrash(LOCAL_ROOT, 'doomed.txt');
    check('no local quarantine copy was left behind', !quarantined, quarantined ?? '');

    // ---------------------------------------------------------------
    console.log('\n1b. But a file with unsynced local edits is NOT deleted');

    await fs.writeFile(path.join(LOCAL_ROOT, 'precious.txt'), 'ORIGINAL\n');
    await iface.SyncNow(pair.id);
    await settle(pair.id);

    // Edit locally and delete remotely, with sync paused so neither side has
    // seen the other's change. The local edit must win.
    await iface.SetPaused(true);
    await fs.writeFile(path.join(LOCAL_ROOT, 'precious.txt'), 'UNSYNCED LOCAL EDIT\n');
    remoteop('trash', REMOTE_NAME, 'precious.txt');
    await iface.SetPaused(false);

    const survived = await syncUntil(
        pair.id,
        async () => (await readIfExists(path.join(LOCAL_ROOT, 'precious.txt'))) === 'UNSYNCED LOCAL EDIT\n',
    );
    check('a locally-edited file survives a remote deletion', survived);

    const restored = await syncUntil(pair.id, async () => remoteop('ls', REMOTE_NAME).includes('precious.txt'), 6);
    check('and is put back on Drive', restored);

    // ---------------------------------------------------------------
    console.log('\n2. Edited on both sides — both versions survive');

    await fs.writeFile(path.join(LOCAL_ROOT, 'both.txt'), 'ORIGINAL\n');
    await iface.SyncNow(pair.id);
    await settle(pair.id);

    // Pause so neither change syncs before the other is made — this is what
    // genuinely divergent edits look like.
    await iface.SetPaused(true);

    await fs.writeFile(path.join(LOCAL_ROOT, 'both.txt'), 'LOCAL VERSION\n');

    const remoteTemp = path.join(os.tmpdir(), 'halyard-remote-version.txt');
    await fs.writeFile(remoteTemp, 'REMOTE VERSION\n');
    remoteop('putrev', REMOTE_NAME, 'both.txt', remoteTemp);
    console.log('   (both sides now differ)');

    await iface.SetPaused(false);

    const converged = await syncUntil(pair.id, async () => {
        const main = await readIfExists(path.join(LOCAL_ROOT, 'both.txt'));
        const copy = await findConflictCopy(LOCAL_ROOT, 'both');
        return main === 'REMOTE VERSION\n' && !!copy;
    });
    check('sync converged on the conflict', converged);

    const mainContents = await readIfExists(path.join(LOCAL_ROOT, 'both.txt'));
    check('canonical path holds the remote version', mainContents === 'REMOTE VERSION\n', JSON.stringify(mainContents));

    const copyName = await findConflictCopy(LOCAL_ROOT, 'both');
    check('a dated conflict copy was kept', !!copyName, copyName ?? 'none');
    if (copyName) {
        const copyContents = await fs.readFile(path.join(LOCAL_ROOT, copyName), 'utf8');
        check('the conflict copy holds the local version — nothing was lost', copyContents === 'LOCAL VERSION\n');
    }

    const conflicts = JSON.parse(await iface.ListConflicts(pair.id));
    check(
        'the conflict was reported to the user',
        conflicts.some((entry) => entry.path === 'both.txt' && entry.kind === 'bothModified'),
        `${conflicts.length} conflict(s) recorded`,
    );

    // The preserved copy should itself reach Drive, so both versions exist on
    // both sides rather than the local copy being a dead end.
    const copyUploaded = await syncUntil(pair.id, async () => {
        const listing = remoteop('ls', REMOTE_NAME);
        return listing.includes('(conflict');
    }, 6);
    check('the preserved copy was uploaded to Drive too', copyUploaded);

    console.log('\n--- Summary ---');
    const failed = results.filter((entry) => !entry.ok);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('Failed: ' + failed.map((entry) => entry.name).join(', '));
    }
    console.log('\nDrive contents now:');
    console.log(remoteop('ls', REMOTE_NAME));

    bus.disconnect();
    process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
    console.error('\nConflict test failed:', error);
    bus.disconnect();
    process.exit(1);
});
