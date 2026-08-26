import { CryptoProxy, type SessionKey } from '@protontech/crypto';
import type { CachedCryptoMaterial, EntityResult, ProtonDriveCache } from '@protontech/drive-sdk';
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { cacheDir } from '../config.js';
import { getLogger } from '../log.js';

const logger = getLogger('cache');

/**
 * Key/value cache backed by SQLite, matching the document-oriented shape the
 * SDK asks for: opaque serialised values addressed by key, plus plaintext tags
 * that must stay queryable for fast look-up.
 */
class SqliteCache implements ProtonDriveCache<string> {
    private readonly db: DatabaseSync;

    constructor(file: string) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec('CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS entity_tags (tag TEXT NOT NULL, key TEXT NOT NULL, UNIQUE (tag, key))',
        );
        this.db.exec('CREATE INDEX IF NOT EXISTS entity_tags_tag ON entity_tags (tag)');
        this.db.exec('CREATE INDEX IF NOT EXISTS entity_tags_key ON entity_tags (key)');
    }

    async clear(): Promise<void> {
        this.db.exec('DELETE FROM entities');
        this.db.exec('DELETE FROM entity_tags');
    }

    async setEntity(key: string, value: string, tags?: string[]): Promise<void> {
        // One transaction: an interruption between the value write and the tag
        // rewrite would otherwise leave the entity indexed under stale tags.
        this.db.exec('BEGIN');
        try {
            this.db.prepare('INSERT OR REPLACE INTO entities (key, value) VALUES (?, ?)').run(key, value);
            // Tags are replaced wholesale, not merged: the SDK treats the tag
            // list passed here as the complete set for this entity.
            this.db.prepare('DELETE FROM entity_tags WHERE key = ?').run(key);
            const insert = this.db.prepare('INSERT OR IGNORE INTO entity_tags (tag, key) VALUES (?, ?)');
            for (const tag of tags ?? []) {
                insert.run(tag, key);
            }
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async getEntity(key: string): Promise<string> {
        const row = this.db.prepare('SELECT value FROM entities WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
        if (!row) {
            throw new Error(`Entity ${key} not found`);
        }
        return row.value;
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
        for (const key of keys) {
            try {
                yield { key, ok: true, value: await this.getEntity(key) };
            } catch (error) {
                yield { key, ok: false, error: `${error}` };
            }
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
        const rows = this.db.prepare('SELECT key FROM entity_tags WHERE tag = ?').all(tag) as { key: string }[];
        yield* this.iterateEntities(rows.map((row) => row.key));
    }

    async removeEntities(keys: string[]): Promise<void> {
        const deleteEntity = this.db.prepare('DELETE FROM entities WHERE key = ?');
        const deleteTags = this.db.prepare('DELETE FROM entity_tags WHERE key = ?');
        for (const key of keys) {
            deleteEntity.run(key);
            deleteTags.run(key);
        }
    }

    close(): void {
        this.db.close();
    }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts cache values at rest with AES-256-GCM.
 *
 * The cache holds decrypted names, sizes, and folder structure.
 * That is exactly the material Proton's end-to-end encryption exists to
 * protect, so leaving it as plaintext on disk would quietly undo the guarantee
 * for anyone who can read the user's home directory.
 *
 * Keys and tags stay in the clear because they are opaque SDK identifiers and
 * must remain indexable.
 */
class EncryptedCache implements ProtonDriveCache<string> {
    private key?: Buffer;

    constructor(
        private readonly inner: SqliteCache,
        private readonly getPassword: () => Promise<string>,
    ) {}

    /**
     * Forgets the derived key. Must be called on sign-out: the keyring's cache
     * password is deleted then, and a memoised key would otherwise keep
     * encrypting new rows under a deleted secret. The next restart would create
     * a fresh password and leave those rows unreadable.
     */
    dropKey(): void {
        this.key = undefined;
    }

    private async getKey(): Promise<Buffer> {
        if (!this.key) {
            const password = await this.getPassword();
            // The password is already 32 bytes of CSPRNG output from the
            // keyring, so HKDF for domain separation is sufficient; there is no
            // low-entropy secret here that would need a slow KDF.
            this.key = Buffer.from(hkdfSync('sha256', Buffer.from(password, 'base64'), Buffer.alloc(0), 'halyard-cache-v1', 32));
        }
        return this.key;
    }

    private async encrypt(plaintext: string): Promise<string> {
        const key = await this.getKey();
        const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(IV_BYTES)));
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
    }

    private async decrypt(encoded: string): Promise<string> {
        const key = await this.getKey();
        const blob = Buffer.from(encoded, 'base64');
        const iv = blob.subarray(0, IV_BYTES);
        const tag = blob.subarray(blob.length - TAG_BYTES);
        const body = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    }

    async clear(): Promise<void> {
        return this.inner.clear();
    }

    async setEntity(key: string, value: string, tags?: string[]): Promise<void> {
        return this.inner.setEntity(key, await this.encrypt(value), tags);
    }

    async getEntity(key: string): Promise<string> {
        return this.decrypt(await this.inner.getEntity(key));
    }

    private async convert(result: EntityResult<string>): Promise<EntityResult<string>> {
        if (!result.ok) {
            return result;
        }
        try {
            return { key: result.key, ok: true, value: await this.decrypt(result.value) };
        } catch (error) {
            return { key: result.key, ok: false, error: `${error}` };
        }
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<string>> {
        for await (const result of this.inner.iterateEntities(keys)) {
            yield await this.convert(result);
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<string>> {
        for await (const result of this.inner.iterateEntitiesByTag(tag)) {
            yield await this.convert(result);
        }
    }

    async removeEntities(keys: string[]): Promise<void> {
        return this.inner.removeEntities(keys);
    }
}

const CRYPTO_MATERIAL_VERSION = 2;

type SerializedSessionKey = { dataBase64: string; algorithm: number; aeadAlgorithm?: number };

type SerializedCryptoMaterial = {
    v: typeof CRYPTO_MATERIAL_VERSION;
    nodeKeys?: {
        passphrase: string;
        armoredPrivateKey: string;
        passphraseSessionKey: SerializedSessionKey;
        contentKeyPacket?: string;
        contentKeyPacketSessionKey?: SerializedSessionKey;
        hashKeyBase64?: string;
    };
    shareKey?: { armoredPrivateKey: string; passphraseSessionKey: SerializedSessionKey };
    publicShareKey?: { armoredPrivateKey: string };
};

function serializeSessionKey(sessionKey: SessionKey): SerializedSessionKey {
    return {
        dataBase64: Buffer.from(sessionKey.data).toString('base64'),
        algorithm: sessionKey.algorithm as unknown as number,
        ...(sessionKey.aeadAlgorithm !== undefined
            ? { aeadAlgorithm: sessionKey.aeadAlgorithm as unknown as number }
            : {}),
    };
}

function deserializeSessionKey(json: SerializedSessionKey): SessionKey {
    const output: SessionKey = {
        data: new Uint8Array(Buffer.from(json.dataBase64, 'base64')),
        algorithm: json.algorithm as unknown as SessionKey['algorithm'],
    };
    if (json.aeadAlgorithm !== undefined) {
        output.aeadAlgorithm = json.aeadAlgorithm as unknown as NonNullable<SessionKey['aeadAlgorithm']>;
    }
    return output;
}

/**
 * Converts the SDK's live crypto objects to strings and back, so they can live
 * in the same string-valued store as everything else. Values are not encrypted
 * here. The cache underneath encrypts the whole value.
 *
 * Ported from the reference CLI; the serialised shape must stay compatible with
 * the SDK's expectations, hence the version marker.
 */
class CryptoMaterialAdapter implements ProtonDriveCache<CachedCryptoMaterial> {
    constructor(private readonly inner: ProtonDriveCache<string>) {}

    private async serialize(value: CachedCryptoMaterial): Promise<string> {
        const output: SerializedCryptoMaterial = { v: CRYPTO_MATERIAL_VERSION };

        if (value.nodeKeys) {
            const keys = value.nodeKeys;
            output.nodeKeys = {
                passphrase: keys.passphrase,
                armoredPrivateKey: await CryptoProxy.exportPrivateKey({ privateKey: keys.key, passphrase: null }),
                passphraseSessionKey: serializeSessionKey(keys.passphraseSessionKey),
                ...(keys.contentKeyPacket
                    ? { contentKeyPacket: Buffer.from(keys.contentKeyPacket).toString('base64') }
                    : {}),
                ...(keys.contentKeyPacketSessionKey
                    ? { contentKeyPacketSessionKey: serializeSessionKey(keys.contentKeyPacketSessionKey) }
                    : {}),
                ...(keys.hashKey ? { hashKeyBase64: Buffer.from(keys.hashKey).toString('base64') } : {}),
            };
        }

        if (value.shareKey) {
            output.shareKey = {
                armoredPrivateKey: await CryptoProxy.exportPrivateKey({
                    privateKey: value.shareKey.key,
                    passphrase: null,
                }),
                passphraseSessionKey: serializeSessionKey(value.shareKey.passphraseSessionKey),
            };
        }

        if (value.publicShareKey) {
            output.publicShareKey = {
                armoredPrivateKey: await CryptoProxy.exportPrivateKey({
                    privateKey: value.publicShareKey.key,
                    passphrase: null,
                }),
            };
        }

        return JSON.stringify(output);
    }

    private async deserialize(json: string): Promise<CachedCryptoMaterial> {
        const input = JSON.parse(json) as SerializedCryptoMaterial;
        if (input.v !== CRYPTO_MATERIAL_VERSION) {
            throw new Error(`Unsupported crypto cache version: ${input.v}`);
        }

        const value: CachedCryptoMaterial = {};

        if (input.nodeKeys) {
            const keys = input.nodeKeys;
            value.nodeKeys = {
                passphrase: keys.passphrase,
                key: await CryptoProxy.importPrivateKey({ armoredKey: keys.armoredPrivateKey, passphrase: null }),
                passphraseSessionKey: deserializeSessionKey(keys.passphraseSessionKey),
                ...(keys.contentKeyPacket
                    ? { contentKeyPacket: new Uint8Array(Buffer.from(keys.contentKeyPacket, 'base64')) }
                    : {}),
                ...(keys.contentKeyPacketSessionKey
                    ? { contentKeyPacketSessionKey: deserializeSessionKey(keys.contentKeyPacketSessionKey) }
                    : {}),
                ...(keys.hashKeyBase64 ? { hashKey: new Uint8Array(Buffer.from(keys.hashKeyBase64, 'base64')) } : {}),
            };
        }

        if (input.shareKey) {
            value.shareKey = {
                key: await CryptoProxy.importPrivateKey({
                    armoredKey: input.shareKey.armoredPrivateKey,
                    passphrase: null,
                }),
                passphraseSessionKey: deserializeSessionKey(input.shareKey.passphraseSessionKey),
            };
        }

        if (input.publicShareKey) {
            value.publicShareKey = {
                key: await CryptoProxy.importPrivateKey({
                    armoredKey: input.publicShareKey.armoredPrivateKey,
                    passphrase: null,
                }),
            };
        }

        return value;
    }

    async clear(): Promise<void> {
        return this.inner.clear();
    }

    async setEntity(key: string, value: CachedCryptoMaterial, tags?: string[]): Promise<void> {
        return this.inner.setEntity(key, await this.serialize(value), tags);
    }

    async getEntity(key: string): Promise<CachedCryptoMaterial> {
        return this.deserialize(await this.inner.getEntity(key));
    }

    private async convert(result: EntityResult<string>): Promise<EntityResult<CachedCryptoMaterial>> {
        if (!result.ok) {
            return result;
        }
        try {
            return { key: result.key, ok: true, value: await this.deserialize(result.value) };
        } catch (error) {
            return { key: result.key, ok: false, error: error instanceof Error ? error.message : `${error}` };
        }
    }

    async *iterateEntities(keys: string[]): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
        for await (const result of this.inner.iterateEntities(keys)) {
            yield await this.convert(result);
        }
    }

    async *iterateEntitiesByTag(tag: string): AsyncGenerator<EntityResult<CachedCryptoMaterial>> {
        for await (const result of this.inner.iterateEntitiesByTag(tag)) {
            yield await this.convert(result);
        }
    }

    async removeEntities(keys: string[]): Promise<void> {
        return this.inner.removeEntities(keys);
    }
}

export type Caches = {
    entitiesCache: ProtonDriveCache<string>;
    cryptoCache: ProtonDriveCache<CachedCryptoMaterial>;
    clearAll: () => Promise<void>;
};

export function createCaches(getPassword: () => Promise<string>): Caches {
    const entitiesDb = new SqliteCache(path.join(cacheDir, 'entities.sqlite'));
    const cryptoDb = new SqliteCache(path.join(cacheDir, 'crypto.sqlite'));

    const entitiesCache = new EncryptedCache(entitiesDb, getPassword);
    const cryptoEncrypted = new EncryptedCache(cryptoDb, getPassword);
    const cryptoCache = new CryptoMaterialAdapter(cryptoEncrypted);

    return {
        entitiesCache,
        cryptoCache,
        clearAll: async () => {
            logger.info('Clearing metadata caches');
            await entitiesDb.clear();
            await cryptoDb.clear();
            // The derived keys go with the rows: after sign-out the keyring
            // password they came from is gone, and the next sign-in must not
            // keep writing under it.
            entitiesCache.dropKey();
            cryptoEncrypted.dropKey();
        },
    };
}
