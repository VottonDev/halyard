import { describe, expect, test } from 'bun:test';

import { describeSyncFailure } from '../src/engine/syncError.js';

describe('describeSyncFailure', () => {
    test('recognises an HTML outage page parsed as JSON', () => {
        const failure = describeSyncFailure(
            new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`),
        );

        expect(failure.transient).toBe(true);
        expect(failure.message).toBe(
            'Proton Drive is temporarily unavailable. Halyard will retry automatically.',
        );
    });

    test('recognises a plain-text 503 body parsed as JSON', () => {
        const failure = describeSyncFailure(
            new SyntaxError(`Unexpected token 'S', "Service Unavailable" is not valid JSON`),
        );

        expect(failure.transient).toBe(true);
        expect(failure.message).toBe(
            'Proton Drive is temporarily unavailable. Halyard will retry automatically.',
        );
    });

    test('recognises the SDK server-error circuit breaker', () => {
        const error = new Error('Too many server errors, please try again later');
        error.name = 'ServerError';

        expect(describeSyncFailure(error).transient).toBe(true);
    });

    test('recognises 5xx SDK HTTP errors', () => {
        const error = Object.assign(new Error('Bad Gateway'), {
            name: 'APIHTTPError',
            statusCode: 502,
        });

        expect(describeSyncFailure(error).transient).toBe(true);
    });

    test('leaves pair-specific errors alone', () => {
        const failure = describeSyncFailure(new Error('Permission denied'));

        expect(failure).toEqual({ message: 'Permission denied', transient: false });
    });
});
