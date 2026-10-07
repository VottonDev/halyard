import { describe, expect, test } from 'bun:test';
import { HalyardInterface } from '../src/ipc/dbus.js';

function fixture() {
    const calls: unknown[] = [];
    let signedIn = true;
    let releaseSignOut: () => void = () => {};
    const signOut = new Promise<void>(resolve => { releaseSignOut = resolve; });
    const album = { uid: 'own~album', name: 'Summer', photoCount: 1, coverPhotoUid: null,
        sharedWithMe: false, canWrite: true, canDelete: true };
    const partial = { results: [{ uid: 'one', ok: true, error: null },
        { uid: 'two', ok: false, error: 'Permission denied' }], cancelled: true, revision: 4 };
    const photos = {
        async list(query: unknown) { calls.push(['list', query]); return { photos: [], nextCursor: null, revision: 0 }; },
        async createAlbum(name: string) { calls.push(['create', name]); return album; },
        async renameAlbum(uid: string, name: string) { calls.push(['rename', uid, name]); return { ...album, name }; },
        async deleteAlbum(uid: string) { calls.push(['delete', uid]); throw new Error('An album-only photo could not be saved.'); },
        async manage(request: unknown) { calls.push(['manage', request]); return partial; },
        cancelOperation(id: string) { calls.push(['cancel', id]); },
        reset() { calls.push(['reset']); },
    };
    const iface = new HalyardInterface({ onSignedOut() {} } as any, {
        getClient() { if (!signedIn) throw new Error('Not signed in to Proton Drive'); return {}; },
        async logout() { await signOut; signedIn = false; },
    } as any, () => {}, photos as any, { stop: async () => {} } as any,
    { stop: async () => {} } as any, { stop: async () => {} } as any,
    { stop: async () => {} } as any);
    return { iface, calls, album, partial, releaseSignOut };
}

describe('Photos management D-Bus boundary', () => {
    test('accepts year/month filters and rejects malformed dates before dispatch', async () => {
        const f = fixture();
        await f.iface.ListPhotos('{"year":"2017","month":"2017-06"}');
        expect(f.calls).toEqual([['list', { year: '2017', month: '2017-06' }]]);
        await expect(f.iface.ListPhotos('{"year":"invalid"}')).rejects.toThrow('valid year');
        await expect(f.iface.ListPhotos('{"month":"2017-13"}')).rejects.toThrow('valid month');
        expect(f.calls).toHaveLength(1);
    });
    test('round-trips capabilities, cancellation, and per-item partial results', async () => {
        const f = fixture();
        expect(JSON.parse(await f.iface.CreatePhotoAlbum('Summer'))).toEqual(f.album);
        expect(JSON.parse(await f.iface.RenamePhotoAlbum(JSON.stringify({ uid: f.album.uid, name: 'Autumn' })))).toMatchObject({ name: 'Autumn', canDelete: true });
        const request = { operationId: 'batch', action: 'favourite', uids: ['one', 'two'], favourite: true };
        expect(JSON.parse(await f.iface.ManagePhotos(JSON.stringify(request)))).toEqual(f.partial);
        f.iface.CancelPhotoOperation('batch');
        expect(f.calls.slice(-2)).toEqual([['manage', request], ['cancel', 'batch']]);
        await expect(f.iface.DeletePhotoAlbum(f.album.uid)).rejects.toThrow('could not be saved');
    });
    test('rejects malformed or oversized rename/management payloads before dispatch', async () => {
        const f = fixture();
        for (const request of ['null', '{}', '{"uid":7,"name":"New"}']) {
            await expect(f.iface.RenamePhotoAlbum(request)).rejects.toThrow('Choose an album');
        }
        await expect(f.iface.RenamePhotoAlbum('x'.repeat(4097))).rejects.toThrow('255 characters');
        await expect(f.iface.ManagePhotos('x'.repeat(128 * 1024 + 1))).rejects.toThrow('fewer photos');
        expect(f.calls).toEqual([]);
    });
    test('does not dispatch mutations when signed out or while sign-out is pending', async () => {
        const f = fixture();
        const pending = f.iface.Logout();
        await expect(f.iface.CreatePhotoAlbum('New')).rejects.toThrow('sign-out');
        await expect(f.iface.ManagePhotos('{}')).rejects.toThrow('sign-out');
        expect(() => f.iface.CancelPhotoOperation('batch')).toThrow('sign-out');
        f.releaseSignOut(); await pending;
        await expect(f.iface.RenamePhotoAlbum('{"uid":"a","name":"New"}')).rejects.toThrow('Not signed in');
        await expect(f.iface.DeletePhotoAlbum('a')).rejects.toThrow('Not signed in');
        expect(f.calls).toEqual([['reset']]);
    });
});
