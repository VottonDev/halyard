import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import exifr from 'exifr';
import type { ProtonDrivePhotosClient } from '@protontech/drive-sdk/dist/protonDrivePhotosClient.js';
import type { UploadController } from '@protontech/drive-sdk';

export type UploadClient = Pick<ProtonDrivePhotosClient, 'getFileUploader' | 'findPhotoDuplicates'>;
export type UploadInput = { path: string; thumbnails: Array<{ type: number; data: string }> };
type UploadFile = { uid: string; name: string; path: string; size: number; bytesDone: number;
    status: 'queued' | 'uploading' | 'completed' | 'skipped' | 'failed' | 'cancelled'; error: string | null };
export type PhotoUpload = { id: string; destination: string; createdAt: number;
    status: 'queued' | 'uploading' | 'paused' | 'completed' | 'failed' | 'cancelled'; files: UploadFile[] };
type Source = { input: UploadInput; device: number; inode: number; mtime: number; mediaType: string };

/** Supported still images. Inspect bytes rather than trusting the extension. */
function imageMediaType(bytes: Uint8Array): string {
    const b = Buffer.from(bytes);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    throw new Error('Choose JPEG, PNG or WebP images to upload.');
}

export class PhotoUploads {
    private jobs: PhotoUpload[] = [];
    private sources = new Map<string, Source[]>();
    private running?: Promise<void>;
    private active?: { job: PhotoUpload; abort: AbortController; controller?: UploadController };
    private lifetime = new AbortController();
    private timer?: ReturnType<typeof setTimeout>;
    private readonly getClient: () => Promise<UploadClient>;
    private readonly changed: (jobs: PhotoUpload[]) => void;
    private readonly uploaded: (uid: string) => Promise<void>;
    private readonly notify: (failed: boolean, title: string, body: string) => void;
    private readonly home: string;
    constructor(getClient: () => Promise<UploadClient>, changed: (jobs: PhotoUpload[]) => void = () => {},
        uploaded: (uid: string) => Promise<void> = async () => {},
        notify: (failed: boolean, title: string, body: string) => void = () => {}, home = os.homedir()) {
        this.getClient = getClient; this.changed = changed; this.uploaded = uploaded; this.notify = notify; this.home = home;
    }

    list(): PhotoUpload[] { return structuredClone(this.jobs); }

    async start(inputs: UploadInput[]): Promise<PhotoUpload> {
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error('Choose between 1 and 20 images to upload.');
        const signal = this.lifetime.signal;
        const home = await fsp.realpath(this.home);
        const sources: Source[] = [], files: UploadFile[] = [];
        const seen = new Set<string>();
        let thumbnailBytes = 0;
        for (const input of inputs) {
            if (!input || typeof input.path !== 'string' || !path.isAbsolute(input.path)) throw new Error('Choose images in your home directory.');
            const real = await fsp.realpath(input.path);
            if (!real.startsWith(home + path.sep)) throw new Error('Choose images in your home directory.');
            if (seen.has(real)) continue;
            seen.add(real);
            if (!Array.isArray(input.thumbnails) || input.thumbnails.length !== 2 || ![1,2].every(type => input.thumbnails.some(t => t.type === type))) {
                throw new Error('Could not prepare previews for this image. Choose it again.');
            }
            for (const thumb of input.thumbnails) {
                if (typeof thumb.data !== 'string' || thumb.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(thumb.data)) throw new Error('The image preview is invalid.');
                const bytes = Buffer.from(thumb.data, 'base64');
                if (imageMediaType(bytes) !== 'image/jpeg') throw new Error('The image preview is invalid.');
                thumbnailBytes += bytes.length;
            }
            if (thumbnailBytes > 24 * 1024 * 1024) throw new Error('Choose fewer images to upload at once.');
            const handle = await fsp.open(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size <= 0) throw new Error('Choose a non-empty image file.');
                const header = Buffer.alloc(16); await handle.read(header, 0, header.length, 0);
                const mediaType = imageMediaType(header);
                sources.push({ input: { path: real, thumbnails: input.thumbnails }, device: stat.dev, inode: stat.ino, mtime: stat.mtimeMs, mediaType });
                files.push({ uid: '', name: path.basename(real), path: real, size: stat.size, bytesDone: 0, status: 'queued', error: null });
            } finally { await handle.close(); }
        }
        signal.throwIfAborted();
        if (this.jobs.filter(j => ['queued','uploading','paused'].includes(j.status)).length >= 10) throw new Error('Finish or cancel an upload before adding another.');
        const job: PhotoUpload = { id: randomUUID(), destination: 'Proton Drive Photos', createdAt: Date.now(), status: 'queued', files };
        this.jobs.unshift(job); this.sources.set(job.id, sources);
        const evicted = this.jobs.filter((j, index) => index >= 50 && !['queued','uploading','paused'].includes(j.status));
        for (const old of evicted) this.sources.delete(old.id);
        this.jobs = this.jobs.filter(j => !evicted.includes(j));
        this.emit(); this.pump(); return structuredClone(job);
    }

    control(id: string, action: string): void {
        const job = this.jobs.find(j => j.id === id);
        if (!job) throw new Error('This photo upload is no longer available.');
        if (action === 'pause' && ['queued','uploading'].includes(job.status)) {
            job.status = 'paused'; if (this.active?.job === job) this.active.controller?.pause();
        } else if (action === 'resume' && job.status === 'paused') {
            job.status = this.active?.job === job ? 'uploading' : 'queued';
            if (this.active?.job === job) this.active.controller?.resume(); this.pump();
        } else if (action === 'cancel' && ['queued','uploading','paused'].includes(job.status)) {
            job.status = 'cancelled'; if (this.active?.job === job) this.active.abort.abort();
            for (const file of job.files) if (file.status === 'queued') file.status = 'cancelled';
        } else if (action === 'retry' && ['failed','cancelled'].includes(job.status)) {
            if (this.active?.job === job) throw new Error('Wait for the upload to stop before retrying.');
            for (const file of job.files) if (!['completed','skipped'].includes(file.status)) { file.status = 'queued'; file.bytesDone = 0; file.error = null; }
            job.status = 'queued'; this.pump();
        } else throw new Error('This action is not available for the photo upload.');
        this.emit();
    }
    private pump(): void {
        if (this.running) return;
        this.running = this.run().finally(() => { this.running = undefined; if (this.jobs.some(j => j.status === 'queued')) this.pump(); });
    }
    private state(job: PhotoUpload): PhotoUpload['status'] { return job.status; }
    private async run(): Promise<void> {
        while (true) {
            const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
            const active = { job, abort: new AbortController(), controller: undefined as UploadController | undefined };
            this.active = active; job.status = 'uploading'; this.emit();
            for (const [index, file] of job.files.entries()) {
                if (['completed','skipped'].includes(file.status)) continue;
                while (this.state(job) === 'paused' && !active.abort.signal.aborted) await new Promise<void>(resolve => setTimeout(resolve, 100));
                if (active.abort.signal.aborted || this.state(job) === 'cancelled') { file.status = 'cancelled'; continue; }
                try { await this.uploadFile(file, this.sources.get(job.id)![index], active); }
                catch (error) { file.status = active.abort.signal.aborted ? 'cancelled' : 'failed'; file.bytesDone = 0;
                    file.error = active.abort.signal.aborted ? null : error instanceof Error ? error.message : String(error); }
                active.controller = undefined; this.emit();
            }
            if (this.state(job) !== 'cancelled') {
                job.status = job.files.some(f => f.status === 'failed') ? 'failed' : 'completed';
                this.notify(job.status === 'failed', job.status === 'failed' ? 'Some photo uploads failed' : 'Photo upload complete',
                    `${job.files.filter(f => f.status === 'completed').length} images added to your gallery. Local originals were kept.`);
            }
            // Release preview bytes for completed images, preserving failed ones for retry.
            this.sources.get(job.id)?.forEach((source, i) => { if (['completed','skipped'].includes(job.files[i].status)) source.input.thumbnails = []; });
            this.active = undefined; this.emit();
        }
    }
    private async uploadFile(file: UploadFile, source: Source, active: NonNullable<PhotoUploads['active']>): Promise<void> {
        const signal = active.abort.signal;
        const handle = await fsp.open(source.input.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            const unchanged = async () => {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.dev !== source.device || stat.ino !== source.inode || stat.size !== file.size || stat.mtimeMs !== source.mtime) throw new Error('This image changed after you chose it. Choose it again.');
            };
            await unchanged(); signal.throwIfAborted();
            const client = await this.getClient(); signal.throwIfAborted();
            let sha1: string | undefined;
            const hash = async () => {
                if (!sha1) {
                    const digest = createHash('sha1');
                    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false, signal })) digest.update(chunk);
                    sha1 = digest.digest('hex'); await unchanged();
                }
                return sha1;
            };
            const duplicates = await client.findPhotoDuplicates(file.name, hash, signal);
            signal.throwIfAborted();
            if (duplicates.length) { file.uid = duplicates[0]; file.status = 'skipped'; file.bytesDone = file.size; return; }
            const expectedSha1 = await hash();
            // Read only the bounded metadata prefix from the open descriptor.
            const prefix = Buffer.alloc(Math.min(file.size, 1024 * 1024)); await handle.read(prefix, 0, prefix.length, 0);
            let captureTime = new Date(source.mtime);
            try {
                const metadata = await exifr.parse(prefix, ['DateTimeOriginal', 'CreateDate']);
                const date = metadata?.DateTimeOriginal ?? metadata?.CreateDate;
                if (date instanceof Date && Number.isFinite(date.getTime())) captureTime = date;
            } catch { /* Missing/broken EXIF uses the file modification date. */ }
            signal.throwIfAborted(); await unchanged();
            const uploader = await client.getFileUploader(file.name, { mediaType: source.mediaType, expectedSize: file.size,
                expectedSha1, modificationTime: new Date(source.mtime), captureTime }, signal);
            file.status = 'uploading';
            const input = handle.createReadStream({ start: 0, autoClose: false, signal });
            try {
                const controller = await uploader.uploadFromStream(Readable.toWeb(input) as unknown as ReadableStream,
                    source.input.thumbnails.map(t => ({ type: t.type as 1 | 2, thumbnail: new Uint8Array(Buffer.from(t.data, 'base64')) })),
                    bytes => { file.bytesDone = bytes; this.emit(false); });
                active.controller = controller;
                if (this.state(active.job) === 'paused') controller.pause();
                const result = await controller.completion();
                file.uid = result.nodeUid; file.bytesDone = file.size; file.status = 'completed'; file.error = null;
                // A gallery refresh failure does not change a successful upload into a failed transfer.
                try { await this.uploaded(result.nodeUid); } catch { /* SDK events will update the view later. */ }
            } finally { input.destroy(); }
        } finally { await handle.close(); }
    }
    private emit(immediate = true): void {
        if (immediate) { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.changed(this.list()); }
        else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.changed(this.list()); }, 250);
    }
    async stop(clear = false): Promise<void> {
        this.lifetime.abort();
        for (const job of this.jobs) if (['queued','uploading','paused'].includes(job.status)) { job.status = 'cancelled'; for (const file of job.files) if (file.status === 'queued') file.status = 'cancelled'; }
        this.active?.abort.abort(); await this.running;
        this.lifetime = new AbortController();
        if (clear) { this.jobs = []; this.sources.clear(); } this.emit();
    }
}
