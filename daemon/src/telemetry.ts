import { getLogger, type Logger } from './log.js';

/**
 * Telemetry sink for the SDK.
 *
 * Metrics are logged locally and never sent anywhere. Proton's own clients
 * report these to Proton, but doing that from a third-party app would mean
 * shipping user data upstream without a consent flow to justify it. The SDK
 * only needs `recordMetric` to exist, so we satisfy the interface and keep
 * everything on this machine.
 */
export class LocalTelemetry {
    getLogger(name: string): Logger {
        return getLogger(`sdk:${name}`);
    }

    recordMetric(event: { eventName: string } & Record<string, unknown>): void {
        // Errors carried inside metric events are the SDK's way of surfacing
        // non-fatal decryption and verification problems. Those are worth
        // seeing at warn level; everything else is debug noise.
        const isFailure = 'error' in event && event.error !== undefined;
        const log = getLogger('sdk:metric');
        const summary = `${event.eventName} ${JSON.stringify(omit(event, ['eventName', 'originalError']))}`;
        if (isFailure) {
            log.warn(summary);
        } else {
            log.debug(summary);
        }
    }
}

function omit(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (!keys.includes(key)) {
            output[key] = value;
        }
    }
    return output;
}
