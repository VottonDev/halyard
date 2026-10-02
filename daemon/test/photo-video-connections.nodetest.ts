import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PhotoVideos } from '../src/photos/videos.js';
import type { PhotosClient } from '../src/photos/library.js';

// GStreamer opens an unbounded request, reads a little, and closes it to
// seek elsewhere. A shared SDK read can outlive several of those requests.
test('disconnected open-ended video probes release connection slots while an SDK read is pending', async () => {
    const chunkSize = 1024 * 1024;
    let finishRead: () => void = () => {};
    let markReading: () => void = () => {};
    const pendingRead = new Promise<void>(resolve => { finishRead = resolve; });
    const reading = new Promise<void>(resolve => { markReading = resolve; });
    let blockedReads = 0;
    const client = {
        async getNode() {
            return { uid: 'video', type: 'photo', mediaType: 'video/mp4',
                activeRevision: { claimedSize: 8 * chunkSize } };
        },
        async getFileDownloader() {
            let position = 0;
            return { getSeekableStream() {
                return {
                    seek(offset: number) { position = offset; },
                    async read(length: number) {
                        if (position >= chunkSize) {
                            blockedReads++;
                            markReading();
                            await pendingRead;
                        }
                        position += length;
                        return { value: Buffer.alloc(length, 7), done: false };
                    },
                };
            } };
        },
    } as unknown as PhotosClient;
    const videos = new PhotoVideos(async () => client);
    try {
        const preview = await videos.start('video');
        await (await fetch(preview.uri!, { headers: { Range: 'bytes=0-31' } })).arrayBuffer();
        const controller = new AbortController();
        const slow = fetch(preview.uri!, {
            headers: { Range: `bytes=${chunkSize}-` }, signal: controller.signal,
        });
        const cancelled = assert.rejects(slow, { name: 'AbortError' });
        await reading;
        controller.abort();
        await cancelled;

        for (let index = 0; index < 6; index++) {
            // Let the peer observe the prior socket close before opening the
            // next probe. The SDK read stays blocked throughout the sequence.
            await new Promise(resolve => setTimeout(resolve, 20));
            const status = await new Promise<number | undefined>((resolve, reject) => {
                const request = http.get(preview.uri!, response => {
                    if (response.statusCode !== 200) {
                        response.resume();
                        resolve(response.statusCode);
                        return;
                    }
                    response.once('data', () => {
                        response.destroy();
                        resolve(response.statusCode);
                    });
                    response.once('error', reject);
                });
                request.once('error', reject);
                request.setTimeout(2000, () => request.destroy(new Error('Video probe timed out')));
            });
            assert.equal(status, 200, `Disconnected probes must not reject probe ${index + 1}`);
        }
        assert.equal(blockedReads, 1, 'Disconnected probes must share the outstanding SDK read');
    } finally {
        finishRead();
        await videos.stop();
    }
});
