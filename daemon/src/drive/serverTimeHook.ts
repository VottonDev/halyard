import { updateServerTime } from '@protontech/crypto';
import type { AfterResponseHook } from 'ky';

/** Keep keys and signatures on API time when the device clock is ahead. */
export function createServerTimeAfterResponseHook(): AfterResponseHook {
    return (_request, _options, response) => {
        const serverTime = parseDate(response.headers.get('x-pm-date')) ?? parseDate(response.headers.get('date'));
        if (serverTime) {
            updateServerTime(serverTime);
        }
    };
}

function parseDate(value: string | null): Date | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}
