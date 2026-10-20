/** Real account response hooks and crypto clock, with all HTTP handled in memory. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import '@protontech/crypto/polyfill';
import { serverTime, wasServerTimeEverUpdated } from '@protontech/crypto';
import { ApiClient } from 'proton-drive-sdk-account';

import { Credentials } from '../src/auth/credentials.js';
import { APP_VERSION_HEADER } from '../src/config.js';
import { createServerTimeAfterResponseHook } from '../src/drive/serverTimeHook.js';

async function createClient() {
    const credentials = new Credentials({
        async get() { return undefined; },
        async set() {},
        async delete() {},
    });
    await credentials.setSessionInfo({
        uid: 'offline-user', accessToken: 'offline-access', refreshToken: 'offline-refresh',
    });
    const client = new ApiClient({
        baseUrl: 'offline.invalid',
        appVersion: APP_VERSION_HEADER,
        credentials,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        afterResponseHooks: [createServerTimeAfterResponseHook()],
    });
    return { client, credentials };
}

const requestMethods = ['authenticatedRequest', 'unauthenticatedRequest'] as const;
const invalidHeaders: Array<[string, Record<string, string>]> = [
    ['missing dates', {}],
    ['invalid custom date alone', { 'x-pm-date': 'invalid' }],
    ['invalid standard date alone', { date: 'invalid' }],
    ['both dates invalid', { 'x-pm-date': 'invalid', date: 'also invalid' }],
    ['empty dates', { 'x-pm-date': '', date: '' }],
];

// These cases run before any valid update, so even passing an Invalid Date to
// crypto is detected: its public diagnostic flag records every update call.
for (const [name, headers] of invalidHeaders) {
    for (const method of requestMethods) {
        test(`${method} ignores ${name}`, async () => {
            const { client } = await createClient();
            await client[method]('https://offline.invalid/test', {
                fetch: async () => Response.json({ Code: 1000 }, { headers }),
            });
            assert.equal(wasServerTimeEverUpdated(), false);
        });
    }
}

// Crypto only advances its server clock. Use increasing dates, all far behind
// the device clock, to check every response path without changing system time.
let nextDate = Date.parse('2000-01-01T00:00:00Z');
for (const name of ['custom precedence', 'standard fallback', 'invalid custom fallback', 'empty custom fallback']) {
    for (const method of requestMethods) {
        test(`${method} uses ${name}`, async () => {
            nextDate += 86_400_000;
            const expected = new Date(nextDate);
            const headers: Record<string, string> = name === 'custom precedence'
                ? { 'x-pm-date': expected.toUTCString(), date: new Date(nextDate + 60_000).toUTCString() }
                : { date: expected.toUTCString(),
                    ...(name === 'invalid custom fallback' ? { 'x-pm-date': 'invalid' } : {}),
                    ...(name === 'empty custom fallback' ? { 'x-pm-date': '' } : {}) };
            const { client } = await createClient();
            const response = await client[method]('https://offline.invalid/test', {
                fetch: async (input, init) => {
                    const request = new Request(input, init);
                    assert.equal(request.headers.get('x-pm-appversion'), APP_VERSION_HEADER);
                    assert.equal(request.headers.get('Authorization'),
                        method === 'authenticatedRequest' ? 'Bearer offline-access' : null);
                    return Response.json({ Code: 1000 }, { headers });
                },
            });
            assert.equal(serverTime().getTime(), expected.getTime());
            assert.ok(serverTime().getTime() < Date.now() - 60_000);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { Code: 1000 });
        });
    }
}

test('undated or invalid responses preserve an established crypto server time', async () => {
    const expected = serverTime().getTime();
    const { client } = await createClient();
    for (const [, headers] of invalidHeaders) {
        await client.authenticatedRequest('https://offline.invalid/test', {
            fetch: async () => Response.json({}, { headers }),
        });
        assert.equal(serverTime().getTime(), expected);
    }
});

test('server time updates preserve the real 401 refresh and authenticated retry', async (t) => {
    const expected = new Date(nextDate + 86_400_000);
    const requests: Request[] = [];
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        assert.equal(request.headers.get('x-pm-appversion'), APP_VERSION_HEADER);
        assert.equal(request.headers.get('x-pm-uid'), 'offline-user');
        if (new URL(request.url).pathname === '/auth/v4/refresh') {
            assert.equal(request.method, 'POST');
            assert.deepEqual(await request.json(), {
                ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: 'offline-refresh',
            });
            return Response.json({ UID: 'offline-user', AccessToken: 'offline-renewed', RefreshToken: 'offline-new-refresh' },
                { headers: { 'x-pm-date': expected.toUTCString() } });
        }
        if (requests.length === 1) return Response.json({}, { status: 401 });
        assert.equal(serverTime().getTime(), expected.getTime());
        assert.equal(request.headers.get('Authorization'), 'Bearer offline-renewed');
        return Response.json({ Code: 1000 }, { headers: { date: expected.toUTCString() } });
    });
    const { client, credentials } = await createClient();
    const response = await client.authenticatedRequest('https://offline.invalid/test');
    assert.deepEqual(await response.json(), { Code: 1000 });
    assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/test', '/auth/v4/refresh', '/test']);
    assert.equal(credentials.accessToken, 'offline-renewed');
    assert.equal(credentials.refreshToken, 'offline-new-refresh');
    assert.equal(serverTime().getTime(), expected.getTime());
});
