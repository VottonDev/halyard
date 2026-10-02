import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhotoDownloads } from '../src/photos/downloads.js';
import { PhotoUploads, type UploadClient } from '../src/photos/uploads.js';
import type { PhotosClient } from '../src/photos/library.js';

async function until(condition: () => boolean) {
    for (let i=0; i<400; i++) { if (condition()) return; await new Promise(r=>setTimeout(r,10)); }
    throw new Error('Timed out waiting for transfer state');
}
const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);
const thumbnails=[1,2].map(type=>({type,data:jpeg.toString('base64')}));

test('Node upload streams support pause/resume and descriptor reuse for hashing', async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'halyard-node-photos-'));
    let finish:()=>void=()=>{}, paused=false, ready=false;
    const client:UploadClient={
        async findPhotoDuplicates(_name,hash){assert.equal((await hash()).length,40);return [];},
        async getFileUploader(_name,metadata){
            assert.equal(metadata.expectedSize,jpeg.length);
            return {async uploadFromStream(stream:ReadableStream){
                const reader=stream.getReader(), chunks:Buffer[]=[];
                for(;;){const next=await reader.read();if(next.done)break;chunks.push(Buffer.from(next.value));}
                assert.deepEqual(Buffer.concat(chunks),jpeg);
                const promise=new Promise<{nodeUid:string;nodeRevisionUid:string}>(resolve=>{finish=()=>resolve({nodeUid:'uploaded',nodeRevisionUid:'revision'});});
                ready=true;
                return {pause(){paused=true;},resume(){paused=false;finish();},completion:()=>promise};
            }} as any;
        },
    };
    const queue=new PhotoUploads(async()=>client,undefined,undefined,undefined,home);
    try {
        const file=path.join(home,'image.jpg');await fs.writeFile(file,jpeg);
        const job=await queue.start([{path:file,thumbnails}]);await until(()=>ready);
        queue.control(job.id,'pause');assert.equal(queue.list()[0].status,'paused');assert.equal(paused,true);
        queue.control(job.id,'resume');await until(()=>queue.list()[0].status==='completed');
        assert.deepEqual(await fs.readFile(file),jpeg);
    } finally {finish();await queue.stop();await fs.rm(home,{recursive:true,force:true});}
});

test('a file modified during preparation fails before opening an uploader',async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'halyard-node-photos-'));
    let release:(c:UploadClient)=>void=()=>{}, requested=false, uploads=0;
    const client={async findPhotoDuplicates(_name:string,hash:()=>Promise<string>){await hash();return [];},
        async getFileUploader(){uploads++;throw new Error('Must not upload changed bytes');}} as UploadClient;
    const queue=new PhotoUploads(()=>{requested=true;return new Promise(r=>{release=r;});},undefined,undefined,undefined,home);
    try {
        const file=path.join(home,'image.jpg');await fs.writeFile(file,jpeg);
        await queue.start([{path:file,thumbnails}]);await until(()=>requested);
        await fs.writeFile(file,Buffer.concat([jpeg,Buffer.from('changed')]));release(client);
        await until(()=>queue.list()[0].status==='failed');assert.equal(uploads,0);
        assert.match(queue.list()[0].files[0].error!,/changed/);
    } finally {release(client);await queue.stop();await fs.rm(home,{recursive:true,force:true});}
});

test('downloads finish when the SDK releases its writer without closing the stream',async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'halyard-node-photos-'));
    const bytes=new Uint8Array([1,2,3,4]);
    const client={async getNode(){return {uid:'photo',type:'photo',name:{ok:true,value:'original.jpg'},creationTime:new Date(),photo:{relatedPhotoNodeUids:[],tags:[]}};},
        async getFileDownloader(){return {getClaimedSizeInBytes:()=>bytes.length,downloadToStream(stream:WritableStream){
            const done=(async()=>{const writer=stream.getWriter();await writer.write(bytes);writer.releaseLock();})();
            return {pause(){},resume(){},completion:()=>done,isDownloadCompleteWithSignatureIssues:()=>false};
        }};}} as unknown as PhotosClient;
    const queue=new PhotoDownloads(async()=>client,undefined,undefined,home);
    try {
        await queue.start(['photo'],home);await until(()=>queue.list()[0].status==='completed');
        assert.deepEqual(await fs.readFile(path.join(home,'original.jpg')),Buffer.from(bytes));
        assert.deepEqual(await fs.readdir(home),['original.jpg']);
    } finally {await queue.stop();await fs.rm(home,{recursive:true,force:true});}
});

test('a signature failure removes the temporary download without publishing bytes',async()=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'halyard-node-photos-'));
    const client={async getNode(){return {uid:'photo',type:'photo',name:{ok:true,value:'original.jpg'},creationTime:new Date(),photo:{relatedPhotoNodeUids:[],tags:[]}};},
        async getFileDownloader(){return {getClaimedSizeInBytes:()=>4,downloadToStream(stream:WritableStream){
            const done=(async()=>{const writer=stream.getWriter();await writer.write(new Uint8Array([1,2,3,4]));await writer.close();})();
            return {pause(){},resume(){},completion:()=>done,isDownloadCompleteWithSignatureIssues:()=>true};
        }};}} as unknown as PhotosClient;
    const queue=new PhotoDownloads(async()=>client,undefined,undefined,home);
    try {
        await queue.start(['photo'],home);await until(()=>queue.list()[0].status==='failed');
        assert.match(queue.list()[0].files[0].error!,/verified/);assert.deepEqual(await fs.readdir(home),[]);
    } finally {await queue.stop();await fs.rm(home,{recursive:true,force:true});}
});

test('video bridge serves seek ranges without full downloads, rejects unknown capabilities and releases sessions', async()=>{
    const {PhotoVideos,videoRange}=await import('../src/photos/videos.js');
    const data=Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    let readBytes=0, fullDownloads=0;
    const client={async getNode(){return {uid:'video',type:'photo',mediaType:'video/mp4',activeRevision:{claimedSize:data.length}};},
        async getFileDownloader(){return {getSeekableStream(){let position=0;return {seek(n:number){position=n;},async read(n:number){const value=data.subarray(position,position+n);position+=value.length;readBytes+=value.length;return {value,done:position===data.length};}};},
            downloadToStream(){fullDownloads++;throw new Error('Must stream ranges');}};}} as unknown as PhotosClient;
    const videos=new PhotoVideos(async()=>client);
    try {
        const preview=await videos.start('video');
        const response=await fetch(preview.uri!,{headers:{Range:'bytes=10-14'}});
        assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),`bytes 10-14/${data.length}`);
        assert.equal(await response.text(),'abcde');assert.equal(readBytes,5);assert.equal(fullDownloads,0);
        const suffix=await fetch(preview.uri!,{headers:{Range:'bytes=-3'}});assert.equal(await suffix.text(),'xyz');
        assert.equal((await fetch(preview.uri!,{headers:{Range:'bytes=999-'}})).status,416);
        assert.equal((await fetch(preview.uri!,{headers:{Origin:'https://example.test'}})).status,403);
        const head=await fetch(preview.uri!,{method:'HEAD'});assert.equal(head.headers.get('content-length'),String(data.length));
        assert.throws(()=>videoRange('bytes=1-2,5-6',data.length));
        videos.release(preview.id);assert.equal((await fetch(preview.uri!)).status,404);
    } finally {await videos.stop();}
});
