/**
 * Performs Drive operations directly, standing in for "another device".
 *
 * The daemon can only ever produce local-side changes during a test. To
 * exercise the remote-change paths — a file deleted elsewhere, a file edited
 * elsewhere — something has to modify Drive out of band. That is this tool.
 *
 *   remoteop ls        <folder> [subpath]
 *   remoteop trash     <folder> <subpath>
 *   remoteop putrev    <folder> <subpath> <localFile>
 *
 * `folder` is a top-level Drive folder name; `subpath` is relative to it.
 */
import { NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

import { createSecretStore } from '../auth/keyring.js';
import { DriveSession } from '../drive/session.js';

import * as dbus from 'dbus-next';

async function childNamed(client: ProtonDriveClient, parentUid: string, name: string): Promise<NodeEntity | null> {
    const uids: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(parentUid)) {
        uids.push(uid);
    }
    for await (const node of client.iterateNodes(uids)) {
        if ('missingUid' in node || node.trashTime) {
            continue;
        }
        if (node.name.ok && node.name.value === name) {
            return node;
        }
    }
    return null;
}

async function resolve(client: ProtonDriveClient, folder: string, subpath: string): Promise<NodeEntity> {
    const root = await client.getMyFilesRootFolder();
    const top = await childNamed(client, root.uid, folder);
    if (!top) {
        throw new Error(`No such Drive folder: /${folder}`);
    }
    let current = top;
    for (const segment of subpath.split('/').filter(Boolean)) {
        const next = await childNamed(client, current.uid, segment);
        if (!next) {
            throw new Error(`No such path: /${folder}/${subpath}`);
        }
        current = next;
    }
    return current;
}

async function main(): Promise<void> {
    const [command, folder, ...rest] = process.argv.slice(2);
    if (!command || !folder) {
        console.error('usage: remoteop <ls|trash|putrev> <folder> [subpath] [localFile]');
        process.exit(2);
    }

    const bus = dbus.sessionBus();
    const store = await createSecretStore(bus);
    const session = await DriveSession.create(store);
    if (!session.isLoggedIn()) {
        throw new Error('Not signed in');
    }
    const client = session.getClient();

    if (command === 'ls') {
        const node = await resolve(client, folder, rest[0] ?? '');
        const uids: string[] = [];
        for await (const uid of client.iterateFolderChildrenNodeUids(node.uid)) {
            uids.push(uid);
        }
        const rows: string[] = [];
        for await (const child of client.iterateNodes(uids)) {
            if ('missingUid' in child || child.trashTime) {
                continue;
            }
            const name = child.name.ok ? child.name.value : '<undecryptable>';
            const revision = child.activeRevision?.ok ? child.activeRevision.value : undefined;
            rows.push(
                `${child.type === NodeType.Folder ? 'd' : '-'} ${String(revision?.claimedSize ?? 0).padStart(9)} ` +
                    `${revision?.claimedDigests?.sha1?.slice(0, 12) ?? '-'.padEnd(12)} ${name}`,
            );
        }
        console.log(rows.sort().join('\n') || '(empty)');
    } else if (command === 'trash') {
        const node = await resolve(client, folder, rest[0] ?? '');
        for await (const result of client.trashNodes([node.uid])) {
            if (!result.ok) {
                throw result.error;
            }
        }
        console.log(`trashed /${folder}/${rest[0]}`);
    } else if (command === 'putrev') {
        const [subpath, localFile] = rest;
        const node = await resolve(client, folder, subpath);
        const stats = await fsp.stat(localFile);
        const hash = createHash('sha1').update(await fsp.readFile(localFile)).digest('hex');

        const uploader = await client.getFileRevisionUploader(node.uid, {
            mediaType: 'application/octet-stream',
            expectedSize: stats.size,
            expectedSha1: hash,
            modificationTime: new Date(),
        });
        const controller = await uploader.uploadFromStream(
            Readable.toWeb(fs.createReadStream(localFile)) as unknown as ReadableStream,
            [],
        );
        const uploaded = await controller.completion();
        console.log(`uploaded new revision of /${folder}/${subpath} (${uploaded.nodeRevisionUid})`);
    } else {
        throw new Error(`Unknown command: ${command}`);
    }

    bus.disconnect();
    process.exit(0);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
