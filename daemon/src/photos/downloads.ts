import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { DownloadController } from '@protontech/drive-sdk';

import { PARTIAL_DOWNLOAD_SUFFIX } from '../config.js';
import { photoFromNode, type PhotosClient } from './library.js';

export type DownloadFile = {
    uid: string; name: string; size: number | null; bytesDone: number;
    status: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled';
    path: string | null; error: string | null;
};
export type PhotoDownload = {
    id: string; destination: string; createdAt: number;
    status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';
    files: DownloadFile[];
};

/** The final component only. Names from Drive must never become local paths. */
export function safePhotoName(name: string): string {
    const cleaned = name.replace(/[\/\\\x00-\x1f\x7f]/g, '_');
    if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('This photo does not have a valid file name.');
    return cleaned;
}

export async function downloadDestination(input: string, home = os.homedir()): Promise<string> {
    if (!input || !path.isAbsolute(input) || input.includes('\0')) throw new Error('Choose a folder in your home directory.');
    const requested = path.resolve(input);
    const homePath = await fsp.realpath(home);
    const inside = (folder: string) => folder === homePath || folder.startsWith(homePath + path.sep);
    // Check existing parents before mkdir, so a symlink cannot redirect an
    // otherwise innocuous path into a different user's or a system folder.
    let parent = requested;
    while (true) {
        try {
            const real = await fsp.realpath(parent);
            if (!inside(real)) throw new Error('Choose a folder in your home directory.');
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const next = path.dirname(parent);
            if (next === parent) throw error;
            parent = next;
        }
    }
    await fsp.mkdir(requested, { recursive: true, mode: 0o700 });
    const real = await fsp.realpath(requested);
    if (!inside(real) || !(await fsp.stat(real)).isDirectory()) throw new Error('Choose a folder in your home directory.');
    return real;
}

/** Atomic publication without replacing an existing file, including symlinks. */
async function publish(temporary: string, destination: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < 10_000; n++) {
        const target = path.join(destination, n ? `${stem} (${n})${ext}` : name);
        try {
            await fsp.link(temporary, target);
            await fsp.unlink(temporary);
            return target;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
        }
    }
    throw new Error('There are too many files with this name in the download folder.');
}

/** User-requested exports. This never reads or writes the sync base or log. */
export class PhotoDownloads {
    private jobs: PhotoDownload[] = [];
    private running?: Promise<void>;
    private active?: { job: PhotoDownload; abort: AbortController; controller?: DownloadController };
    private preparing = new AbortController();
    private signalTimer?: ReturnType<typeof setTimeout>;

    private readonly getClient: () => Promise<PhotosClient | null>;
    private readonly changed: (jobs: PhotoDownload[]) => void;
    private readonly notify: (failed: boolean, title: string, body: string) => void;
    private readonly home: string;
    constructor(getClient: () => Promise<PhotosClient | null>, changed: (jobs: PhotoDownload[]) => void = () => {},
        notify: (failed: boolean, title: string, body: string) => void = () => {}, home = os.homedir()) {
        this.getClient = getClient; this.changed = changed; this.notify = notify; this.home = home;
    }

    list(): PhotoDownload[] {
        return structuredClone(this.jobs);
    }

    async start(uids: string[], destination: string): Promise<PhotoDownload> {
        if (!uids.length || uids.length > 1000 || uids.some(uid => typeof uid !== 'string' || !uid)) {
            throw new Error('Select between 1 and 1,000 photos to download.');
        }
        if (this.jobs.filter(j => ['queued', 'downloading', 'paused'].includes(j.status)).length >= 20) {
            throw new Error('Finish or cancel an existing download before adding another.');
        }
        const signal = this.preparing.signal;
        const client = await this.getClient();
        if (!client) throw new Error('No photos have been added to Proton Drive yet.');
        signal.throwIfAborted();
        const folder = await downloadDestination(destination, this.home);
        signal.throwIfAborted();
        // Resolve related still/video assets before starting the job. A live
        // photo must not silently turn into only its JPEG on export.
        const files: DownloadFile[] = [];
        const seen = new Set<string>();
        const pending = [...new Set(uids)];
        while (pending.length) {
            const uid = pending.shift()!;
            if (seen.has(uid)) continue;
            if (seen.size >= 5000) throw new Error('This selection contains too many related files. Choose fewer photos.');
            const node = await client.getNode(uid);
            signal.throwIfAborted();
            if (node.type !== 'photo' || node.trashTime || !node.name.ok) throw new Error('One of the selected photos is no longer available.');
            seen.add(uid);
            const photo = photoFromNode(node);
            files.push({ uid, name: safePhotoName(photo.name), size: photo.size, bytesDone: 0,
                status: 'queued', path: null, error: null });
            pending.push(...photo.relatedUids.filter(related => !seen.has(related)));
        }
        signal.throwIfAborted();
        if (this.jobs.filter(j => ['queued', 'downloading', 'paused'].includes(j.status)).reduce((n, j) => n + j.files.length, files.length) > 10_000) {
            throw new Error('Finish or cancel some downloads before adding more photos.');
        }
        const job: PhotoDownload = { id: randomUUID(), destination: folder, createdAt: Date.now(), status: 'queued', files };
        this.jobs.unshift(job);
        // Bounded, disposable history. Active jobs are never evicted.
        let retained = 0;
        this.jobs = this.jobs.filter((item, index) => {
            retained += item.files.length;
            return (index < 100 && retained <= 10_000) || ['queued', 'downloading', 'paused'].includes(item.status);
        });
        this.emit(); this.pump();
        return structuredClone(job);
    }

    control(id: string, action: string): void {
        const job = this.jobs.find(item => item.id === id);
        if (!job) throw new Error('This photo download is no longer available.');
        if (action === 'pause' && ['queued', 'downloading'].includes(job.status)) {
            job.status = 'paused';
            if (this.active?.job === job) this.active.controller?.pause();
        } else if (action === 'resume' && job.status === 'paused') {
            job.status = this.active?.job === job ? 'downloading' : 'queued';
            if (this.active?.job === job) this.active.controller?.resume();
            this.pump();
        } else if (action === 'cancel' && ['queued', 'downloading', 'paused'].includes(job.status)) {
            job.status = 'cancelled';
            for (const file of job.files) if (file.status === 'queued') file.status = 'cancelled';
            if (this.active?.job === job) this.active.abort.abort();
            this.pump();
        } else if (action === 'retry' && ['failed', 'cancelled'].includes(job.status)) {
            if (this.active?.job === job) throw new Error('Wait for the download to stop before retrying.');
            for (const file of job.files) if (file.status !== 'completed') {
                file.status = 'queued'; file.bytesDone = 0; file.error = null;
            }
            job.status = 'queued'; this.pump();
        } else throw new Error('This action is not available for the photo download.');
        this.emit();
    }

    private pump(): void {
        if (this.running) return;
        this.running = this.runQueue().finally(() => {
            this.running = undefined;
            if (this.jobs.some(j => j.status === 'queued')) this.pump();
        });
    }

    private async runQueue(): Promise<void> {
        while (true) {
            const job = this.jobs.find(j => j.status === 'queued');
            if (!job) return;
            const active = { job, abort: new AbortController(), controller: undefined as DownloadController | undefined };
            this.active = active;
            job.status = 'downloading'; this.emit();
            for (const file of job.files) {
                if (file.status === 'completed') continue;
                if (this.state(job) === 'cancelled') { file.status = 'cancelled'; continue; }
                while (this.state(job) === 'paused' && !active.abort.signal.aborted) {
                    // No remote requests while paused. Resume is local state.
                    await new Promise<void>(resolve => {
                        const finish = () => { clearTimeout(timer); active.abort.signal.removeEventListener('abort', finish); resolve(); };
                        const timer = setTimeout(finish, 100);
                        active.abort.signal.addEventListener('abort', finish, { once: true });
                    });
                }
                if (active.abort.signal.aborted) { file.status = 'cancelled'; continue; }
                try { await this.saveFile(job, file, active); }
                catch (error) {
                    file.status = active.abort.signal.aborted ? 'cancelled' : 'failed';
                    file.error = active.abort.signal.aborted ? null : error instanceof Error ? error.message : String(error);
                    file.bytesDone = 0;
                }
                active.controller = undefined; this.emit();
            }
            if (this.state(job) !== 'cancelled') {
                job.status = job.files.some(f => f.status === 'failed') ? 'failed' : 'completed';
                const saved = job.files.filter(f => f.status === 'completed').length;
                this.notify(job.status === 'failed', job.status === 'failed' ? 'Some photo downloads failed' : 'Photos downloaded',
                    `${saved} ${saved === 1 ? 'file saved' : 'files saved'} to ${job.destination}.`);
            }
            this.active = undefined; this.emit();
        }
    }

    private state(job: PhotoDownload): PhotoDownload['status'] { return job.status; }

    private async saveFile(job: PhotoDownload, file: DownloadFile, active: NonNullable<PhotoDownloads['active']>): Promise<void> {
        const signal = active.abort.signal;
        // Revalidate the real directory on every file. It may have been moved
        // or replaced by a symlink since the destination chooser was used.
        const destination = await downloadDestination(job.destination, this.home);
        const client = await this.getClient();
        signal.throwIfAborted();
        if (!client) throw new Error('Your photo library is no longer available.');
        const temporary = path.join(destination, `.halyard-photo-${randomUUID()}${PARTIAL_DOWNLOAD_SUFFIX}`);
        let stream: fs.WriteStream | undefined;
        try {
            const downloader = await client.getFileDownloader(file.uid, signal);
            signal.throwIfAborted();
            file.size = downloader.getClaimedSizeInBytes() ?? file.size;
            file.status = 'downloading';
            stream = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
            // The SDK consumes the writable stream's errors and aborts it on
            // failure. Keep a Node listener too, avoiding an unhandled event.
            stream.on('error', () => {});
            const controller = downloader.downloadToStream(Writable.toWeb(stream) as WritableStream, (done) => {
                file.bytesDone = done; this.emit(false);
            });
            active.controller = controller;
            if (job.status === 'paused') controller.pause();
            await controller.completion();
            signal.throwIfAborted();
            if (controller.isDownloadCompleteWithSignatureIssues()) throw new Error('The downloaded photo could not be verified.');
            // The SDK releases its writer on success without closing the
            // caller-owned stream. Flush and close it before publishing.
            if (!stream.writableEnded) stream.end();
            await this.closeStream(stream);
            if (stream.errored) throw stream.errored;
            file.path = await publish(temporary, destination, file.name);
            file.bytesDone = (await fsp.stat(file.path)).size;
            file.status = 'completed'; file.error = null;
        } finally {
            if (stream) { stream.destroy(); await this.closeStream(stream); }
            await fsp.rm(temporary, { force: true });
        }
    }

    private async closeStream(stream: fs.WriteStream): Promise<void> {
        if (stream.closed) return;
        await new Promise<void>(resolve => stream.once('close', resolve));
    }

    private emit(immediate = true): void {
        if (immediate) {
            if (this.signalTimer) clearTimeout(this.signalTimer);
            this.signalTimer = undefined; this.changed(this.list());
        } else if (!this.signalTimer) {
            this.signalTimer = setTimeout(() => { this.signalTimer = undefined; this.changed(this.list()); }, 250);
        }
    }

    async stop(clear = false): Promise<void> {
        this.preparing.abort();
        for (const job of this.jobs) if (['queued', 'downloading', 'paused'].includes(job.status)) {
            job.status = 'cancelled';
            for (const file of job.files) if (file.status === 'queued') file.status = 'cancelled';
        }
        this.active?.abort.abort();
        await this.running;
        this.preparing = new AbortController();
        if (clear) this.jobs = [];
        this.emit();
    }
}
