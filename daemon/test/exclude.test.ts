import { describe, expect, test } from 'bun:test';

import { compileExcludes, filterExcluded, validatePattern } from '../src/engine/exclude.js';
import { reconcile } from '../src/engine/reconcile.js';
import type { BaseEntry, LocalItem, RemoteItem } from '../src/engine/types.js';

describe('exclusion matching', () => {
    test('a bare name excludes that folder and everything under it', () => {
        const excluded = compileExcludes(['GitHub']);
        expect(excluded('GitHub')).toBe(true);
        expect(excluded('GitHub/project')).toBe(true);
        expect(excluded('GitHub/project/src/main.ts')).toBe(true);
        expect(excluded('Notes/todo.md')).toBe(false);
        // Must not match a partial segment.
        expect(excluded('GitHubStuff')).toBe(false);
        expect(excluded('MyGitHub')).toBe(false);
    });

    test('a bare name matches at any depth', () => {
        const excluded = compileExcludes(['node_modules']);
        expect(excluded('node_modules')).toBe(true);
        expect(excluded('a/node_modules')).toBe(true);
        expect(excluded('a/b/node_modules/pkg/index.js')).toBe(true);
    });

    test('a leading slash anchors to the top of the pair', () => {
        const excluded = compileExcludes(['/GitHub']);
        expect(excluded('GitHub/x')).toBe(true);
        expect(excluded('Archive/GitHub/x')).toBe(false);
    });

    test('an interior slash anchors too, matching gitignore', () => {
        const excluded = compileExcludes(['Archive/old']);
        expect(excluded('Archive/old')).toBe(true);
        expect(excluded('Archive/old/thing.txt')).toBe(true);
        expect(excluded('x/Archive/old')).toBe(false);
    });

    test('globs stay within a segment unless doubled', () => {
        const single = compileExcludes(['*.iso']);
        expect(single('disk.iso')).toBe(true);
        expect(single('images/disk.iso')).toBe(true);
        expect(single('disk.iso.txt')).toBe(false);

        const double = compileExcludes(['**/cache']);
        expect(double('cache')).toBe(true);
        expect(double('a/b/cache')).toBe(true);
        expect(double('a/b/cache/file')).toBe(true);
    });

    test('trailing slashes and comments are tolerated', () => {
        const excluded = compileExcludes(['build/', '# a comment', '', '   ']);
        expect(excluded('build')).toBe(true);
        expect(excluded('build/out.o')).toBe(true);
        expect(excluded('src/main.ts')).toBe(false);
    });

    test('no patterns excludes nothing', () => {
        const excluded = compileExcludes([]);
        expect(excluded('anything/at/all')).toBe(false);
    });

    test('validation rejects what it cannot honour', () => {
        expect(validatePattern('!keep-me')).toMatch(/Negated/);
        expect(validatePattern('..\\/escape')).toBeTruthy();
        expect(validatePattern('../outside')).toMatch(/cannot escape/);
        expect(validatePattern('GitHub')).toBeNull();
        expect(validatePattern('# note')).toBeNull();
        expect(validatePattern('')).toBeNull();
    });
});

describe('excluding never deletes', () => {
    // The dangerous case: a folder was synced, then excluded. If the exclusion
    // is applied to the local scan but not to the base and remote, the
    // reconciler sees the files as locally deleted and trashes them on Drive.
    const base = new Map<string, BaseEntry>([
        [
            'GitHub/repo/file.ts',
            {
                path: 'GitHub/repo/file.ts',
                type: 'file',
                localMtime: 1000,
                localSize: 10,
                localInode: 1,
                localDevice: 100,
                localHash: 'aaa',
                remoteUid: 'vol~gh',
                remoteRevisionUid: 'rev1',
                remoteHash: 'aaa',
                remoteSize: 10,
                remoteMtime: 1000,
            },
        ],
    ]);
    const remote = new Map<string, RemoteItem>([
        [
            'GitHub/repo/file.ts',
            {
                path: 'GitHub/repo/file.ts',
                type: 'file',
                uid: 'vol~gh',
                parentUid: null,
                revisionUid: 'rev1',
                hash: 'aaa',
                size: 10,
                mtime: 1000,
                trashed: false,
            },
        ],
    ]);
    const local = new Map<string, LocalItem>();

    test('filtering only the local side would trash the remote copy', () => {
        // Demonstrates why filterExcluded must be applied to all three maps.
        const plan = reconcile({ base, local, remote, now: 0 });
        expect(plan.actions.some((a) => a.kind === 'trashRemote')).toBe(true);
    });

    test('filtering all three maps produces no actions at all', () => {
        const isExcluded = compileExcludes(['GitHub']);
        const plan = reconcile({
            base: filterExcluded(base, isExcluded),
            local: filterExcluded(local, isExcluded),
            remote: filterExcluded(remote, isExcluded),
            now: 0,
        });
        expect(plan.actions).toEqual([]);
        expect(plan.conflicts).toEqual([]);
    });
});
