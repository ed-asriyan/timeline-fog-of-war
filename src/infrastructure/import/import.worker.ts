// Infrastructure Layer: importing a timeline file off the main thread

import { Map as MapDomain } from '../../domains/map/app';
import { Settings, SettingsRepository } from '../../domains/map/ports';
import { TimelineParserFactory } from '../parsers/TimelineParser';
import { IndexedDbMapSegmentRepository } from '../repositories/IndexedDbMapSegmentRepository';

export interface ImportRequest {
  data: string | Blob;
}

export type ImportResponse =
  | { type: 'progress'; status: 'parsing' | 'saving'; progress: number }
  | { type: 'done'; lastPoint: { lat: number; lon: number } | null }
  | { type: 'error'; message: string };

/**
 * The worker global. Typed by hand because the project compiles against the
 * DOM lib, where self.postMessage is the window one and takes an origin.
 */
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
  postMessage: (message: ImportResponse) => void;
};

/** loadPoints() reads none of these, and localStorage is not reachable here. */
const settings: SettingsRepository = {
  async saveSettings(): Promise<void> {},
  async loadSettings(): Promise<Settings> {
    return { maxPathDistanceKm: 0, maxPathVelocityKmh: 0 };
  },
};

ctx.onmessage = async (event: MessageEvent<ImportRequest>) => {
  try {
    // A connection of its own: IndexedDB is shared between the page and here,
    // and the page has already brought the store up to the current version.
    const store = await IndexedDbMapSegmentRepository.openDb();
    const app = new MapDomain(store, new TimelineParserFactory(), settings);

    const lastPoint = await app.loadPoints(event.data.data, (status, progress) => {
      ctx.postMessage({ type: 'progress', status, progress });
    });

    ctx.postMessage({ type: 'done', lastPoint });
  } catch (error) {
    ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
