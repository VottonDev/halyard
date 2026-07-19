import * as dbus from 'dbus-next';
import fs from 'node:fs/promises';
import path from 'node:path';

import { configDir } from '../config.js';
import { getLogger } from '../log.js';

const logger = getLogger('keyring');

const SECRETS_SERVICE = 'org.freedesktop.secrets';
const SECRETS_PATH = '/org/freedesktop/secrets';
const DEFAULT_COLLECTION = '/org/freedesktop/secrets/aliases/default';
const SERVICE_IFACE = 'org.freedesktop.Secret.Service';
const COLLECTION_IFACE = 'org.freedesktop.Secret.Collection';
const ITEM_IFACE = 'org.freedesktop.Secret.Item';
const PROMPT_IFACE = 'org.freedesktop.Secret.Prompt';

const ATTR_APPLICATION = 'halyard';

/**
 * Stores the session secret in the GNOME keyring over the freedesktop Secret
 * Service API.
 *
 * We speak the D-Bus protocol directly rather than binding libsecret, because
 * we already hold a bus connection for IPC and this keeps the daemon free of
 * native modules entirely.
 */
export class Keyring {
    private session?: string;

    constructor(private readonly bus: dbus.MessageBus) {}

    private async getService() {
        const object = await this.bus.getProxyObject(SECRETS_SERVICE, SECRETS_PATH);
        return object.getInterface(SERVICE_IFACE);
    }

    /**
     * Opens a "plain" transport session. The secret then crosses the bus
     * unencrypted, which is fine: it is a local socket with per-user
     * permissions, and the alternative (dh-ietf1024) buys nothing against an
     * attacker who can already read our process memory.
     */
    private async getSession(): Promise<string> {
        if (this.session) {
            return this.session;
        }
        const service = await this.getService();
        const [, sessionPath] = await service.OpenSession('plain', new dbus.Variant('s', ''));
        this.session = sessionPath;
        return sessionPath;
    }

    /**
     * Drives an org.freedesktop.Secret.Prompt to completion. Prompts appear
     * when the login keyring is locked and the user must type their password.
     */
    private async handlePrompt(promptPath: string): Promise<boolean> {
        if (!promptPath || promptPath === '/') {
            return true;
        }
        const object = await this.bus.getProxyObject(SECRETS_SERVICE, promptPath);
        const prompt = object.getInterface(PROMPT_IFACE);

        return new Promise<boolean>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Timed out waiting for the keyring prompt'));
            }, 120_000);

            prompt.on('Completed', (dismissed: boolean) => {
                clearTimeout(timer);
                resolve(!dismissed);
            });

            prompt.Prompt('').catch((error: unknown) => {
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    private async unlockCollection(): Promise<void> {
        const service = await this.getService();
        const [, promptPath] = await service.Unlock([DEFAULT_COLLECTION]);
        const ok = await this.handlePrompt(promptPath);
        if (!ok) {
            throw new Error('The keyring was not unlocked');
        }
    }

    async get(key: string): Promise<string | undefined> {
        const service = await this.getService();
        const attributes = { application: ATTR_APPLICATION, key };
        const [unlocked, locked] = await service.SearchItems(attributes);

        let itemPath: string | undefined = unlocked[0];
        if (!itemPath && locked.length > 0) {
            await this.unlockCollection();
            const [nowUnlocked] = await service.SearchItems(attributes);
            itemPath = nowUnlocked[0];
        }
        if (!itemPath) {
            return undefined;
        }

        const session = await this.getSession();
        const object = await this.bus.getProxyObject(SECRETS_SERVICE, itemPath);
        const item = object.getInterface(ITEM_IFACE);
        const secret = await item.GetSecret(session);
        // Secret struct is (session, parameters, value, contentType).
        const value = secret[2] as Buffer;
        return Buffer.from(value).toString('utf8');
    }

    async set(key: string, value: string, label: string): Promise<void> {
        await this.unlockCollection();
        const session = await this.getSession();

        const object = await this.bus.getProxyObject(SECRETS_SERVICE, DEFAULT_COLLECTION);
        const collection = object.getInterface(COLLECTION_IFACE);

        const properties = {
            'org.freedesktop.Secret.Item.Label': new dbus.Variant('s', label),
            'org.freedesktop.Secret.Item.Attributes': new dbus.Variant('a{ss}', {
                application: ATTR_APPLICATION,
                key,
            }),
        };
        const secret = [session, Buffer.alloc(0), Buffer.from(value, 'utf8'), 'text/plain'];

        const [, promptPath] = await collection.CreateItem(properties, secret, true);
        await this.handlePrompt(promptPath);
    }

    async delete(key: string): Promise<void> {
        const service = await this.getService();
        const [unlocked, locked] = await service.SearchItems({ application: ATTR_APPLICATION, key });
        for (const itemPath of [...unlocked, ...locked]) {
            const object = await this.bus.getProxyObject(SECRETS_SERVICE, itemPath);
            const item = object.getInterface(ITEM_IFACE);
            const promptPath = await item.Delete();
            await this.handlePrompt(promptPath);
        }
    }
}

/**
 * Secret store contract, so the daemon does not care which backend is in use.
 */
export interface SecretStore {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string, label: string): Promise<void>;
    delete(key: string): Promise<void>;
}

/**
 * Plaintext fallback for headless and CI use only, mirroring the reference
 * CLI's `--unsafe-secrets` escape hatch. Never selected unless explicitly
 * requested, because it puts long-lived tokens on disk in the clear.
 */
class PlaintextStore implements SecretStore {
    private readonly file = path.join(configDir, 'unsafe-secrets.json');

    private async readAll(): Promise<Record<string, string>> {
        try {
            return JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, string>;
        } catch {
            return {};
        }
    }

    private async writeAll(data: Record<string, string>): Promise<void> {
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(data), { mode: 0o600 });
    }

    async get(key: string): Promise<string | undefined> {
        return (await this.readAll())[key];
    }

    async set(key: string, value: string): Promise<void> {
        const all = await this.readAll();
        all[key] = value;
        await this.writeAll(all);
    }

    async delete(key: string): Promise<void> {
        const all = await this.readAll();
        delete all[key];
        await this.writeAll(all);
    }
}

export async function createSecretStore(bus: dbus.MessageBus): Promise<SecretStore> {
    if (process.env.HALYARD_UNSAFE_SECRETS === '1') {
        logger.warn('Using plaintext secret storage because HALYARD_UNSAFE_SECRETS=1. Do not use this normally.');
        return new PlaintextStore();
    }

    const keyring = new Keyring(bus);
    // Probe once at startup so a missing keyring is a clear error at login
    // rather than a confusing failure deep inside the auth flow.
    try {
        await keyring.get('__probe__');
        logger.info('Using the system keyring for secret storage');
        return keyring;
    } catch (error) {
        throw new Error(
            'No usable secret service found on the session bus. Halyard stores your Proton session in the ' +
                'GNOME keyring; install/enable gnome-keyring (or another Secret Service provider) and try again. ' +
                `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}
