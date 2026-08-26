/**
 * Environment check: `bun run doctor`.
 *
 * Checks each local dependency: SQLite, OpenPGP through Proton's crypto proxy,
 * the session bus, and the keyring. Most install problems are one of these
 * failing, and this pinpoints
 * which one instead of leaving a confusing failure deep inside a sync.
 *
 * Touches no account data and makes no network calls.
 */
import '@protontech/crypto/polyfill';

import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import { OpenPGPCryptoWithCryptoProxy, ProtonDriveClient, VERSION } from '@protontech/drive-sdk';
import * as dbus from 'dbus-next';
import { DatabaseSync } from 'node:sqlite';
import { initAccount } from 'proton-drive-sdk-account';

const results: Record<string, unknown> = {};
const strict = process.argv.includes('--strict');

function applyStrictChecks(): void {
    if (!strict) {
        return;
    }

    const failures: string[] = [];
    if (results.sqlite !== 'ok (blob round-trip)') failures.push('sqlite');
    if (results.cryptoRoundTrip !== 'ok') failures.push('cryptoRoundTrip');
    if (results.openPGPModule !== 'ok') failures.push('openPGPModule');
    if (results.dbus !== 'ok') failures.push('dbus');
    if (typeof results.sdkVersion !== 'string' || !results.sdkVersion) failures.push('sdkVersion');
    if (results.sdkClientCtor !== 'function') failures.push('sdkClientCtor');
    if (results.accountInit !== 'function') failures.push('accountInit');

    if (failures.length > 0) {
        results.strictFailures = failures;
        process.exitCode = 1;
    }
}

async function main() {
    results.node = process.versions.node;

    try {
        const db = new DatabaseSync(':memory:');
        db.exec('CREATE TABLE t(k TEXT PRIMARY KEY, v BLOB)');
        db.prepare('INSERT INTO t VALUES (?, ?)').run('a', Buffer.from('bytes'));
        const row = db.prepare('SELECT v FROM t WHERE k = ?').get('a') as { v: Uint8Array };
        results.sqlite = Buffer.from(row.v).toString() === 'bytes' ? 'ok (blob round-trip)' : 'MISMATCH';
        db.close();
    } catch (error) {
        results.sqlite = `FAILED: ${(error as Error).message}`;
    }

    // OpenPGP through Proton's crypto proxy, running in-process.
    try {
        CryptoApi.init({});
        CryptoProxy.setEndpoint(new CryptoApi(), (endpoint: any) => endpoint.clearKeyStore());
        const key = await CryptoProxy.generateKey({ userIDs: [{ name: 'probe', email: 'probe@example.com' }] });
        const encrypted = await CryptoProxy.encryptMessage({ textData: 'halyard', encryptionKeys: key });
        const decrypted = await CryptoProxy.decryptMessage({
            armoredMessage: encrypted.message,
            decryptionKeys: key,
        });
        results.cryptoRoundTrip = decrypted.data === 'halyard' ? 'ok' : `MISMATCH: ${decrypted.data}`;
        results.openPGPModule = new OpenPGPCryptoWithCryptoProxy(CryptoProxy) ? 'ok' : 'null';
    } catch (error) {
        results.cryptoRoundTrip = `FAILED: ${(error as Error).message}`;
    }

    // D-Bus: we need it both to expose the daemon and to reach GNOME Keyring.
    try {
        const bus = dbus.sessionBus();
        const proxy = await bus.getProxyObject('org.freedesktop.DBus', '/org/freedesktop/DBus');
        const iface = proxy.getInterface('org.freedesktop.DBus');
        const names: string[] = await iface.ListNames();
        results.dbus = 'ok';
        results.secretServicePresent = names.includes('org.freedesktop.secrets');

        if (names.includes('org.freedesktop.secrets')) {
            const secrets = await bus.getProxyObject('org.freedesktop.secrets', '/org/freedesktop/secrets');
            results.secretServiceReachable = secrets.getInterface('org.freedesktop.Secret.Service') ? 'ok' : 'no iface';
        }
        bus.disconnect();
    } catch (error) {
        results.dbus = `FAILED: ${(error as Error).message}`;
    }

    results.sdkVersion = VERSION;
    results.sdkClientCtor = typeof ProtonDriveClient;
    results.accountInit = typeof initAccount;

    applyStrictChecks();
    console.log('PROBE_RESULT ' + JSON.stringify(results, null, 2));
}

main().catch((error) => {
    console.log('PROBE_RESULT ' + JSON.stringify({ ...results, fatal: String(error) }, null, 2));
    process.exitCode = 1;
});
