// Infrastructure Layer: run imports in a worker, with the page as the fallback

import { Bounds, Group, LocationPoint, MapApp, Settings, Statistics } from '../../domains/map/ports';
import type { ImportRequest, ImportResponse } from './import.worker';

type ProgressCallback = (status: 'parsing' | 'saving', progress: number) => void;

/**
 * Imports a file in a worker so that reading it, parsing it and writing it do
 * not block the page. Everything else is the wrapped application.
 *
 * Any failure to start or finish in the worker falls back to importing on the
 * main thread. That is safe to retry on top of a half-written import: near
 * duplicates are dropped, so the second pass adds only what the first missed.
 * It is also the path GPX takes, since parsing it needs DOMParser, which a
 * worker does not have.
 */
export class WorkerImportMapApp implements MapApp {
    private readonly inner: MapApp;
    private readonly onImported: () => void;

    constructor(inner: MapApp, onImported: () => void = () => {}) {
        this.inner = inner;
        this.onImported = onImported;
    }

    async loadPoints(data: string | Blob, onProgress?: ProgressCallback): Promise<LocationPoint | null> {
        try {
            const lastPoint = await this.importInWorker(data, onProgress);
            this.onImported();
            return lastPoint;
        } catch (error) {
            console.warn('Importing in the page instead of a worker:', error);
        }

        const lastPoint = await this.inner.loadPoints(data, onProgress);
        this.onImported();
        return lastPoint;
    }

    clear(): Promise<void> {
        return this.inner.clear();
    }

    getData(bounds: Bounds, resolutionKm?: number): Promise<Group> {
        return this.inner.getData(bounds, resolutionKm);
    }

    getStatistics(bounds: Bounds): Promise<Statistics> {
        return this.inner.getStatistics(bounds);
    }

    getSettings(): Promise<Settings> {
        return this.inner.getSettings();
    }

    saveSettings(settings: Settings): Promise<void> {
        return this.inner.saveSettings(settings);
    }

    private importInWorker(data: string | Blob, onProgress?: ProgressCallback): Promise<LocationPoint | null> {
        return new Promise((resolve, reject) => {
            if (typeof Worker === 'undefined') {
                reject(new Error('Workers are not available'));
                return;
            }

            const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
            const finish = (settle: () => void) => {
                worker.terminate();
                settle();
            };

            worker.onmessage = (event: MessageEvent<ImportResponse>) => {
                const message = event.data;
                if (message.type === 'progress') {
                    onProgress?.(message.status, message.progress);
                } else if (message.type === 'done') {
                    finish(() => resolve(message.lastPoint));
                } else {
                    finish(() => reject(new Error(message.message)));
                }
            };

            worker.onerror = event => finish(() => reject(new Error(event.message || 'Import worker failed')));
            worker.onmessageerror = () => finish(() => reject(new Error('Import worker could not read the message')));

            const request: ImportRequest = { data };
            worker.postMessage(request);
        });
    }
}
