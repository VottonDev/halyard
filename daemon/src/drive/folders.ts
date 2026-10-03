import { MemberRole, NodeType, type NodeEntity, type ProtonDriveClient } from '@protontech/drive-sdk';

export type RemoteFolder = {
    uid: string;
    name: string;
    path: string;
    hasChildren: boolean;
    sharedWithMe: boolean;
    canWrite: boolean;
};

type RefreshNodes = (uids: string[]) => Promise<void>;
const refreshers = new WeakMap<ProtonDriveClient, RefreshNodes>();

/** Connect access checks to the app-owned SDK metadata cache. */
export function registerFolderRefresh(client: ProtonDriveClient, refresh: RefreshNodes): void {
    refreshers.set(client, refresh);
}

/** A share's hierarchy starts at the accessible shared root, not My Files. */
export async function getFolderContext(client: ProtonDriveClient, uid: string) {
    const ownRoot = await client.getMyFilesRootFolder();
    const refresh = refreshers.get(client);
    let hierarchy: NodeEntity[];
    try {
        hierarchy = uid ? await client.getNodeHierarchy(uid) : [ownRoot];
    } catch (error) {
        if (!uid || !refresh) throw error;
        // A separately shared child can remain accessible after its parent
        // share is revoked. Its cached parent link may still lead to that
        // inaccessible parent; reload the requested node before retrying.
        await refresh([uid]);
        hierarchy = await client.getNodeHierarchy(uid);
    }
    if (hierarchy[0]?.uid !== ownRoot.uid) {
        // SDK getNode/iterateNodes both serve non-stale cached permissions.
        // Invalidate only this accessible ancestor chain, not its descendants.
        if (refresh) {
            await refresh(hierarchy.map(ancestor => ancestor.uid));
            hierarchy = await client.getNodeHierarchy(uid);
        }
    }
    const node = hierarchy.at(-1);
    if (!node || node.type !== NodeType.Folder || hierarchy.some(ancestor => ancestor.trashTime)) {
        throw new Error('This Proton Drive folder is no longer available. Sync is paused; your local files are kept.');
    }
    const sharedWithMe = hierarchy[0].uid !== ownRoot.uid;
    const names = (sharedWithMe ? hierarchy : hierarchy.slice(1))
        .map(ancestor => ancestor.name.ok ? ancestor.name.value : '?');
    const path = '/' + (sharedWithMe ? ['Shared with me', ...names] : names).join('/');
    // Roles can be inherited or set directly on descendants. The SDK defines
    // the effective role as the highest role along the accessible hierarchy.
    const canWrite = hierarchy.some(ancestor =>
        ancestor.directRole === MemberRole.Editor || ancestor.directRole === MemberRole.Admin);
    return { node, path, sharedWithMe, canWrite, hierarchy };
}

/** Two-way sync must never start treating a lost share as a remote deletion. */
export async function requireWritableFolder(client: ProtonDriveClient, uid: string) {
    const context = await getFolderContext(client, uid);
    if (!context.canWrite) {
        throw new Error('This Proton Drive folder is read-only. Two-way sync requires editing access. Your local files are kept.');
    }
    return context;
}

function childPath(parentPath: string, name: string): string {
    return `${parentPath === '/' ? '' : parentPath}/${name}`;
}

/** Peeks once, only when browsing, so the picker can show an expander. */
async function hasSubfolders(client: ProtonDriveClient, uid: string): Promise<boolean> {
    try {
        for await (const _child of client.iterateFolderChildrenNodeUids(uid, { type: NodeType.Folder })) {
            return true;
        }
    } catch {
        // A failed preview should not prevent the user from opening the row.
    }
    return false;
}

export async function listRemoteFolders(client: ProtonDriveClient, parentUid: string): Promise<RemoteFolder[]> {
    const context = await getFolderContext(client, parentUid);
    const childUids: string[] = [];
    for await (const uid of client.iterateFolderChildrenNodeUids(context.node.uid, { type: NodeType.Folder })) {
        childUids.push(uid);
    }
    const folders: RemoteFolder[] = [];
    const seen = new Set<string>();
    const append = async (node: NodeEntity, sharedWithMe: boolean, path: string, canWrite: boolean) => {
        if (seen.has(node.uid) || node.type !== NodeType.Folder || node.trashTime || !node.name.ok || !node.name.value) return;
        seen.add(node.uid);
        folders.push({ uid: node.uid, name: node.name.value, path, sharedWithMe, canWrite,
            hasChildren: await hasSubfolders(client, node.uid) });
    };
    for await (const node of client.iterateNodes(childUids)) {
        if ('missingUid' in node) continue;
        await append(node, context.sharedWithMe, childPath(context.path, node.name.ok ? node.name.value : '?'),
            context.canWrite || node.directRole === MemberRole.Editor || node.directRole === MemberRole.Admin);
    }
    // Accepted shares are a separate SDK collection. Never include them in
    // a My Files pair's tree, or browsing them would implicitly sync them all.
    if (!parentUid) {
        const sharedUids: string[] = [];
        for await (const uid of client.iterateSharedWithMeNodeUids()) sharedUids.push(uid);
        // This UID collection is fetched fresh, but node metadata is cached.
        // Refresh before filtering so a restored share or renamed folder is
        // not hidden by a stale Trash flag or failed name from an earlier visit.
        if (sharedUids.length) await refreshers.get(client)?.(sharedUids);
        for await (const node of client.iterateNodes(sharedUids)) {
            if ('missingUid' in node || node.type !== NodeType.Folder || node.trashTime || !node.name.ok || !node.name.value || seen.has(node.uid)) continue;
            const shared = await getFolderContext(client, node.uid);
            await append(shared.node, shared.sharedWithMe, shared.path, shared.canWrite);
        }
    }
    return folders.sort((a, b) => Number(a.sharedWithMe) - Number(b.sharedWithMe) || a.name.localeCompare(b.name));
}

export async function createRemoteFolder(client: ProtonDriveClient, parentUid: string, name: string): Promise<RemoteFolder> {
    const context = await requireWritableFolder(client, parentUid);
    const node = await client.createFolder(context.node.uid, name);
    return { uid: node.uid, name: node.name.ok ? node.name.value : name,
        path: childPath(context.path, node.name.ok ? node.name.value : name),
        hasChildren: false, sharedWithMe: context.sharedWithMe, canWrite: true };
}
