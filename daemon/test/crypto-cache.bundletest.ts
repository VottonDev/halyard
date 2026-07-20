import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import '@protontech/crypto/polyfill';

import { CryptoProxy, type SessionKey } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import type { CachedCryptoMaterial } from '@protontech/drive-sdk';
import { DatabaseSync } from 'node:sqlite';

type CachedPrivateKey = NonNullable<CachedCryptoMaterial['nodeKeys']>['key'];

let temporaryRoot: string;

before(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'halyard-crypto-cache-'));
    process.env.XDG_CACHE_HOME = temporaryRoot;
    CryptoApi.init({});
    CryptoProxy.setEndpoint(new CryptoApi(), async (endpoint) => endpoint.clearKeyStore());
});

after(async () => {
    await CryptoProxy.releaseEndpoint();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
});

test('the encrypted SDK crypto cache survives a Halyard restart', async () => {
    // Import after setting XDG_CACHE_HOME because config paths are resolved at
    // module initialisation. The temporary directory keeps this test wholly
    // separate from a developer's real metadata cache.
    const { createCaches } = await import('../src/drive/caches.ts');
    const password = Buffer.alloc(32, 0x5a).toString('base64');
    const getPassword = async () => password;

    const nodeKey = await generatePrivateKey('node');
    const shareKey = await generatePrivateKey('share');
    const publicShareKey = await generatePrivateKey('public-share');
    const passphraseSessionKey = await generateSessionKey(nodeKey);
    const contentKeyPacketSessionKey = await generateSessionKey(nodeKey);
    const contentKeyPacket = new Uint8Array(Array.from({ length: 64 }, (_, index) => index + 1));
    const hashKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

    const original: CachedCryptoMaterial = {
        nodeKeys: {
            passphrase: 'synthetic-node-passphrase',
            key: nodeKey,
            passphraseSessionKey,
            contentKeyPacket,
            contentKeyPacketSessionKey,
            hashKey,
        },
        shareKey: {
            key: shareKey,
            passphraseSessionKey: await generateSessionKey(shareKey),
        },
        publicShareKey: { key: publicShareKey },
    };

    const firstProcess = createCaches(getPassword);
    await firstProcess.cryptoCache.setEntity('fixture', original, ['node:test']);

    // A second cache instance models a new daemon process opening state written
    // by the previous version. This is the boundary most likely to expose an
    // SDK crypto-object or serialisation change.
    const restartedProcess = createCaches(getPassword);
    const restored = await restartedProcess.cryptoCache.getEntity('fixture');

    assert.equal(restored.nodeKeys?.passphrase, original.nodeKeys?.passphrase);
    await assertSamePrivateKeys(nodeKey, restored.nodeKeys!.key);
    assertSameSessionKeys(passphraseSessionKey, restored.nodeKeys!.passphraseSessionKey);
    assert.deepEqual(restored.nodeKeys!.contentKeyPacket, contentKeyPacket);
    assertSameSessionKeys(contentKeyPacketSessionKey, restored.nodeKeys!.contentKeyPacketSessionKey!);
    assert.deepEqual(restored.nodeKeys!.hashKey, hashKey);
    await assertSamePrivateKeys(shareKey, restored.shareKey!.key);
    assertSameSessionKeys(original.shareKey!.passphraseSessionKey, restored.shareKey!.passphraseSessionKey);
    await assertSamePrivateKeys(publicShareKey, restored.publicShareKey!.key);

    const tagged = await Array.fromAsync(restartedProcess.cryptoCache.iterateEntitiesByTag('node:test'));
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].key, 'fixture');
    assert.equal(tagged[0].ok, true);

    // Values in SQLite must remain encrypted at rest. In particular, neither
    // the synthetic passphrase nor an armoured private key may be visible.
    const database = new DatabaseSync(path.join(temporaryRoot, 'halyard', 'crypto.sqlite'), { readOnly: true });
    const row = database.prepare('SELECT value FROM entities WHERE key = ?').get('fixture') as { value: string };
    database.close();
    assert.equal(row.value.includes('synthetic-node-passphrase'), false);
    assert.equal(row.value.includes('PRIVATE KEY'), false);

    await restartedProcess.clearAll();
});

async function generatePrivateKey(name: string) {
    return CryptoProxy.generateKey({
        userIDs: [{ name: `Halyard ${name} cache test` }],
        type: 'ecc',
        curve: 'ed25519Legacy',
    });
}

async function generateSessionKey(recipientPrivateKey: Awaited<ReturnType<typeof generatePrivateKey>>) {
    const publicKey = await CryptoProxy.importPublicKey({
        binaryKey: await CryptoProxy.exportPublicKey({ key: recipientPrivateKey, format: 'binary' }),
    });
    return CryptoProxy.generateSessionKey({ recipientKeys: publicKey });
}

async function assertSamePrivateKeys(left: CachedPrivateKey, right: CachedPrivateKey) {
    const [leftArmoured, rightArmoured] = await Promise.all([
        CryptoProxy.exportPrivateKey({ privateKey: left, passphrase: null }),
        CryptoProxy.exportPrivateKey({ privateKey: right, passphrase: null }),
    ]);
    assert.equal(leftArmoured, rightArmoured);
}

function assertSameSessionKeys(left: SessionKey, right: SessionKey) {
    assert.deepEqual(Buffer.from(left.data), Buffer.from(right.data));
    assert.equal(left.algorithm, right.algorithm);
    assert.equal(left.aeadAlgorithm, right.aeadAlgorithm);
}
