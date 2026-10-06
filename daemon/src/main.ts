import * as dbus from 'dbus-next';

import { createSecretStore } from './auth/keyring.js';
import { VERSION } from './config.js';
import { DriveSession } from './drive/session.js';
import { TrashRecovery } from './drive/trash.js';
import { SyncManager } from './engine/manager.js';
import { BUS_NAME, HalyardInterface, OBJECT_PATH } from './ipc/dbus.js';
import { getLogger, logFilePath } from './log.js';
import { PhotoLibrary } from './photos/library.js';
import { PhotoVideos } from './photos/videos.js';
import { PhotoUploads } from './photos/uploads.js';
import { PhotoDownloads } from './photos/downloads.js';

const logger = getLogger('main');

async function main(): Promise<void> {
    logger.info(`Halyard daemon ${VERSION} starting (log: ${logFilePath})`);

    const bus = dbus.sessionBus();

    // Open the keyring-backed session up front. It talks to the secret service,
    // not our own database, so it is safe to run even when another daemon turns
    // out to own the name. Doing it before requestName lets
    // everything after the name check stay synchronous (see below).
    const store = await createSecretStore(bus);
    const session = await DriveSession.create(store);

    // Claim the well-known name before opening the sync database. If another
    // daemon already holds it, this instance must exit rather than compete for
    // the database.
    const nameFlags = await bus.requestName(BUS_NAME, dbus.NameFlag.DO_NOT_QUEUE);
    if (nameFlags !== dbus.RequestNameReply.PRIMARY_OWNER) {
        logger.error('Another Halyard daemon is already running; exiting');
        process.exit(1);
    }

    // From here to bus.export() there must be no `await`. A client watching the
    // bus name calls a method as soon as it appears (the UI
    // fires GetStatus); if we yielded to the event loop before exporting the
    // object, that call would be dispatched against an unexported path and
    // dbus-next would answer UnknownMethod. Exporting in the same tick the name
    // becomes ours guarantees the handler is registered before any such call is
    // processed.
    const manager = new SyncManager(session);
    let iface: HalyardInterface;
    const photos = new PhotoLibrary(
        () => session.getPhotosClient(),
        revision => iface.PhotosChanged(JSON.stringify({ revision })),
        error => logger.warn(`Could not update the photo library: ${error instanceof Error ? error.message : String(error)}`),
        () => session.getPhotosUploadClient(),
    );
    const downloads = new PhotoDownloads(
        () => session.getPhotosClient(),
        jobs => iface.PhotoDownloadsChanged(JSON.stringify(jobs)),
        (failed, title, body) => iface.Notify(JSON.stringify({ kind: failed ? 'error' : 'info', title, body })),
    );

    const uploads = new PhotoUploads(
        () => session.getPhotosUploadClient(),
        jobs => iface.PhotoUploadsChanged(JSON.stringify(jobs)),
        uid => photos.refreshUploaded(uid),
        (failed, title, body) => iface.Notify(JSON.stringify({ kind: failed ? 'error' : 'info', title, body })),
    );

    const videos = new PhotoVideos(
        () => session.getPhotosStreamingClient(),
        preview => iface.VideoPreviewChanged(JSON.stringify(preview)),
    );

    const trash = new TrashRecovery(
        async source => source === 'photos' ? session.getPhotosClient() : session.getClient(),
        uids => session.refreshNodes(uids),
        async source => {
            if (source === 'photos') await photos.refreshRestored();
            else void manager.syncAll().catch(error => logger.error('Sync after Trash restore failed', error));
        },
        jobs => iface.TrashRestoresChanged(JSON.stringify(jobs)),
        (warning, body) => iface.Notify(JSON.stringify({ kind: warning ? 'warning' : 'info', title: 'Trash restore', body })),
    );

    let quitting = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (quitting) {
            return;
        }
        quitting = true;
        logger.info(`Shutting down (${reason})`);
        try {
            await trash.stop();
            photos.reset();
            await downloads.stop();
            await uploads.stop();
            await videos.stop();
            await manager.stop();
        } catch (error) {
            logger.error('Error during shutdown', error);
        }
        bus.disconnect();
        process.exit(0);
    };

    iface = new HalyardInterface(manager, session, () => void shutdown('requested over D-Bus'), photos, downloads, uploads, videos, trash);
    bus.export(OBJECT_PATH, iface);

    manager.onStatusChanged((status) => {
        iface.StatusChanged(JSON.stringify(status));
    });

    manager.onNotify((kind, title, body) => {
        iface.Notify(JSON.stringify({ kind, title, body }));
    });

    session.onAuthStateChanged((state, error) => {
        iface.LoginStateChanged(JSON.stringify({ state, error: error ?? null }));

        if (state === 'success') {
            void (async () => {
                try {
                    const account = await session.getAccount();
                    manager.setEmail(account.email);
                    await manager.onSignedIn();
                    iface.Notify(
                        JSON.stringify({
                            kind: 'info',
                            title: 'Signed in',
                            body: account.email ? `Connected as ${account.email}` : 'Connected to Proton Drive',
                        }),
                    );
                } catch (startError) {
                    logger.error('Could not start syncing after sign-in', startError);
                }
            })();
        }
    });

    if (session.isLoggedIn()) {
        const account = await session.getAccount();
        manager.setEmail(account.email);
    }

    await manager.start();

    logger.info(`Listening on ${BUS_NAME}`);

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('unhandledRejection', (reason) => {
        logger.error('Unhandled promise rejection', reason);
    });
}

main().catch((error) => {
    logger.error('Daemon failed to start', error);
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
});
