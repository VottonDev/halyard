import * as dbus from 'dbus-next';

import { createSecretStore } from './auth/keyring.js';
import { VERSION } from './config.js';
import { DriveSession } from './drive/session.js';
import { SyncManager } from './engine/manager.js';
import { BUS_NAME, HalyardInterface, OBJECT_PATH } from './ipc/dbus.js';
import { getLogger, logFilePath } from './log.js';

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

    let quitting = false;
    const shutdown = async (reason: string): Promise<void> => {
        if (quitting) {
            return;
        }
        quitting = true;
        logger.info(`Shutting down (${reason})`);
        try {
            await manager.stop();
        } catch (error) {
            logger.error('Error during shutdown', error);
        }
        bus.disconnect();
        process.exit(0);
    };

    const iface = new HalyardInterface(manager, session, () => void shutdown('requested over D-Bus'));
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
