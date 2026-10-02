import type {
    ProtonDriveHTTPClient,
    ProtonDriveHTTPClientBlobRequest,
    ProtonDriveHTTPClientJsonRequest,
} from '@protontech/drive-sdk';
import type { ApiClient } from 'proton-drive-sdk-account';

/**
 * Bridges the SDK's HTTP contract onto the account module's authenticated ky
 * instance, so every Drive request automatically carries the session headers
 * and takes part in the shared 401-refresh flow.
 */
export class HttpClient implements ProtonDriveHTTPClient {
    constructor(
        private readonly apiClient: ApiClient,
        private readonly preventPhotoVolumeCreation = false,
    ) {}

    async fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
        // The Photos SDK bootstraps a volume when its initial GET returns
        // 404. Browsing an empty gallery must not create cloud storage.
        if (this.preventPhotoVolumeCreation && request.method.toUpperCase() === 'POST' &&
            new URL(request.url).pathname.replace(/\/$/, '') === '/drive/photos/volumes') {
            throw new Error('No photos have been added to Proton Drive yet.');
        }
        return this.apiClient.authenticatedRequest(request.url, {
            method: request.method,
            ...(request.json !== undefined ? { json: request.json } : {}),
            ...(request.body !== undefined && request.json === undefined ? { body: request.body } : {}),
            headers: request.headers,
            timeout: request.timeoutMs,
            signal: request.signal,
            // The SDK parses non-2xx responses itself to produce typed errors,
            // so ky must hand them over instead of throwing.
            throwHttpErrors: false,
        });
    }

    async fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
        return this.apiClient.authenticatedRequest(request.url, {
            method: request.method,
            body: request.body,
            headers: request.headers,
            timeout: request.timeoutMs,
            signal: request.signal,
            throwHttpErrors: false,
            // ky reports upload progress for us; the SDK uses this to drive
            // per-file transfer progress.
            ...(request.onProgress
                ? {
                      onUploadProgress: (progress: { transferredBytes: number }) => {
                          request.onProgress?.(progress.transferredBytes);
                      },
                  }
                : {}),
        });
    }
}
