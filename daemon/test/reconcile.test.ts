import { describe, expect, test } from 'bun:test';

import { conflictName, reconcile } from '../src/engine/reconcile.js';
import type { Action, BaseEntry, LocalItem, RemoteItem } from '../src/engine/types.js';

const NOW = Date.parse('2026-07-19T12:00:00Z');

function baseFile(path: string, overrides: Partial<BaseEntry> = {}): BaseEntry {
    return {
        path,
        type: 'file',
        localMtime: 1000,
        localSize: 10,
        localInode: 1,
        localDevice: 100,
        localHash: 'aaa',
        remoteUid: `vol~${path}`,
        remoteRevisionUid: 'rev1',
        remoteHash: 'aaa',
        remoteSize: 10,
        remoteMtime: 1000,
        ...overrides,
    };
}

function localFile(path: string, overrides: Partial<LocalItem> = {}): LocalItem {
    return { path, type: 'file', mtime: 1000, size: 10, inode: 1, device: 100, hash: 'aaa', ...overrides };
}

function remoteFile(path: string, overrides: Partial<RemoteItem> = {}): RemoteItem {
    return {
        path,
        type: 'file',
        uid: `vol~${path}`,
        parentUid: null,
        revisionUid: 'rev1',
        hash: 'aaa',
        size: 10,
        mtime: 1000,
        trashed: false,
        ...overrides,
    };
}

function run(
    base: BaseEntry[],
    local: LocalItem[],
    remote: RemoteItem[],
): { actions: Action[]; kinds: string[]; conflicts: ReturnType<typeof reconcile>['conflicts'] } {
    const plan = reconcile({
        base: new Map(base.map((entry) => [entry.path, entry])),
        local: new Map(local.map((item) => [item.path, item])),
        remote: new Map(remote.map((item) => [item.path, item])),
        now: NOW,
    });
    return { actions: plan.actions, kinds: plan.actions.map((a) => a.kind), conflicts: plan.conflicts };
}

describe('steady state', () => {
    test('does nothing when both sides match the base', () => {
        const { actions } = run([baseFile('a.txt')], [localFile('a.txt')], [remoteFile('a.txt')]);
        expect(actions).toEqual([]);
    });

    test('adopts a new timestamp without transferring when content is identical', () => {
        const { kinds } = run(
            [baseFile('a.txt')],
            [localFile('a.txt', { mtime: 9999 })],
            [remoteFile('a.txt')],
        );
        expect(kinds).toEqual(['refreshBase']);
    });
});

describe('one-sided changes', () => {
    test('uploads a new local file', () => {
        const { actions } = run([], [localFile('new.txt')], []);
        expect(actions).toEqual([{ kind: 'upload', path: 'new.txt', existingRemoteUid: null }]);
    });

    test('downloads a new remote file', () => {
        const { actions } = run([], [], [remoteFile('new.txt')]);
        expect(actions).toEqual([
            { kind: 'download', path: 'new.txt', remoteUid: 'vol~new.txt', revisionUid: 'rev1' },
        ]);
    });

    test('uploads a local edit as a new revision of the existing node', () => {
        const { actions } = run(
            [baseFile('a.txt')],
            [localFile('a.txt', { size: 20, hash: 'bbb' })],
            [remoteFile('a.txt')],
        );
        expect(actions).toEqual([{ kind: 'upload', path: 'a.txt', existingRemoteUid: 'vol~a.txt' }]);
    });

    test('downloads a remote edit, detected by revision uid', () => {
        const { actions } = run(
            [baseFile('a.txt')],
            [localFile('a.txt')],
            [remoteFile('a.txt', { revisionUid: 'rev2', hash: 'bbb' })],
        );
        expect(actions).toEqual([
            { kind: 'download', path: 'a.txt', remoteUid: 'vol~a.txt', revisionUid: 'rev2' },
        ]);
    });
});

describe('deletions', () => {
    test('local deletion trashes the remote node', () => {
        const { kinds } = run([baseFile('a.txt')], [], [remoteFile('a.txt')]);
        expect(kinds).toEqual(['trashRemote', 'dropBase']);
    });

    test('remote deletion is applied locally — Proton Drive keeps its own Trash', () => {
        const { actions } = run([baseFile('a.txt')], [localFile('a.txt')], []);
        expect(actions[0]).toEqual({ kind: 'deleteLocal', path: 'a.txt', type: 'file' });
    });

    test('a file gone from both sides just leaves the base', () => {
        const { kinds } = run([baseFile('a.txt')], [], []);
        expect(kinds).toEqual(['dropBase']);
    });
});

describe('conflicts — never lose data', () => {
    test('both modified keeps both copies and uploads the preserved one', () => {
        const { actions, conflicts } = run(
            [baseFile('a.txt')],
            [localFile('a.txt', { size: 20, hash: 'local' })],
            [remoteFile('a.txt', { revisionUid: 'rev2', hash: 'remote' })],
        );

        const kept = 'a (conflict 2026-07-19).txt';
        expect(actions).toEqual([
            { kind: 'moveLocal', from: 'a.txt', to: kept },
            { kind: 'download', path: 'a.txt', remoteUid: 'vol~a.txt', revisionUid: 'rev2' },
            { kind: 'upload', path: kept, existingRemoteUid: null },
        ]);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toMatchObject({ path: 'a.txt', kind: 'bothModified', keptCopyPath: kept });
    });

    test('both sides edited to identical content is not a conflict', () => {
        const { kinds, conflicts } = run(
            [baseFile('a.txt')],
            [localFile('a.txt', { size: 20, hash: 'same' })],
            [remoteFile('a.txt', { revisionUid: 'rev2', hash: 'same', size: 20 })],
        );
        expect(kinds).toEqual(['refreshBase']);
        expect(conflicts).toEqual([]);
    });

    test('an edit beats a deletion — local delete vs remote edit restores the file', () => {
        const { actions, conflicts } = run(
            [baseFile('a.txt')],
            [],
            [remoteFile('a.txt', { revisionUid: 'rev2', hash: 'bbb' })],
        );
        expect(actions).toEqual([
            { kind: 'download', path: 'a.txt', remoteUid: 'vol~a.txt', revisionUid: 'rev2' },
        ]);
        expect(conflicts[0]?.kind).toBe('localDeletedRemoteModified');
    });

    test('an edit beats a deletion — remote delete vs local edit re-uploads the file', () => {
        const { actions, conflicts } = run(
            [baseFile('a.txt')],
            [localFile('a.txt', { size: 20, hash: 'bbb' })],
            [],
        );
        expect(actions).toEqual([{ kind: 'upload', path: 'a.txt', existingRemoteUid: null }]);
        expect(conflicts[0]?.kind).toBe('remoteDeletedLocalModified');
    });

    test('conflict naming keeps the extension and handles dotfiles', () => {
        expect(conflictName('dir/notes.md', NOW)).toBe('dir/notes (conflict 2026-07-19).md');
        expect(conflictName('README', NOW)).toBe('README (conflict 2026-07-19)');
        expect(conflictName('.bashrc', NOW)).toBe('.bashrc (conflict 2026-07-19)');
        expect(conflictName('a.tar.gz', NOW)).toBe('a.tar (conflict 2026-07-19).gz');
    });
});

describe('moves are detected, not re-transferred', () => {
    test('a remote rename becomes a local rename', () => {
        const { actions } = run(
            [baseFile('old.txt', { remoteUid: 'vol~x' })],
            [localFile('old.txt')],
            [remoteFile('new.txt', { uid: 'vol~x' })],
        );
        expect(actions).toContainEqual({ kind: 'moveLocal', from: 'old.txt', to: 'new.txt' });
        expect(actions.some((a) => a.kind === 'download' || a.kind === 'upload')).toBe(false);
    });

    test('does not mistake a btrfs inode collision for a rename', () => {
        // Inode numbers are unique per filesystem — and on btrfs, only per
        // *subvolume*. A synced folder spanning two subvolumes can hold two
        // unrelated files sharing an inode number. Keying moves on the inode
        // alone would rename the wrong file on Drive and delete the other.
        const { actions } = run(
            [baseFile('gone.txt', { localInode: 7, localDevice: 100 })],
            // Same inode number, different subvolume: a different file entirely.
            [localFile('unrelated.txt', { inode: 7, device: 200, hash: 'different' })],
            [remoteFile('gone.txt')],
        );

        expect(actions.some((a) => a.kind === 'moveRemote')).toBe(false);
        expect(actions).toContainEqual({ kind: 'upload', path: 'unrelated.txt', existingRemoteUid: null });
        expect(actions).toContainEqual({ kind: 'trashRemote', path: 'gone.txt', remoteUid: 'vol~gone.txt' });
    });

    test('still detects a real rename within one subvolume', () => {
        const { actions } = run(
            [baseFile('old.txt', { localInode: 42, localDevice: 100 })],
            [localFile('new.txt', { inode: 42, device: 100 })],
            [remoteFile('old.txt')],
        );
        expect(actions).toContainEqual({
            kind: 'moveRemote',
            from: 'old.txt',
            to: 'new.txt',
            remoteUid: 'vol~old.txt',
        });
    });

    test('a local rename becomes a remote rename, matched by inode', () => {
        const { actions } = run(
            [baseFile('old.txt', { localInode: 42 })],
            [localFile('new.txt', { inode: 42 })],
            [remoteFile('old.txt')],
        );
        expect(actions).toContainEqual({
            kind: 'moveRemote',
            from: 'old.txt',
            to: 'new.txt',
            remoteUid: 'vol~old.txt',
        });
        expect(actions.some((a) => a.kind === 'download' || a.kind === 'upload')).toBe(false);
    });
});

describe('a moved folder is carried by one directory rename', () => {
    const localFolder = (path: string, inode: number): LocalItem => ({
        path,
        type: 'folder',
        mtime: 0,
        size: 0,
        inode,
        device: 100,
    });
    const remoteFolder = (path: string, uid: string): RemoteItem => ({
        path,
        type: 'folder',
        uid,
        parentUid: null,
        revisionUid: null,
        hash: null,
        size: 0,
        mtime: 0,
        trashed: false,
    });

    test('a remote folder move emits a single move and rebases its descendants', () => {
        // On Drive, folder A (holding file.txt) was moved into the existing
        // folder B: A -> B/A and A/file.txt -> B/A/file.txt. Uids are stable
        // across the move; only the paths change.
        const base = new Map<string, BaseEntry>([
            ['B', baseFile('B', { type: 'folder', remoteUid: 'uidB', localInode: 2 })],
            ['A', baseFile('A', { type: 'folder', remoteUid: 'uidA', localInode: 3 })],
            ['A/file.txt', baseFile('A/file.txt', { remoteUid: 'uidFile', localInode: 4 })],
        ]);
        const local = new Map<string, LocalItem>([
            ['B', localFolder('B', 2)],
            ['A', localFolder('A', 3)],
            ['A/file.txt', localFile('A/file.txt', { inode: 4 })],
        ]);
        const remote = new Map<string, RemoteItem>([
            ['B', remoteFolder('B', 'uidB')],
            ['B/A', remoteFolder('B/A', 'uidA')],
            ['B/A/file.txt', remoteFile('B/A/file.txt', { uid: 'uidFile' })],
        ]);

        const plan = reconcile({ base, local, remote, now: NOW });

        // Exactly one move — the folder itself. The descendant is not moved
        // separately: renaming the directory already relocated it, and a second
        // move would only fail with ENOENT and log a bogus failure.
        const moves = plan.actions.filter((a) => a.kind === 'moveLocal' || a.kind === 'moveRemote');
        expect(moves).toEqual([{ kind: 'moveLocal', from: 'A', to: 'B/A' }]);

        // Nothing is re-transferred.
        expect(plan.actions.some((a) => a.kind === 'download' || a.kind === 'upload')).toBe(false);

        // The base is rewritten in place to the new paths, so the next cycle
        // reads agreement rather than dropping and re-hashing each descendant.
        expect(base.has('A')).toBe(false);
        expect(base.has('A/file.txt')).toBe(false);
        expect(base.get('B/A')?.remoteUid).toBe('uidA');
        expect(base.get('B/A/file.txt')?.remoteUid).toBe('uidFile');
    });
});

describe('folders', () => {
    const folder = (path: string): LocalItem => ({ path, type: 'folder', mtime: 0, size: 0, inode: 9, device: 100 });
    const remoteFolder = (path: string): RemoteItem => ({
        path,
        type: 'folder',
        uid: `vol~${path}`,
        parentUid: null,
        revisionUid: null,
        hash: null,
        size: 0,
        mtime: 0,
        trashed: false,
    });

    test('creates parents before children', () => {
        const { actions } = run([], [], [remoteFolder('a'), remoteFolder('a/b'), remoteFile('a/b/c.txt')]);
        const paths = actions.map((a) => ('path' in a ? a.path : ''));
        expect(paths.indexOf('a')).toBeLessThan(paths.indexOf('a/b'));
        expect(paths.indexOf('a/b')).toBeLessThan(paths.indexOf('a/b/c.txt'));
    });

    test('deletes children before parents', () => {
        const { actions } = run(
            [
                baseFile('a', { type: 'folder', remoteUid: 'vol~a' }),
                baseFile('a/c.txt', { remoteUid: 'vol~a/c.txt' }),
            ],
            [],
            [remoteFolder('a'), remoteFile('a/c.txt')],
        );
        const trashes = actions.filter((a) => a.kind === 'trashRemote').map((a) => ('path' in a ? a.path : ''));
        expect(trashes).toEqual(['a/c.txt', 'a']);
    });

    test('does not delete a folder locally when it holds unseen remote work', () => {
        // Folder deleted locally, but a new file appeared inside it remotely.
        const { actions } = run(
            [baseFile('a', { type: 'folder', remoteUid: 'vol~a' })],
            [],
            [remoteFolder('a'), remoteFile('a/new.txt')],
        );
        expect(actions.some((a) => a.kind === 'trashRemote')).toBe(false);
        expect(actions).toContainEqual({ kind: 'createLocalFolder', path: 'a' });
    });

    test('does not delete a folder remotely when it holds unsynced local work', () => {
        const { actions } = run(
            [baseFile('a', { type: 'folder', remoteUid: 'vol~a' })],
            [folder('a'), localFile('a/new.txt')],
            [],
        );
        expect(actions.some((a) => a.kind === 'deleteLocal')).toBe(false);
        expect(actions).toContainEqual({ kind: 'createRemoteFolder', path: 'a' });
    });
});
