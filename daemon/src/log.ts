import fs from 'node:fs';
import path from 'node:path';

import { stateDir } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = (process.env.HALYARD_LOG_LEVEL as LogLevel) || 'info';
const threshold = LEVEL_ORDER[configuredLevel] ?? LEVEL_ORDER.info;

const LOG_FILE = path.join(stateDir, 'halyard.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let stream: fs.WriteStream | undefined;

function getStream(): fs.WriteStream | undefined {
    if (stream) {
        return stream;
    }
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        // Rotate once rather than growing without bound. A single previous log
        // is enough to investigate a crash we have just been told about.
        try {
            if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
                fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
            }
        } catch {
            // No existing log; nothing to rotate.
        }
        stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    } catch {
        // Logging must never take the daemon down.
        return undefined;
    }
    return stream;
}

/**
 * Secrets must never reach disk. Tokens and passphrases show up in error
 * payloads and request URLs more often than you would like, so scrub centrally
 * rather than trusting every call site.
 */
function redact(message: string): string {
    return message
        .replace(/(Bearer\s+)[\w.\-~+/]+=*/gi, '$1[redacted]')
        .replace(/("?(?:access_?token|refresh_?token|password|passphrase|keyPassword|UID)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1[redacted]');
}

function write(level: LogLevel, scope: string, message: string, error?: unknown): void {
    if (LEVEL_ORDER[level] < threshold) {
        return;
    }

    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (error !== undefined) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
        line += `\n    ${detail.replace(/\n/g, '\n    ')}`;
    }
    line = redact(line);

    getStream()?.write(line + '\n');
    if (level === 'error' || level === 'warn' || process.env.HALYARD_LOG_STDERR === '1') {
        process.stderr.write(line + '\n');
    }
}

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}

export function getLogger(scope: string): Logger {
    return {
        debug: (message) => write('debug', scope, message),
        info: (message) => write('info', scope, message),
        warn: (message) => write('warn', scope, message),
        error: (message, error) => write('error', scope, message, error),
    };
}

export const logFilePath = LOG_FILE;
