import { randomBytes } from 'node:crypto';

import { getLogger } from '../log.js';
import type { SecretStore } from './keyring.js';

const logger = getLogger('credentials');

const SECRET_KEY = 'auth-session';
const SECRET_LABEL = 'Halyard — Proton Drive session';

export type SessionInfo = {
    uid: string;
    accessToken: string;
    refreshToken?: string;
};

type StoredCredentials = {
    session: SessionInfo;
    userKeyPassword: string;
    /** Encrypts the on-disk metadata cache; generated lazily on first use. */
    cachePassword?: string;
    telemetryEnabled?: boolean;
};

/**
 * Validates rather than trusts the stored blob, and degrades to "logged out"
 * on anything unexpected. A corrupt keyring entry should mean a fresh login,
 * not a daemon that crashes on every start.
 */
function parseStored(raw: string): StoredCredentials | undefined {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    const candidate = value as Record<string, unknown>;
    const session = candidate.session as Record<string, unknown> | undefined;

    if (
        typeof candidate.userKeyPassword !== 'string' ||
        typeof session !== 'object' ||
        session === null ||
        typeof session.uid !== 'string' ||
        typeof session.accessToken !== 'string' ||
        (session.refreshToken !== undefined && typeof session.refreshToken !== 'string')
    ) {
        return undefined;
    }

    return {
        session: {
            uid: session.uid,
            accessToken: session.accessToken,
            ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
        },
        userKeyPassword: candidate.userKeyPassword,
        ...(typeof candidate.cachePassword === 'string' ? { cachePassword: candidate.cachePassword } : {}),
        ...(typeof candidate.telemetryEnabled === 'boolean' ? { telemetryEnabled: candidate.telemetryEnabled } : {}),
    };
}

/**
 * Implements the `SessionCredentials` contract the Proton account module
 * expects. The SDK deliberately ships no session management, so this is ours
 * to own: hold the session in memory, persist it to the keyring, and notify
 * listeners whenever it changes so the HTTP layer can refresh its auth headers.
 */
export class Credentials {
    private sessionInfo?: SessionInfo;
    private userKeyPassword?: string;
    private cachePassword?: string;
    private telemetryEnabled = false;
    private listeners: Array<() => void> = [];

    constructor(private readonly store: SecretStore) {}

    get uid(): string | undefined {
        return this.sessionInfo?.uid;
    }

    get accessToken(): string | undefined {
        return this.sessionInfo?.accessToken;
    }

    get refreshToken(): string | undefined {
        return this.sessionInfo?.refreshToken;
    }

    on(event: 'sessionInfoChanged', callback: () => void): void {
        if (event === 'sessionInfoChanged') {
            this.listeners.push(callback);
        }
    }

    private emitChanged(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                logger.error('sessionInfoChanged listener failed', error);
            }
        }
    }

    isLoggedIn(): boolean {
        return !!this.userKeyPassword && !!this.sessionInfo;
    }

    isTelemetryEnabled(): boolean {
        return this.telemetryEnabled;
    }

    getUserKeyPassword(): string | undefined {
        return this.userKeyPassword;
    }

    async getCachePassword(): Promise<string> {
        if (!this.cachePassword) {
            this.cachePassword = randomBytes(32).toString('base64');
            await this.persist();
        }
        return this.cachePassword;
    }

    async load(): Promise<void> {
        let raw: string | undefined;
        try {
            raw = await this.store.get(SECRET_KEY);
        } catch (error) {
            logger.error('Could not read the stored session', error);
            return;
        }
        if (!raw) {
            logger.info('No stored session found');
            return;
        }

        const parsed = parseStored(raw);
        if (!parsed) {
            logger.warn('Stored session was unreadable; treating as signed out');
            return;
        }

        this.sessionInfo = parsed.session;
        this.userKeyPassword = parsed.userKeyPassword;
        this.cachePassword = parsed.cachePassword;
        this.telemetryEnabled = parsed.telemetryEnabled ?? false;
        logger.info('Restored a stored session');
        this.emitChanged();
    }

    private async persist(): Promise<void> {
        if (!this.userKeyPassword || !this.sessionInfo) {
            return;
        }
        const payload: StoredCredentials = {
            session: this.sessionInfo,
            userKeyPassword: this.userKeyPassword,
            ...(this.cachePassword ? { cachePassword: this.cachePassword } : {}),
            telemetryEnabled: this.telemetryEnabled,
        };
        await this.store.set(SECRET_KEY, JSON.stringify(payload), SECRET_LABEL);
    }

    async setUserKeyPassword(userKeyPassword: string): Promise<void> {
        this.userKeyPassword = userKeyPassword;
        await this.persist();
    }

    async setSessionInfo(info: SessionInfo): Promise<void> {
        this.sessionInfo = info;
        await this.persist();
        this.emitChanged();
    }

    async setTelemetryEnabled(enabled: boolean): Promise<void> {
        this.telemetryEnabled = enabled;
        await this.persist();
    }

    async signOut(): Promise<void> {
        this.sessionInfo = undefined;
        this.userKeyPassword = undefined;
        // The cache password goes too: without it the encrypted metadata cache
        // is unreadable, which is exactly what we want after a sign-out.
        this.cachePassword = undefined;
        try {
            await this.store.delete(SECRET_KEY);
        } catch (error) {
            logger.error('Could not clear the stored session', error);
        }
        this.emitChanged();
    }
}
