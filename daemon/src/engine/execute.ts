import { NodeWithSameNameExistsValidationError, type ProtonDriveClient } from '@protontech/drive-sdk';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { PARTIAL_DOWNLOAD_SUFFIX } from '../config.js';
import { getLogger } from '../log.js';
import type { SyncDatabase } from './db.js';
import { hashFile } from './localScan.js';
import type {
    Action,
    BaseEntry,
    LocalItem,
    NodeKind,
    Pair,
    RemoteItem,
    SyncEvent,
    SyncEventAction,
} from './types.js';

const logger = getLogger('execute');

const MIME_BY_EXTENSION: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.html': 'text/html',
    '.csv': 'text/csv',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function mediaTypeFor(filePath: string): string {
    return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Renames a path, falling back to copy-then-delete across device boundaries.
 *
 * `rename(2)` fails with EXDEV between filesystems — and on btrfs, between
 * *subvolumes* of the same filesystem, which is easy to hit without realising
 * since subvolumes look like ordinary directories. A synced folder containing
 * a subvolume (or a `@home`-style layout) would otherwise fail every move.
 *
 * The fallback copy requests COPYFILE_FICLONE, so on btrfs it becomes a
 * copy-on-write reflink — near-instant and costing no extra space — rather
 * than duplicating the data. The flag degrades to an ordinary copy on
 * filesystems that cannot clone, so it is always safe to ask for.
 */
async function movePath(from: string, to: string): Promise<void> {
    try {
        await fsp.rename(from, to);
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
            throw error;
        }
    }

    logger.debug(`Cross-device move, cloning instead: ${from} -> ${to}`);
    await fsp.cp(from, to, {
        recursive: true,
        preserveTimestamps: true,
        force: true,
        mode: fs.constants.COPYFILE_FICLONE,
    });
    await fsp.rm(from, { recursive: true, force: true });
}

export type Progress = {
    kind: 'upload' | 'download';
    path: string;
    bytesDone: number;
    bytesTotal: number;
};

export type ExecuteContext = {
    pair: Pair;
    db: SyncDatabase;
    client: ProtonDriveClient;
    local: Map<string, LocalItem>;
    remote: Map<string, RemoteItem>;
    signal?: AbortSignal;
    onProgress?: (progress: Progress | null) => void;
};

export type ExecuteResult = {
    completed: number;
    failed: Array<{ action: Action; error: string }>;
    bytesUp: number;
    bytesDown: number;
    filesUp: number;
    filesDown: number;
};

/**
 * Performs a reconciliation plan.
 *
 * Failures are collected per action rather than aborting the batch: one
 * unreadable file should not stop the other thousand from syncing. Anything
 * that fails simply stays un-based, so the next cycle retries it.
 */
export class Executor {
    /** Maps a relative path to its remote node uid, updated as we create nodes. */
    private pathToUid = new Map<string, string>();

    constructor(private readonly context: ExecuteContext) {
        for (const [itemPath, item] of context.remote) {
            this.pathToUid.set(itemPath, item.uid);
        }
    }

    private absolute(relative: string): string {
        return path.join(this.context.pair.localPath, relative);
    }

    private parentUidFor(relative: string): string {
        const slash = relative.lastIndexOf('/');
        if (slash === -1) {
            return this.context.pair.remoteUid;
        }
        const parent = relative.slice(0, slash);
        const uid = this.pathToUid.get(parent);
        if (!uid) {
            throw new Error(`Remote folder for "${parent}" does not exist yet`);
        }
        return uid;
    }

    async run(actions: Action[]): Promise<ExecuteResult> {
        const result: ExecuteResult = {
            completed: 0,
            failed: [],
            bytesUp: 0,
            bytesDown: 0,
            filesUp: 0,
            filesDown: 0,
        };
        const events: Array<Omit<SyncEvent, 'id' | 'pairId'>> = [];

        for (const action of actions) {
            if (this.context.signal?.aborted) {
                break;
            }
            // Described before the action runs: afterwards the local and
            // remote snapshots no longer say what the file looked like when
            // we decided, and "was it already here?" is the whole difference
            // between "downloaded" and "overwritten".
            const described = this.describe(action);
            try {
                const performed = await this.perform(action, result);
                result.completed += 1;
                if (described && performed) {
                    events.push({ ...described, at: Date.now(), outcome: 'ok', error: null });
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`Action ${action.kind} failed: ${message}`);
                result.failed.push({ action, error: message });
                if (described) {
                    events.push({ ...described, at: Date.now(), outcome: 'failed', error: message });
                }
            }
        }

        // One batch per cycle: a large sync can produce thousands of these and
        // a commit apiece would cost more than the sync.
        this.context.db.recordEvents(this.context.pair.id, events);

        this.context.onProgress?.(null);
        return result;
    }

    /**
     * Restates an action in the vocabulary the activity log uses, or returns
     * null for the base-keeping actions that have no user-visible effect.
     *
     * The log is how someone finds out why a file vanished, so this leans on
     * the distinctions that answer that question — whether a download replaced
     * something, which side a deletion came from — rather than mirroring the
     * executor's own action names.
     */
    private describe(
        action: Action,
    ): Pick<SyncEvent, 'action' | 'path' | 'toPath' | 'type' | 'size'> | null {
        const describeAs = (
            kind: SyncEventAction,
            path: string,
            extra: { toPath?: string | null; type?: NodeKind; size?: number | null } = {},
        ) => ({
            action: kind,
            path,
            toPath: extra.toPath ?? null,
            type: extra.type ?? 'file',
            size: extra.size ?? null,
        });

        switch (action.kind) {
            case 'createLocalFolder':
                return describeAs('createdLocalFolder', action.path, { type: 'folder' });

            case 'createRemoteFolder':
                return describeAs('createdRemoteFolder', action.path, { type: 'folder' });

            case 'download':
                return describeAs(
                    // Already present locally means this overwrote something.
                    this.context.local.has(action.path) ? 'updatedLocal' : 'downloaded',
                    action.path,
                    { size: this.context.remote.get(action.path)?.size ?? null },
                );

            case 'upload':
                return describeAs(
                    action.existingRemoteUid ? 'updatedRemote' : 'uploaded',
                    action.path,
                    { size: this.context.local.get(action.path)?.size ?? null },
                );

            case 'deleteLocal':
                return describeAs('deletedLocal', action.path, { type: action.type });

            case 'trashRemote':
                return describeAs('trashedRemote', action.path, {
                    type: this.context.remote.get(action.path)?.type ?? 'file',
                });

            case 'moveLocal':
                return describeAs('movedLocal', action.from, {
                    toPath: action.to,
                    // A remote-detected move rewrites the local snapshot to the
                    // destination path, so the source key is already gone; fall
                    // back to the destination to recover the node type.
                    type:
                        this.context.local.get(action.from)?.type ??
                        this.context.local.get(action.to)?.type ??
                        'file',
                });

            case 'moveRemote':
                return describeAs('movedRemote', action.from, {
                    toPath: action.to,
                    type: this.context.remote.get(action.from)?.type ?? 'file',
                });

            case 'refreshBase':
            case 'dropBase':
                return null;
        }
    }

    /** Returns false when the action turned out to be a no-op worth not logging. */
    private async perform(action: Action, result: ExecuteResult): Promise<boolean> {
        const { db, pair } = this.context;

        switch (action.kind) {
            case 'createLocalFolder': {
                // The path may hold a file this folder is replacing (a type
                // swap on the remote side). Reconcile only plans that when the
                // file's content matches the base, so the bytes being removed
                // are exactly what Drive already holds.
                const existing = await fsp.lstat(this.absolute(action.path)).catch(() => null);
                if (existing && !existing.isDirectory()) {
                    await fsp.rm(this.absolute(action.path), { force: true });
                }
                await fsp.mkdir(this.absolute(action.path), { recursive: true });
                const remote = this.context.remote.get(action.path);
                if (remote) {
                    const stats = await fsp.stat(this.absolute(action.path));
                    db.setBaseEntry(pair.id, {
                        path: action.path,
                        type: 'folder',
                        localMtime: Math.floor(stats.mtimeMs),
                        localSize: 0,
                        localInode: Number(stats.ino),
                        localDevice: Number(stats.dev),
                        localHash: null,
                        remoteUid: remote.uid,
                        remoteRevisionUid: null,
                        remoteHash: null,
                        remoteSize: 0,
                        remoteMtime: remote.mtime,
                    });
                }
                return true;
            }

            case 'createRemoteFolder': {
                const parentUid = this.parentUidFor(action.path);
                const name = path.basename(action.path);
                // A remote file may hold the name this folder is taking over (a
                // type swap on the local side). Reconcile only plans that when
                // the file is unchanged, so trashing it loses nothing — the
                // same content stays recoverable from Proton's Trash.
                const occupant = this.context.remote.get(action.path);
                if (occupant && occupant.type === 'file') {
                    for await (const outcome of this.context.client.trashNodes([occupant.uid])) {
                        if (!outcome.ok) {
                            throw outcome.error;
                        }
                    }
                    this.pathToUid.delete(action.path);
                }
                const local = this.context.local.get(action.path);
                const node = await this.context.client.createFolder(
                    parentUid,
                    name,
                    local ? new Date(local.mtime) : undefined,
                );
                this.pathToUid.set(action.path, node.uid);
                db.setBaseEntry(pair.id, {
                    path: action.path,
                    type: 'folder',
                    localMtime: local?.mtime ?? 0,
                    localSize: 0,
                    localInode: local?.inode ?? null,
                    localDevice: local?.device ?? null,
                    localHash: null,
                    remoteUid: node.uid,
                    remoteRevisionUid: null,
                    remoteHash: null,
                    remoteSize: 0,
                    remoteMtime: local?.mtime ?? 0,
                });
                return true;
            }

            case 'download':
                await this.download(action.path, action.remoteUid, result);
                return true;

            case 'upload':
                return await this.upload(action.path, action.existingRemoteUid, result);

            case 'deleteLocal': {
                if (!(await this.deleteLocal(action.path, action.type))) {
                    // Changed since the scan; leave the base so next cycle's
                    // reconcile sees the edit and takes the edit-wins path.
                    return false;
                }
                db.deleteBaseEntry(pair.id, action.path);
                return true;
            }

            case 'trashRemote': {
                for await (const outcome of this.context.client.trashNodes([action.remoteUid])) {
                    if (!outcome.ok) {
                        throw outcome.error;
                    }
                }
                this.pathToUid.delete(action.path);
                return true;
            }

            case 'moveLocal': {
                const from = this.absolute(action.from);
                const to = this.absolute(action.to);
                await fsp.mkdir(path.dirname(to), { recursive: true });
                await movePath(from, to);
                await this.rebaseMovedSubtree(action.from, action.to);
                return true;
            }

            case 'moveRemote': {
                await this.moveRemote(action.from, action.to, action.remoteUid);
                return true;
            }

            case 'refreshBase':
                await this.refreshBase(action.path);
                return true;

            case 'dropBase':
                db.deleteBaseEntry(pair.id, action.path);
                return true;
        }
    }

    /**
     * Rewrites the base after a local move, following the whole subtree.
     *
     * A folder move is a single directory rename that relocates everything
     * beneath it at once, so the reconciler emits one move for the folder and
     * none for its contents. The base has to follow suit: each descendant row
     * moves with the folder, or the next cycle sees those paths vanish and
     * reappear and re-hashes each file just to re-record an agreement that
     * already holds. Every row is re-stat'd from its destination, which also
     * picks up the fresh inodes a cross-device clone hands out. A plain file
     * move has no descendants, so this reduces to relocating the one row.
     */
    private async rebaseMovedSubtree(from: string, to: string): Promise<void> {
        const { db, pair } = this.context;
        // Capture the node and its descendants before deleting anything.
        const subtree = db.getBaseSubtree(pair.id, from);
        if (subtree.length === 0) {
            return;
        }

        const relocated: Array<{ newPath: string; entry: BaseEntry }> = subtree.map((entry) => ({
            newPath: entry.path === from ? to : `${to}${entry.path.slice(from.length)}`,
            entry,
        }));

        // Removes `from` and every `from/…` row in one statement; re-inserted below.
        db.deleteBaseEntry(pair.id, from);

        for (const { newPath, entry: previous } of relocated) {
            try {
                const stats = await fsp.stat(this.absolute(newPath));
                db.setBaseEntry(pair.id, {
                    ...previous,
                    path: newPath,
                    localMtime: Math.floor(stats.mtimeMs),
                    localInode: Number(stats.ino),
                    localDevice: Number(stats.dev),
                });
            } catch {
                // Destination vanished; the next cycle will sort it out.
            }
        }
    }

    private async moveRemote(from: string, to: string, remoteUid: string): Promise<void> {
        const { client, db, pair } = this.context;
        const fromParent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
        const toParent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
        const fromName = path.basename(from);
        const toName = path.basename(to);

        if (fromParent !== toParent) {
            const newParentUid = this.parentUidFor(to);
            for await (const outcome of client.moveNodes([remoteUid], newParentUid)) {
                if (!outcome.ok) {
                    throw outcome.error;
                }
            }
        }
        if (fromName !== toName) {
            await client.renameNode(remoteUid, toName);
        }

        this.pathToUid.delete(from);
        this.pathToUid.set(to, remoteUid);

        const entry = db.getBaseEntry(pair.id, from);
        if (entry) {
            db.deleteBaseEntry(pair.id, from);
            db.setBaseEntry(pair.id, { ...entry, path: to });
        }
    }

    /**
     * Downloads to a temporary file and renames into place.
     *
     * A half-written file that carries the final name would be indistinguishable
     * from a real one on the next scan, and would then be uploaded back over the
     * good remote copy. The rename is atomic within a filesystem, so the file
     * either exists complete or not at all.
     */
    private async download(relative: string, remoteUid: string, result: ExecuteResult): Promise<void> {
        const { client, db, pair, remote } = this.context;
        const target = this.absolute(relative);
        const temporary = `${target}${PARTIAL_DOWNLOAD_SUFFIX}`;

        await fsp.mkdir(path.dirname(target), { recursive: true });

        const downloader = await client.getFileDownloader(remoteUid, this.context.signal);
        const total = downloader.getClaimedSizeInBytes() ?? remote.get(relative)?.size ?? 0;

        const fileStream = fs.createWriteStream(temporary);
        const controller = downloader.downloadToStream(Writable.toWeb(fileStream) as WritableStream, (done) => {
            this.context.onProgress?.({ kind: 'download', path: relative, bytesDone: done, bytesTotal: total });
        });

        try {
            await controller.completion();
        } catch (error) {
            // The SDK can reject after writing every byte when a signature
            // fails to verify. Treat that as a real failure: we cannot vouch
            // for the contents, so the partial file is discarded.
            await fsp.rm(temporary, { force: true });
            throw error;
        }

        if (controller.isDownloadCompleteWithSignatureIssues()) {
            logger.warn(`Downloaded ${relative} but its signature could not be verified`);
        }

        await fsp.rename(temporary, target);

        const remoteItem = remote.get(relative);
        if (remoteItem?.mtime) {
            // Adopt the remote timestamp so the next scan does not read this
            // freshly written file as a brand-new local edit.
            const when = new Date(remoteItem.mtime);
            await fsp.utimes(target, when, when).catch(() => undefined);
        }

        const stats = await fsp.stat(target);
        const hash = remoteItem?.hash ?? (await hashFile(target));

        db.setBaseEntry(pair.id, {
            path: relative,
            type: 'file',
            localMtime: Math.floor(stats.mtimeMs),
            localSize: stats.size,
            localInode: Number(stats.ino),
                        localDevice: Number(stats.dev),
            localHash: hash,
            remoteUid,
            remoteRevisionUid: remoteItem?.revisionUid ?? null,
            remoteHash: remoteItem?.hash ?? hash,
            remoteSize: remoteItem?.size ?? stats.size,
            remoteMtime: remoteItem?.mtime ?? Math.floor(stats.mtimeMs),
        });

        result.filesDown += 1;
        result.bytesDown += stats.size;
    }

    private async upload(relative: string, existingRemoteUid: string | null, result: ExecuteResult): Promise<boolean> {
        const { client, db, pair } = this.context;
        const source = this.absolute(relative);

        let stats: fs.Stats;
        try {
            stats = await fsp.stat(source);
        } catch {
            // Deleted while we were working; nothing to upload, and nothing to
            // tell the user about either.
            return false;
        }

        const hash = await hashFile(source);
        const metadata = {
            mediaType: mediaTypeFor(relative),
            expectedSize: stats.size,
            ...(hash ? { expectedSha1: hash } : {}),
            modificationTime: new Date(Math.floor(stats.mtimeMs)),
        };

        const openStream = (): ReadableStream =>
            Readable.toWeb(fs.createReadStream(source)) as unknown as ReadableStream;

        const onProgress = (done: number) => {
            this.context.onProgress?.({ kind: 'upload', path: relative, bytesDone: done, bytesTotal: stats.size });
        };

        let uploaded: { nodeUid: string; nodeRevisionUid: string };

        if (existingRemoteUid) {
            const uploader = await client.getFileRevisionUploader(existingRemoteUid, metadata, this.context.signal);
            const controller = await uploader.uploadFromStream(openStream(), [], onProgress);
            uploaded = await controller.completion();
        } else {
            const parentUid = this.parentUidFor(relative);
            const name = path.basename(relative);
            try {
                const uploader = await client.getFileUploader(parentUid, name, metadata, this.context.signal);
                const controller = await uploader.uploadFromStream(openStream(), [], onProgress);
                uploaded = await controller.completion();
            } catch (error) {
                // Our snapshot said this name was free but the server disagrees
                // — someone else created it. Upload as a new revision of theirs
                // instead of failing or silently duplicating.
                if (error instanceof NodeWithSameNameExistsValidationError && error.existingNodeUid) {
                    logger.info(`${relative} already exists remotely; uploading as a new revision`);
                    const uploader = await client.getFileRevisionUploader(
                        error.existingNodeUid,
                        metadata,
                        this.context.signal,
                    );
                    const controller = await uploader.uploadFromStream(openStream(), [], onProgress);
                    uploaded = await controller.completion();
                } else {
                    throw error;
                }
            }
        }

        this.pathToUid.set(relative, uploaded.nodeUid);

        db.setBaseEntry(pair.id, {
            path: relative,
            type: 'file',
            localMtime: Math.floor(stats.mtimeMs),
            localSize: stats.size,
            localInode: Number(stats.ino),
                        localDevice: Number(stats.dev),
            localHash: hash,
            remoteUid: uploaded.nodeUid,
            remoteRevisionUid: uploaded.nodeRevisionUid,
            remoteHash: hash,
            remoteSize: stats.size,
            remoteMtime: Math.floor(stats.mtimeMs),
        });

        result.filesUp += 1;
        result.bytesUp += stats.size;
        return true;
    }

    /**
     * Deletes a path that has been removed on the Drive side.
     *
     * This is genuinely destructive locally, and that is deliberate: Proton
     * Drive keeps deleted items in its own Trash, so the file remains
     * recoverable there. Keeping a second local quarantine copy would just
     * accumulate duplicates of things the user already has a way to restore.
     *
     * The safety argument holds only because we get here exclusively when the
     * local copy is *unchanged* from the base — its bytes are therefore
     * exactly what Drive is holding. A file with unsynced local edits takes
     * the "edit beats deletion" path in the reconciler and is re-uploaded
     * instead, so local-only work is never destroyed.
     *
     * That "unchanged" judgement was made at scan time, and a write can land
     * between the scan and this call — content Drive has never seen, which no
     * Trash would hold. So the path is re-stat'd immediately before removal
     * and the deletion deferred if anything drifted; returns false to signal
     * "skipped, decide again next cycle".
     */
    private async deleteLocal(relative: string, type: 'file' | 'folder'): Promise<boolean> {
        const target = this.absolute(relative);
        const scanned = this.context.local.get(relative);
        // Files only: a folder's mtime is bumped by our own child deletions
        // (which run first), so it cannot distinguish a raced-in write from
        // this very sync's work. Raced-in files inside a folder are still
        // caught — each file has its own deleteLocal, ordered before the
        // folder's, and defers individually.
        if (scanned && type === 'file') {
            try {
                const stats = await fsp.stat(target);
                if (Math.floor(stats.mtimeMs) !== scanned.mtime || stats.size !== scanned.size) {
                    logger.info(`Skipping deletion of ${relative}: modified since the scan`);
                    return false;
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return true;
                }
                throw error;
            }
        }

        try {
            if (type === 'folder') {
                // Recursive, but the reconciler orders children before parents
                // and refuses to delete a folder holding unsynced local work,
                // so by now this should be empty of anything we care about.
                await fsp.rm(target, { recursive: true, force: true });
            } else {
                await fsp.rm(target, { force: true });
            }
            logger.info(`Deleted ${relative} (removed on Drive; recoverable from Proton's Trash)`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        return true;
    }

    /** Records that the two sides already agree, without transferring anything. */
    private async refreshBase(relative: string): Promise<void> {
        const { db, pair, remote } = this.context;
        const local = this.context.local.get(relative);
        const remoteItem = remote.get(relative);
        if (!local || !remoteItem) {
            return;
        }

        const existing = db.getBaseEntry(pair.id, relative);
        const entry: BaseEntry = {
            path: relative,
            type: local.type,
            localMtime: local.mtime,
            localSize: local.size,
            localInode: local.inode,
            localDevice: local.device,
            localHash: local.hash ?? existing?.localHash ?? null,
            remoteUid: remoteItem.uid,
            remoteRevisionUid: remoteItem.revisionUid,
            remoteHash: remoteItem.hash,
            remoteSize: remoteItem.size,
            remoteMtime: remoteItem.mtime,
        };
        db.setBaseEntry(pair.id, entry);
    }
}
