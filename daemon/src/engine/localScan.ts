import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { IGNORED_NAMES, IGNORED_PREFIXES, IGNORED_SUFFIXES } from '../config.js';
import { getLogger } from '../log.js';
import type { BaseEntry, LocalItem, RemoteItem } from './types.js';

const logger = getLogger('scan');

export function isIgnoredName(name: string): boolean {
    if (IGNORED_NAMES.has(name)) {
        return true;
    }
    if (IGNORED_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        return true;
    }
    return IGNORED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * SHA-1 of the file's contents.
 *
 * SHA-1 specifically because that is what Drive stores in a revision's
 * `claimedDigests`, so using the same algorithm lets us compare local and
 * remote content without downloading anything.
 */
export async function hashFile(absolutePath: string): Promise<string | null> {
    try {
        const hash = createHash('sha1');
        await pipeline(fs.createReadStream(absolutePath), hash);
        return hash.digest('hex');
    } catch (error) {
        logger.warn(`Could not hash ${absolutePath}: ${error}`);
        return null;
    }
}

/**
 * Walks a pair's local directory.
 *
 * Symlinks are skipped rather than followed: following them invites cycles and
 * would silently pull files from outside the pair into Drive.
 */
export async function scanLocal(root: string): Promise<Map<string, LocalItem>> {
    const items = new Map<string, LocalItem>();

    async function walk(directory: string, prefix: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fsp.readdir(directory, { withFileTypes: true });
        } catch (error) {
            logger.warn(`Could not read ${directory}: ${error}`);
            return;
        }

        for (const entry of entries) {
            if (isIgnoredName(entry.name)) {
                continue;
            }
            const absolute = path.join(directory, entry.name);
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

            if (entry.isSymbolicLink()) {
                continue;
            }

            let stats: fs.Stats;
            try {
                stats = await fsp.stat(absolute);
            } catch {
                // Vanished between readdir and stat; the next cycle will catch it.
                continue;
            }

            if (entry.isDirectory()) {
                items.set(relative, {
                    path: relative,
                    type: 'folder',
                    mtime: Math.floor(stats.mtimeMs),
                    size: 0,
                    inode: Number(stats.ino),
                    device: Number(stats.dev),
                });
                await walk(absolute, relative);
            } else if (entry.isFile()) {
                items.set(relative, {
                    path: relative,
                    type: 'file',
                    mtime: Math.floor(stats.mtimeMs),
                    size: stats.size,
                    inode: Number(stats.ino),
                    device: Number(stats.dev),
                });
            }
        }
    }

    await walk(root, '');
    return items;
}

/**
 * Fills in content hashes, but only where a sync decision actually depends on
 * one. Hashing every file on every cycle would make large pairs unusable, so
 * we hash exactly two cases:
 *
 *   - a file whose timestamp or size no longer matches the base, where the
 *     hash decides "genuinely edited" versus "merely touched"; and
 *   - a file that appeared on both sides at once, where the hash decides
 *     whether it is a conflict at all.
 */
export async function fillRequiredHashes(
    root: string,
    local: Map<string, LocalItem>,
    base: Map<string, BaseEntry>,
    remote: Map<string, RemoteItem>,
): Promise<void> {
    const needed: LocalItem[] = [];

    for (const item of local.values()) {
        if (item.type !== 'file') {
            continue;
        }
        const baseEntry = base.get(item.path);
        if (baseEntry) {
            if (item.mtime !== baseEntry.localMtime || item.size !== baseEntry.localSize) {
                needed.push(item);
            }
        } else if (remote.has(item.path)) {
            needed.push(item);
        }
    }

    if (needed.length === 0) {
        return;
    }
    logger.debug(`Hashing ${needed.length} file(s)`);

    // Bounded concurrency: hashing is I/O bound, but letting it run unbounded
    // over a large folder starves the rest of the daemon.
    const CONCURRENCY = 4;
    let index = 0;
    async function worker(): Promise<void> {
        while (index < needed.length) {
            const item = needed[index++];
            item.hash = await hashFile(path.join(root, item.path));
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, needed.length) }, worker));
}
