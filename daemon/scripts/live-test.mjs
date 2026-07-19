// Drives the running daemon over D-Bus against a real Proton Drive account,
// using a throwaway folder pair. Exercises the paths unit tests cannot: real
// uploads, real downloads, move detection, and the local trash.
//
//   node scripts/live-test.mjs
//
// Creates "Halyard Test" in Drive and ~/halyard-test locally. Touches nothing else.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dbus from 'dbus-next';

const BUS_NAME = 'io.github.votton.Halyard.Daemon';
const OBJECT_PATH = '/io/github/votton/Halyard/Daemon';

const LOCAL_ROOT = path.join(os.homedir(), 'halyard-test');
const REMOTE_NAME = 'Halyard Test';

const bus = dbus.sessionBus();
let iface;

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
    const object = await bus.getProxyObject(BUS_NAME, OBJECT_PATH);
    iface = object.getInterface(BUS_NAME);
}

async function status() {
    return JSON.parse(await iface.GetStatus());
}

/** Waits until the pair stops working and nothing is in flight. */
async function settle(pairId, timeoutMs = 180_000) {
    const started = Date.now();
    let stableFor = 0;
    while (Date.now() - started < timeoutMs) {
        const current = await status();
        const pair = current.pairs.find((entry) => entry.id === pairId);
        const quiet = pair && ['idle', 'error'].includes(pair.status) && !current.activity;
        stableFor = quiet ? stableFor + 1 : 0;
        // Require several consecutive quiet polls: the debounce means a cycle
        // can be about to start even when this instant looks idle.
        if (stableFor >= 4) {
            return pair;
        }
        await sleep(500);
    }
    throw new Error(`Pair ${pairId} did not settle within ${timeoutMs}ms`);
}

async function sha1(file) {
    return createHash('sha1').update(await fs.readFile(file)).digest('hex');
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
    await connect();

    const account = JSON.parse(await iface.GetAccount());
    if (!account.loggedIn) {
        throw new Error('Daemon is not signed in');
    }
    console.log(`\nSigned in as ${account.email}\n`);

    // --- Set up a throwaway pair.
    console.log('Setting up test pair…');
    await fs.rm(LOCAL_ROOT, { recursive: true, force: true });
    await fs.mkdir(LOCAL_ROOT, { recursive: true });

    // Reuse the remote folder if a previous run left one behind.
    const rootFolders = JSON.parse(await iface.ListRemoteFolders(''));
    let remote = rootFolders.find((folder) => folder.name === REMOTE_NAME);
    if (!remote) {
        remote = JSON.parse(await iface.CreateRemoteFolder('', REMOTE_NAME));
        console.log(`  created Drive folder /${REMOTE_NAME}`);
    } else {
        console.log(`  reusing existing Drive folder /${REMOTE_NAME}`);
    }

    // Drop any pair left over from an earlier run.
    for (const pair of (await status()).pairs) {
        if (pair.remoteUid === remote.uid || pair.localPath === LOCAL_ROOT) {
            await iface.RemovePair(pair.id, true);
        }
    }

    // --- Content to sync. The large file forces the multi-block upload path.
    const bigBytes = randomBytes(5 * 1024 * 1024);
    await fs.writeFile(path.join(LOCAL_ROOT, 'hello.txt'), 'hello world\n');
    await fs.mkdir(path.join(LOCAL_ROOT, 'sub'), { recursive: true });
    await fs.writeFile(path.join(LOCAL_ROOT, 'sub', 'nested.txt'), 'nested content\n');
    await fs.writeFile(path.join(LOCAL_ROOT, 'big.bin'), bigBytes);

    const originals = {
        'hello.txt': await sha1(path.join(LOCAL_ROOT, 'hello.txt')),
        'sub/nested.txt': await sha1(path.join(LOCAL_ROOT, 'sub', 'nested.txt')),
        'big.bin': createHash('sha1').update(bigBytes).digest('hex'),
    };

    console.log('\n1. Upload');
    const pair = JSON.parse(
        await iface.AddPair(JSON.stringify({ localPath: LOCAL_ROOT, remoteUid: remote.uid, remotePath: `/${REMOTE_NAME}` })),
    );
    let state = await settle(pair.id);
    check('pair reaches a clean state', state.status === 'idle', state.error ?? '');
    check('three files uploaded', state.stats.filesUp === 3, `filesUp=${state.stats.filesUp}`);
    check('uploaded roughly 5MB', state.stats.bytesUp >= 5 * 1024 * 1024, `bytesUp=${state.stats.bytesUp}`);

    // --- Rename: the whole point of move detection is that nothing transfers.
    console.log('\n2. Rename (must not re-transfer)');
    const uploadedBefore = state.stats.filesUp;
    const downloadedBefore = state.stats.filesDown;
    await fs.rename(path.join(LOCAL_ROOT, 'big.bin'), path.join(LOCAL_ROOT, 'renamed.bin'));
    await iface.SyncNow(pair.id);
    state = await settle(pair.id);
    check('rename caused no upload', state.stats.filesUp === uploadedBefore, `filesUp=${state.stats.filesUp}`);
    check('rename caused no download', state.stats.filesDown === downloadedBefore, `filesDown=${state.stats.filesDown}`);
    check('renamed file still present locally', await exists(path.join(LOCAL_ROOT, 'renamed.bin')));

    // --- Round-trip: wipe the local side and pull everything back from Drive.
    console.log('\n3. Download round-trip');
    await iface.RemovePair(pair.id, true);
    await fs.rm(LOCAL_ROOT, { recursive: true, force: true });
    await fs.mkdir(LOCAL_ROOT, { recursive: true });

    const pair2 = JSON.parse(
        await iface.AddPair(JSON.stringify({ localPath: LOCAL_ROOT, remoteUid: remote.uid, remotePath: `/${REMOTE_NAME}` })),
    );
    state = await settle(pair2.id);
    check('re-pair reaches a clean state', state.status === 'idle', state.error ?? '');
    check('three files downloaded', state.stats.filesDown === 3, `filesDown=${state.stats.filesDown}`);

    check('hello.txt round-tripped byte-identical', (await sha1(path.join(LOCAL_ROOT, 'hello.txt'))) === originals['hello.txt']);
    check(
        'nested file round-tripped, folder structure preserved',
        (await sha1(path.join(LOCAL_ROOT, 'sub', 'nested.txt'))) === originals['sub/nested.txt'],
    );
    check('5MB binary round-tripped byte-identical', (await sha1(path.join(LOCAL_ROOT, 'renamed.bin'))) === originals['big.bin']);

    // --- Deletion: local file removed should move the remote node to trash,
    //     and the reverse should land in the local trash folder, never unlink.
    console.log('\n4. Deletion propagates');
    await fs.rm(path.join(LOCAL_ROOT, 'hello.txt'));
    await iface.SyncNow(pair2.id);
    state = await settle(pair2.id);
    check('deletion left the pair clean', state.status === 'idle', state.error ?? '');

    // Re-pair once more: if the remote node really was trashed, it must not come back.
    await iface.RemovePair(pair2.id, true);
    await fs.rm(LOCAL_ROOT, { recursive: true, force: true });
    await fs.mkdir(LOCAL_ROOT, { recursive: true });
    const pair3 = JSON.parse(
        await iface.AddPair(JSON.stringify({ localPath: LOCAL_ROOT, remoteUid: remote.uid, remotePath: `/${REMOTE_NAME}` })),
    );
    state = await settle(pair3.id);
    check('deleted file did not reappear from Drive', !(await exists(path.join(LOCAL_ROOT, 'hello.txt'))));
    check('surviving files still there', await exists(path.join(LOCAL_ROOT, 'renamed.bin')));

    // Remote-side deletions and true conflicts need a second device to make
    // the change, so they live in live-test-conflicts.mjs (which drives
    // remoteop.cjs to modify Drive out of band). Run that next.

    console.log('\n--- Summary ---');
    const failed = results.filter((entry) => !entry.ok);
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length > 0) {
        console.log('Failed: ' + failed.map((entry) => entry.name).join(', '));
    }

    console.log(`\nLeft in place for inspection:\n  local:  ${LOCAL_ROOT}\n  Drive:  /${REMOTE_NAME}`);
    console.log('Next: node scripts/live-test-conflicts.mjs');

    bus.disconnect();
    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error('\nLive test failed:', error);
    bus.disconnect();
    process.exit(1);
});
