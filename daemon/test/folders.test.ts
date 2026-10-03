import { describe, expect, test } from 'bun:test';
import { MemberRole, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';
import { createRemoteFolder, getFolderContext, listRemoteFolders, registerFolderRefresh, requireWritableFolder } from '../src/drive/folders.js';

function folder(uid: string, name: string, directRole = MemberRole.Inherited): NodeEntity {
    return { uid, name: { ok: true, value: name }, type: NodeType.Folder, directRole } as NodeEntity;
}

class Client {
    root = folder('own~root', 'My Files', MemberRole.Admin);
    nodes = new Map<string, NodeEntity>();
    hierarchies = new Map<string, NodeEntity[]>();
    children = new Map<string, string[]>();
    shares: string[] = [];
    listed: string[] = [];
    created: Array<[string, string]> = [];
    async getMyFilesRootFolder() { return this.root; }
    async getNodeHierarchy(uid: string) {
        const hierarchy = this.hierarchies.get(uid);
        if (!hierarchy) throw new Error('No access');
        return hierarchy;
    }
    async *iterateFolderChildrenNodeUids(uid: string) {
        this.listed.push(uid);
        yield* this.children.get(uid) ?? [];
    }
    async *iterateSharedWithMeNodeUids() { yield* this.shares; }
    async *iterateNodes(uids: string[]) {
        for (const uid of uids) yield this.nodes.get(uid)
            ?? [...this.hierarchies.values()].flat().find(node => node.uid === uid)
            ?? { missingUid: uid };
    }
    async createFolder(parent: string, name: string) {
        this.created.push([parent, name]);
        return folder('new~folder', name);
    }
    sdk() { return this as unknown as ProtonDriveClient; }
}

describe('shared folder browsing', () => {
    test('lists accepted shares after own folders, filters unusable nodes, and does not walk descendants', async () => {
        const client = new Client();
        const zulu = folder('own~z', 'Zulu');
        const alpha = folder('own~a', 'Alpha');
        const trips = folder('shared~trips', 'Trips', MemberRole.Editor);
        const archive = folder('other~archive', 'Archive', MemberRole.Viewer);
        const file = { ...folder('shared~file', 'File'), type: NodeType.File };
        const trashed = { ...folder('shared~trash', 'Trash'), trashTime: new Date() };
        const broken = { ...folder('shared~broken', 'Broken'), name: { ok: false, error: new Error('decrypt') } } as NodeEntity;
        for (const node of [zulu, alpha, trips, archive, file, trashed, broken]) client.nodes.set(node.uid, node);
        client.children.set(client.root.uid, [zulu.uid, alpha.uid]);
        client.children.set(trips.uid, ['shared~summer']);
        client.hierarchies.set(trips.uid, [trips]);
        client.hierarchies.set(archive.uid, [archive]);
        client.shares = [trips.uid, file.uid, 'missing', archive.uid, trips.uid, trashed.uid, broken.uid];
        const rows = await listRemoteFolders(client.sdk(), '');
        expect(rows.map(row => row.name)).toEqual(['Alpha', 'Zulu', 'Archive', 'Trips']);
        expect(rows[0]).toMatchObject({ path: '/Alpha', sharedWithMe: false, canWrite: true });
        expect(rows[2]).toMatchObject({ path: '/Shared with me/Archive', sharedWithMe: true, canWrite: false });
        expect(rows[3]).toMatchObject({ path: '/Shared with me/Trips', sharedWithMe: true, canWrite: true, hasChildren: true });
        expect(client.listed).toEqual([client.root.uid, zulu.uid, alpha.uid, trips.uid, archive.uid]);
    });

    test('keeps the shared root in descendant paths and inherits editing access', async () => {
        const client = new Client();
        const trips = folder('shared~trips', 'Trips', MemberRole.Editor);
        const summer = folder('shared~summer', 'Summer');
        client.hierarchies.set(trips.uid, [trips]);
        client.hierarchies.set(summer.uid, [trips, summer]);
        client.nodes.set(summer.uid, summer);
        client.children.set(trips.uid, [summer.uid]);
        const [row] = await listRemoteFolders(client.sdk(), trips.uid);
        expect(row).toMatchObject({ path: '/Shared with me/Trips/Summer', sharedWithMe: true, canWrite: true });
        expect((await getFolderContext(client.sdk(), summer.uid)).path).toBe(row.path);
        expect(client.listed).toEqual([trips.uid, summer.uid]);
    });

    test('uses the highest ancestor role and refuses viewer-only folders', async () => {
        const client = new Client();
        const viewer = folder('shared~view', 'View', MemberRole.Viewer);
        const child = folder('shared~child', 'Child');
        client.hierarchies.set(child.uid, [viewer, child]);
        await expect(requireWritableFolder(client.sdk(), child.uid)).rejects.toThrow('read-only');
        child.directRole = MemberRole.Editor;
        expect((await requireWritableFolder(client.sdk(), child.uid)).canWrite).toBe(true);
        viewer.directRole = MemberRole.Editor;
        child.directRole = MemberRole.Viewer;
        expect((await requireWritableFolder(client.sdk(), child.uid)).canWrite).toBe(true);
    });

    test('accepted nested shares keep accessible ancestors and their highest role', async () => {
        const client = new Client();
        const trips = folder('shared~trips', 'Trips', MemberRole.Editor);
        const summer = folder('shared~summer', 'Summer', MemberRole.Viewer);
        client.nodes.set(summer.uid, summer);
        client.hierarchies.set(summer.uid, [trips, summer]);
        client.shares = [summer.uid];
        expect(await listRemoteFolders(client.sdk(), '')).toMatchObject([
            { name: 'Summer', path: '/Shared with me/Trips/Summer', canWrite: true },
        ]);
    });

    test('invalidates cached editor metadata before checking a remote permission downgrade', async () => {
        const client = new Client();
        const cached = folder('shared~trips', 'Trips', MemberRole.Editor);
        client.hierarchies.set(cached.uid, [cached]);
        let invalidated: string[] = [];
        registerFolderRefresh(client.sdk(), async uids => {
            invalidated = uids;
            client.hierarchies.set(cached.uid, [{ ...cached, directRole: MemberRole.Viewer }]);
        });
        await expect(requireWritableFolder(client.sdk(), cached.uid)).rejects.toThrow('read-only');
        expect(invalidated).toEqual([cached.uid]);
    });

    test('a separately shared child still opens after its cached parent becomes inaccessible', async () => {
        const client = new Client();
        const summer = folder('shared~summer', 'Summer', MemberRole.Editor);
        let staleParent = true;
        client.getNodeHierarchy = async () => {
            if (staleParent) throw new Error('Cached parent share is no longer accessible');
            return [summer];
        };
        registerFolderRefresh(client.sdk(), async uids => {
            expect(uids).toEqual([summer.uid]);
            staleParent = false;
        });
        expect(await requireWritableFolder(client.sdk(), summer.uid)).toMatchObject({
            path: '/Shared with me/Summer', canWrite: true,
        });
    });

    test('restored shares are refreshed before filtering cached Trash metadata', async () => {
        const client = new Client();
        const trips = folder('shared~trips', 'Trips', MemberRole.Editor);
        trips.trashTime = new Date();
        client.nodes.set(trips.uid, trips);
        client.hierarchies.set(trips.uid, [trips]);
        client.shares = [trips.uid];
        registerFolderRefresh(client.sdk(), async () => { trips.trashTime = undefined; });
        expect(await listRemoteFolders(client.sdk(), '')).toMatchObject([
            { name: 'Trips', path: '/Shared with me/Trips', canWrite: true },
        ]);
    });

    test('creates a folder inside an editable share with the full display path', async () => {
        const client = new Client();
        const trips = folder('shared~trips', 'Trips', MemberRole.Editor);
        client.hierarchies.set(trips.uid, [trips]);
        expect(await createRemoteFolder(client.sdk(), trips.uid, 'Summer')).toMatchObject({
            path: '/Shared with me/Trips/Summer', sharedWithMe: true, canWrite: true,
        });
        expect(client.created).toEqual([[trips.uid, 'Summer']]);
        trips.directRole = MemberRole.Viewer;
        await expect(createRemoteFolder(client.sdk(), trips.uid, 'Winter')).rejects.toThrow('read-only');
        expect(client.created).toHaveLength(1);
    });

    test('rejects missing, trashed, and replaced roots without mistaking them for an empty folder', async () => {
        const client = new Client();
        await expect(requireWritableFolder(client.sdk(), 'missing')).rejects.toThrow('No access');
        const root = folder('shared~root', 'Trips', MemberRole.Editor);
        client.hierarchies.set(root.uid, [root]);
        root.trashTime = new Date();
        await expect(requireWritableFolder(client.sdk(), root.uid)).rejects.toThrow('no longer available');
        root.trashTime = undefined;
        root.type = NodeType.File;
        await expect(requireWritableFolder(client.sdk(), root.uid)).rejects.toThrow('no longer available');
    });
});
