import os from 'node:os';
import path from 'node:path';

export const APP_ID = 'io.github.votton.Halyard';
export const APP_NAME = 'halyard';
export const VERSION: string = process.env.HALYARD_VERSION ?? '0.1.2';

/**
 * Proton requires third-party clients to identify themselves honestly in the
 * `x-pm-appversion` header, using the shape
 * `external-drive-{name}@{semver}-{channel}`. Spoofing this to look like a
 * first-party client is forbidden and gets applications blocked.
 */
export const APP_VERSION_HEADER = `external-drive-halyard@${VERSION}-alpha`;

/** Third-party clients use the `external-drive` auth client id for web sign-in forks. */
export const AUTH_CLIENT_ID = 'external-drive';

function xdgDir(envVar: string, fallback: string): string {
    const value = process.env[envVar];
    const base = value && path.isAbsolute(value) ? value : path.join(os.homedir(), fallback);
    return path.join(base, APP_NAME);
}

export const configDir = xdgDir('XDG_CONFIG_HOME', '.config');
export const dataDir = xdgDir('XDG_DATA_HOME', '.local/share');
export const cacheDir = xdgDir('XDG_CACHE_HOME', '.cache');
export const stateDir = xdgDir('XDG_STATE_HOME', '.local/state');

/** Bare host; the SDK prefixes https:// itself. */
export const baseUrl = process.env.HALYARD_DRIVE_BASE_URL ?? 'drive-api.proton.me';

/**
 * Account host is derived from the Drive host so that pointing the daemon at a
 * test environment moves both together, matching how the reference CLI does it.
 */
export const accountUrl = ((): string => {
    if (process.env.HALYARD_ACCOUNT_URL) {
        return process.env.HALYARD_ACCOUNT_URL;
    }
    const labels = baseUrl.split('.');
    if (labels[0] === 'drive-api') {
        return ['account', ...labels.slice(1)].join('.');
    }
    return 'account.proton.me';
})();

/**
 * Legacy trash folder from earlier versions that quarantined remotely-deleted
 * files locally. Deletions are now applied directly — Proton Drive keeps its
 * own Trash, so the remote copy is already recoverable there. The name stays
 * ignored so any leftover folder is not uploaded as new content.
 */
export const LEGACY_TRASH_DIR_NAME = '.halyard-trash';

export const IGNORED_NAMES = new Set([LEGACY_TRASH_DIR_NAME, '.halyard', '.git', '.DS_Store', 'lost+found']);

/**
 * Suffix for in-progress downloads. Downloads land here and are renamed into
 * place atomically, so a partial file never carries the real name.
 *
 * It must also be ignored by the scanner: otherwise a scan racing a download
 * sees the partial file as new local content and uploads it back to Drive.
 */
export const PARTIAL_DOWNLOAD_SUFFIX = '.halyard-part';

/** Suffixes produced by editors mid-write; syncing these is pointless churn. */
export const IGNORED_SUFFIXES = [
    '~',
    '.swp',
    '.swx',
    '.tmp',
    '.part',
    '.crdownload',
    '.partial',
    PARTIAL_DOWNLOAD_SUFFIX,
];

/** Prefixes used by editors for atomic-save scratch files. */
export const IGNORED_PREFIXES = ['.~lock.', '.goutputstream-'];
