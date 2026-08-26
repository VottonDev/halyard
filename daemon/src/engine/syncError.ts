export type SyncFailure = {
    message: string;
    transient: boolean;
};

const HTML_INSTEAD_OF_JSON = /unexpected token ['"]?<['"]?|<!doctype|not valid json/i;
const TEMPORARY_SERVER_MESSAGE = /too many server errors|temporar(?:y|ily) unavailable|service unavailable/i;
const RATE_LIMIT_MESSAGE = /too many (?:server )?requests|rate.?limit/i;
const CONNECTION_MESSAGE = /fetch failed|network|offline|timed? ?out|timeout|econnreset|enotfound|eai_again/i;

/**
 * Separates failures which need a user's attention from temporary failures of
 * the connection or Proton service. The latter are shown once, globally, and
 * retried after a cooldown instead of turning every pair into a red error.
 */
export function describeSyncFailure(error: unknown): SyncFailure {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : '';
    const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
            ? Number((error as { statusCode?: unknown }).statusCode)
            : undefined;

    if (name === 'RateLimitedError' || statusCode === 429 || RATE_LIMIT_MESSAGE.test(message)) {
        return {
            message: 'Proton Drive is temporarily limiting requests. Halyard will retry automatically.',
            transient: true,
        };
    }

    if (
        name === 'ConnectionError' ||
        name === 'OfflineError' ||
        name === 'TimeoutError' ||
        CONNECTION_MESSAGE.test(message)
    ) {
        return {
            message: 'Halyard cannot reach Proton Drive. It will retry automatically.',
            transient: true,
        };
    }

    if (
        name === 'ServerError' ||
        (name === 'APIHTTPError' && statusCode !== undefined && statusCode >= 500) ||
        (statusCode !== undefined && statusCode >= 500) ||
        HTML_INSTEAD_OF_JSON.test(message) ||
        TEMPORARY_SERVER_MESSAGE.test(message)
    ) {
        return {
            message: 'Proton Drive is temporarily unavailable. Halyard will retry automatically.',
            transient: true,
        };
    }

    return { message, transient: false };
}
