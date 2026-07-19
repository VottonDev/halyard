import { CryptoProxy } from '@protontech/crypto';
import { Api as CryptoApi } from '@protontech/crypto/proxy/endpoint/api.ts';
import {
    FeatureFlags,
    NullFeatureFlagProvider,
    OpenPGPCryptoWithCryptoProxy,
    ProtonDriveClient,
    type ProtonDriveAccount,
    type ProtonDriveAccountAddress,
} from '@protontech/drive-sdk';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiClient, initAccount, type Addresses, type Auth } from 'proton-drive-sdk-account';

import { Credentials } from '../auth/credentials.js';
import type { SecretStore } from '../auth/keyring.js';
import { accountUrl, APP_VERSION_HEADER, AUTH_CLIENT_ID, AUTH_CLIENT_ID as authClientId, baseUrl, configDir } from '../config.js';
import { getLogger } from '../log.js';
import { LocalTelemetry } from '../telemetry.js';
import { createCaches, type Caches } from './caches.js';
import { HttpClient } from './httpClient.js';

const logger = getLogger('session');

/** Pass-through adapter; `Addresses` already satisfies the SDK's shape. */
class AccountAdapter implements ProtonDriveAccount {
    constructor(private readonly addresses: Addresses) {}

    getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress> {
        return this.addresses.getOwnPrimaryAddress();
    }
    getOwnAddresses(): Promise<ProtonDriveAccountAddress[]> {
        return this.addresses.getOwnAddresses();
    }
    getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress> {
        return this.addresses.getOwnAddress(emailOrAddressId);
    }
    hasProtonAccount(email: string): Promise<boolean> {
        return this.addresses.hasProtonAccount(email);
    }
    getPublicKeys(email: string, forceRefresh?: boolean) {
        return this.addresses.getPublicKeys(email, forceRefresh);
    }
}

/**
 * A stable per-installation identifier.
 *
 * The SDK tags server-side upload drafts with this. If a large upload is
 * interrupted, a later run presenting the same id can clean up its own
 * abandoned draft automatically; without it the user has to intervene. So this
 * must persist across restarts.
 */
async function getClientUid(): Promise<string> {
    const file = path.join(configDir, 'client-uid');
    try {
        const existing = (await fs.readFile(file, 'utf8')).trim();
        if (existing) {
            return existing;
        }
    } catch {
        // Not created yet.
    }
    const uid = `halyard-${randomUUID()}`;
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(file, uid, { mode: 0o600 });
    return uid;
}

let cryptoInitialised = false;

function initCrypto(): OpenPGPCryptoWithCryptoProxy {
    if (!cryptoInitialised) {
        CryptoApi.init({});
        CryptoProxy.setEndpoint(new CryptoApi(), async (endpoint) => {
            endpoint.clearKeyStore();
        });
        cryptoInitialised = true;
    }
    return new OpenPGPCryptoWithCryptoProxy(CryptoProxy);
}

export type AuthState = 'pending' | 'success' | 'failed' | 'cancelled';

export type Account = {
    loggedIn: boolean;
    email: string | null;
    displayName: string | null;
};

/**
 * Owns everything that depends on being signed in: the Drive client, the
 * caches, and the account session itself. The sync engine asks this for a
 * client and gets a clear error if there is not one.
 */
export class DriveSession {
    private client?: ProtonDriveClient;
    private caches?: Caches;
    private auth?: Auth;
    private addresses?: Addresses;
    private apiClient?: ApiClient;
    private loginTask?: { abort: AbortController; promise: Promise<void> };
    private cachedEmail: string | null = null;

    readonly credentials: Credentials;

    private authListeners: Array<(state: AuthState, error?: string) => void> = [];

    private constructor(credentials: Credentials) {
        this.credentials = credentials;
    }

    static async create(store: SecretStore): Promise<DriveSession> {
        const credentials = new Credentials(store);
        await credentials.load();
        const session = new DriveSession(credentials);
        await session.build();
        return session;
    }

    onAuthStateChanged(listener: (state: AuthState, error?: string) => void): void {
        this.authListeners.push(listener);
    }

    private emitAuth(state: AuthState, error?: string): void {
        for (const listener of this.authListeners) {
            try {
                listener(state, error);
            } catch (listenerError) {
                logger.error('Auth listener failed', listenerError);
            }
        }
    }

    /** Constructs the API/account layer. Safe to call while signed out. */
    private async build(): Promise<void> {
        const openPGPCryptoModule = initCrypto();

        const apiClient = new ApiClient({
            baseUrl,
            appVersion: APP_VERSION_HEADER,
            credentials: this.credentials,
            logger: getLogger('account'),
        });
        this.apiClient = apiClient;

        const { addresses, auth, srp } = await initAccount({
            authClientId,
            apiClient,
            credentials: this.credentials,
            cryptoProxy: CryptoProxy,
            logger: getLogger('account'),
            accountUrl,
        });
        this.auth = auth;
        this.addresses = addresses;

        const caches = createCaches(() => this.credentials.getCachePassword());
        this.caches = caches;

        this.client = new ProtonDriveClient({
            httpClient: new HttpClient(apiClient),
            entitiesCache: caches.entitiesCache,
            cryptoCache: caches.cryptoCache,
            account: new AccountAdapter(addresses),
            openPGPCryptoModule,
            srpModule: srp,
            telemetry: new LocalTelemetry() as never,
            config: {
                baseUrl,
                clientUid: await getClientUid(),
            },
            // Matches the reference CLI. Both flags are on in Proton's own
            // clients; the SDK's defaults are conservative because the flags
            // normally arrive from a feature-flag service we do not have.
            featureFlagProvider: {
                isEnabled: async (flag: string) =>
                    flag === FeatureFlags.DriveCryptoEncryptBlocksWithPgpAead ||
                    flag === FeatureFlags.DriveSmallFileUpload,
            },
        });
    }

    isLoggedIn(): boolean {
        return this.credentials.isLoggedIn();
    }

    getClient(): ProtonDriveClient {
        if (!this.client || !this.isLoggedIn()) {
            throw new Error('Not signed in to Proton Drive');
        }
        return this.client;
    }

    async getAccount(): Promise<Account> {
        if (!this.isLoggedIn()) {
            return { loggedIn: false, email: null, displayName: null };
        }
        if (!this.cachedEmail) {
            try {
                const address = await this.addresses?.getOwnPrimaryAddress();
                this.cachedEmail = address?.email ?? null;
            } catch (error) {
                logger.warn(`Could not resolve the primary address: ${error}`);
            }
        }
        return { loggedIn: true, email: this.cachedEmail, displayName: this.cachedEmail };
    }

    /**
     * Starts Proton's web sign-in fork and resolves with the URL to open.
     * Completion is reported asynchronously via the auth-state listeners.
     *
     * Signing in through the browser means this app never handles the
     * password, and 2FA/SSO are handled entirely by Proton.
     */
    async beginLogin(): Promise<string> {
        if (!this.auth) {
            throw new Error('Session is not initialised');
        }
        if (this.loginTask) {
            throw new Error('A sign-in attempt is already in progress');
        }

        const auth = this.auth;
        const abort = new AbortController();

        const url = await new Promise<string>((resolveUrl, rejectUrl) => {
            let urlDelivered = false;

            const promise = auth
                .authViaWeb(async (signInUrl: string) => {
                    urlDelivered = true;
                    resolveUrl(signInUrl);
                }, abort.signal)
                .then(async () => {
                    logger.info('Sign-in completed');
                    this.cachedEmail = null;
                    this.emitAuth('success');
                })
                .catch((error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    if (abort.signal.aborted) {
                        logger.info('Sign-in cancelled');
                        this.emitAuth('cancelled');
                    } else {
                        logger.error('Sign-in failed', error);
                        this.emitAuth('failed', message);
                    }
                    // If we never got as far as producing a URL, surface the
                    // failure to the caller instead of leaving it hanging.
                    if (!urlDelivered) {
                        rejectUrl(error instanceof Error ? error : new Error(message));
                    }
                })
                .finally(() => {
                    this.loginTask = undefined;
                });

            this.loginTask = { abort, promise };
        });

        this.emitAuth('pending');
        return url;
    }

    cancelLogin(): void {
        this.loginTask?.abort.abort();
    }

    async logout(): Promise<void> {
        this.cancelLogin();
        try {
            await this.auth?.logout();
        } catch (error) {
            logger.warn(`Sign-out request failed, clearing local session anyway: ${error}`);
        }
        await this.credentials.signOut();
        await this.caches?.clearAll();
        this.cachedEmail = null;
        this.emitAuth('cancelled');
    }
}
