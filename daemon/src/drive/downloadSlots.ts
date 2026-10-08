/** Matches the pinned SDK's file-download capacity, shared across our clients. */
export const MAX_CONCURRENT_DOWNLOADS = 5;

/** FIFO permits. Reserve synchronously so simultaneous callers cannot oversubscribe. */
class DownloadSlots {
    private active = 0;
    private waiting: Array<() => void> = [];

    private acquire(signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted();
        return new Promise((resolve, reject) => {
            const abort = () => {
                const index = this.waiting.indexOf(grant);
                if (index >= 0) this.waiting.splice(index, 1);
                reject(signal!.reason);
            };
            const grant = () => {
                signal?.removeEventListener('abort', abort);
                this.active++;
                let released = false;
                resolve(() => {
                    if (released) return;
                    released = true;
                    this.active--;
                    this.waiting.shift()?.();
                });
            };
            if (this.active < MAX_CONCURRENT_DOWNLOADS) grant();
            else {
                this.waiting.push(grant);
                signal?.addEventListener('abort', abort, { once: true });
            }
        });
    }

    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const release = await this.acquire(signal);
        try {
            signal?.throwIfAborted();
            return await work();
        } finally { release(); }
    }
}

export const downloadSlots = new DownloadSlots();
