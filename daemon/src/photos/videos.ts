import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PhotosClient } from './library.js';

export type VideoPreview = { id: string; uid: string; status: 'ready' | 'failed'; uri: string | null; size: number; error: string | null };
type VideoStream = ReturnType<Awaited<ReturnType<PhotosClient['getFileDownloader']>>['getSeekableStream']>;
type Entry = { preview: VideoPreview; token: string; abort: AbortController; touched: number; requests: number; mediaType: string; client: PhotosClient;
    stream?: VideoStream; reading: Promise<void>; cache: Map<number, Uint8Array> };
const VIDEO_CHUNK_BYTES = 1024 * 1024;
const VIDEO_CACHE_CHUNKS = 16;

export function videoRange(range: string | undefined, size: number): { start: number; end: number; partial: boolean } {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Video size is unavailable.');
    if (!range) return { start:0, end:size-1, partial:false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) throw new Error('Invalid byte range.');
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) <= 0)) throw new Error('Invalid byte range.');
    return { start, end, partial:true };
}

/** A loopback range bridge for GTK. Decrypted media stays in memory. */
export class PhotoVideos {
    private entries = new Map<string, Entry>();
    private server?: http.Server;
    private listening?: Promise<number>;
    private lifetime = new AbortController();
    private expiry?: ReturnType<typeof setInterval>;
    private readonly getClient: () => Promise<PhotosClient | null>;
    private readonly changed: (preview: VideoPreview) => void;
    constructor(getClient: () => Promise<PhotosClient | null>, changed: (preview: VideoPreview) => void = () => {}) {
        this.getClient=getClient; this.changed=changed;
    }
    async start(uid: string): Promise<VideoPreview> {
        if (!uid) throw new Error('Choose a video to play.');
        const signal=this.lifetime.signal;
        const client=await this.getClient(); signal.throwIfAborted();
        if (!client) throw new Error('Your photo library is no longer available.');
        const node=await client.getNode(uid); signal.throwIfAborted();
        if (node.type !== 'photo' || node.trashTime || !node.mediaType?.startsWith('video/')) throw new Error('This video is no longer available.');
        const size=node.activeRevision?.claimedSize;
        if (size == null || !Number.isSafeInteger(size) || size <= 0) throw new Error('Download this video to play it. Its size is unavailable.');
        const port=await this.listen(); signal.throwIfAborted();
        if (this.entries.size >= 4) throw new Error('Close an existing video preview before opening another.');
        const token=randomBytes(32).toString('base64url');
        const preview:VideoPreview={id:randomUUID(),uid,status:'ready',uri:`http://127.0.0.1:${port}/video/${token}`,size,error:null};
        const entry:Entry={preview,token,abort:new AbortController(),touched:Date.now(),requests:0,mediaType:node.mediaType,client,
            reading:Promise.resolve(),cache:new Map()};
        this.entries.set(preview.id,entry);
        return structuredClone(preview);
    }
    private listen(): Promise<number> {
        if (!this.listening) {
            const server=http.createServer((request,response)=>void this.serve(request,response));
            this.server=server;
            this.listening=new Promise<number>((resolve,reject)=>{
                server.once('error',reject);
                server.listen(0,'127.0.0.1',()=>{
                    const address=server.address();
                    if (!address || typeof address === 'string') {reject(new Error('Could not start video playback.'));return;}
                    server.removeListener('error',reject);
                    server.on('error',()=>{});
                    resolve(address.port);
                });
            }).catch(error=>{this.listening=undefined;server.close();throw error;});
            this.expiry=setInterval(()=>{
                for (const [id,entry] of this.entries) if (!entry.requests && Date.now()-entry.touched>15*60_000) this.release(id);
            },30_000);
            this.expiry.unref();
        }
        return this.listening!;
    }
    private async serve(request:IncomingMessage,response:ServerResponse):Promise<void> {
        const port=(this.server?.address() as {port:number}|null)?.port;
        if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin || !['GET','HEAD'].includes(request.method ?? '')) {
            response.writeHead(403);response.end();return;
        }
        const entry=[...this.entries.values()].find(e=>request.url === `/video/${e.token}`);
        if (!entry) {response.writeHead(404);response.end();return;}
        if (entry.requests >= 4) {response.writeHead(429);response.end();return;}
        let range:ReturnType<typeof videoRange>;
        try {range=videoRange(request.headers.range,entry.preview.size);}
        catch {response.writeHead(416,{'Content-Range':`bytes */${entry.preview.size}`});response.end();return;}
        entry.touched=Date.now();entry.requests++;
        const connection=new AbortController();
        const signal=AbortSignal.any([connection.signal,entry.abort.signal]);
        const abort=()=>response.destroy();
        let counted=true;
        const finished=()=>{if(counted){entry.requests--;counted=false;}};
        // Players abandon open-ended requests while probing MP4 metadata.
        // Count live connections, even if a disconnected request's shared
        // SDK read is still finishing in the background.
        const close=()=>{connection.abort();finished();};
        signal.addEventListener('abort',abort,{once:true});response.once('close',close);
        try {
            const headers:Record<string,string|number>={'Content-Type':entry.mediaType,'Accept-Ranges':'bytes',
                'Content-Length':range.end-range.start+1,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
            if(range.partial)headers['Content-Range']=`bytes ${range.start}-${range.end}/${entry.preview.size}`;
            if(request.method==='HEAD'){response.writeHead(range.partial?206:200,headers);response.end();return;}
            response.writeHead(range.partial?206:200,headers);
            let position=range.start;
            while(position<=range.end){
                const offset=Math.floor(position/VIDEO_CHUNK_BYTES)*VIDEO_CHUNK_BYTES;
                signal.throwIfAborted();const chunk=await this.readChunk(entry,offset,signal);signal.throwIfAborted();
                const within=position-offset;
                const bytes=chunk.subarray(within,Math.min(chunk.length,within+range.end-position+1));
                position+=bytes.length;entry.touched=Date.now();
                if(!response.write(bytes))await new Promise<void>((resolve,reject)=>{
                    const done=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(new Error('Video player disconnected.'));};
                    const cleanup=()=>{response.removeListener('drain',done);response.removeListener('close',closed);};
                    response.once('drain',done);response.once('close',closed);
                });
            }
            response.end();
        } catch(error){
            if(!signal.aborted){
                entry.preview.status='failed';entry.preview.error=error instanceof Error?error.message:String(error);
                this.changed(structuredClone(entry.preview));
                if(!response.headersSent){response.writeHead(502);response.end();}else response.destroy();
            }
        } finally {
            finished();entry.touched=Date.now();signal.removeEventListener('abort',abort);response.removeListener('close',close);
            connection.abort();
        }
    }
    private readChunk(entry:Entry,offset:number,signal:AbortSignal):Promise<Uint8Array> {
        // MP4 probing revisits tiny ranges in the header and tail. Reopening
        // an SDK stream for each HTTP request downloads the same encrypted
        // block again. Keep at most 16 MiB of decrypted chunks per preview,
        // and serialize cache misses because the SDK reader has one cursor.
        const fromCache=()=>{
            const cached=entry.cache.get(offset);
            if(cached){entry.cache.delete(offset);entry.cache.set(offset,cached);}
            return cached;
        };
        // A seek to cached metadata must not wait for an unrelated block that
        // the previous HTTP request was already fetching when it disconnected.
        signal.throwIfAborted();
        const ready=fromCache();if(ready)return Promise.resolve(ready);
        const read=entry.reading.then(async()=>{
            signal.throwIfAborted();
            const cached=fromCache();if(cached)return cached;
            if(!entry.stream){
                const downloader=await entry.client.getFileDownloader(entry.preview.uid,entry.abort.signal);
                try {entry.stream=downloader.getSeekableStream();}
                catch {throw new Error('This video cannot be streamed. Download the original to play it.');}
            }
            entry.abort.signal.throwIfAborted();
            await entry.stream.seek(offset);
            const length=Math.min(VIDEO_CHUNK_BYTES,entry.preview.size-offset);
            const chunk=await entry.stream.read(length);
            entry.abort.signal.throwIfAborted();
            if(chunk.value?.byteLength!==length)throw new Error('The video stream ended before the requested range.');
            // Own the allocation so a short view cannot retain a larger block.
            const bytes=new Uint8Array(chunk.value);
            entry.cache.set(offset,bytes);
            while(entry.cache.size>VIDEO_CACHE_CHUNKS)entry.cache.delete(entry.cache.keys().next().value!);
            return bytes;
        });
        entry.reading=read.then(()=>{},()=>{});
        return read;
    }
    release(id:string):void {
        const entry=this.entries.get(id);if(!entry)return;
        this.entries.delete(id);entry.abort.abort();entry.cache.clear();entry.stream=undefined;
    }
    releasePhoto(uid:string):void {for(const [id,entry]of this.entries)if(entry.preview.uid===uid)this.release(id);}
    async stop():Promise<void>{
        this.lifetime.abort();for(const id of this.entries.keys())this.release(id);
        if(this.expiry)clearInterval(this.expiry);this.expiry=undefined;
        const server=this.server;this.server=undefined;this.listening=undefined;
        if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
        this.lifetime=new AbortController();
    }
}
