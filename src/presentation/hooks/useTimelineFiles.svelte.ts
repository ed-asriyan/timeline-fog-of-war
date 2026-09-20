// Presentation Layer: Timeline files composable (Svelte)

import type { MapApp, MapSegmentRepository } from '../../domains/map/ports';
import { analytics } from '../../infrastructure/analytics';

export type LoadingState = {
  status: 'idle' | 'reading' | 'parsing' | 'saving';
  progress?: number;
};

export function createTimelineFiles(
  mapApp: MapApp,
  mapSegmentRepo: MapSegmentRepository,
  onLastPoint?: (lat: number, lon: number) => void,
) {
  let dataVersion = $state(0);
  let hasData = $state(false);
  let loadingState = $state<LoadingState>({ status: 'idle' });

  // Check on init whether IndexedDB already has data
  mapSegmentRepo.hasData().then((v) => (hasData = v)).catch(() => (hasData = false));

  // Upload files one at a time
  async function uploadFiles(fileList: File[]) {
    loadingState = { status: 'reading', progress: 0 };
    try {
      let filesProcessed = 0;
      let lastPoint: { lat: number; lon: number } | null = null;
      for (const file of fileList) {
        loadingState = { status: 'reading', progress: (filesProcessed / fileList.length) * 100 };

        const baseProgress = (filesProcessed / fileList.length) * 100;
        const fileShare = (1 / fileList.length) * 100;
        const point = await mapApp.loadPoints(file, (status, p) => {
          // p is 0-100 for the current file phase
          // Wait, 'saving' goes from 10 to 100, we can just say:
          if (status === 'saving') {
            loadingState = { status: 'saving', progress: baseProgress + fileShare * (0.3 + 0.7 * (p / 100)) };
          }
        });
        if (point) lastPoint = point;

        filesProcessed++;
      }

      dataVersion += 1;
      hasData = true;
      if (lastPoint) onLastPoint?.(lastPoint.lat, lastPoint.lon);
      analytics.track('Files Processed', { fileCount: fileList.length });
    } catch (error) {
      console.error('Failed to upload files:', error);
      analytics.track('File Processing Failed', { fileCount: fileList.length });
    } finally {
      loadingState = { status: 'idle' };
    }
  }

  // Clear all imported data
  async function clearAll() {
    try {
      await mapApp.clear();
      dataVersion += 1;
      hasData = false;
    } catch (error) {
      console.error('Failed to clear all data:', error);
    }
  }

  return {
    get dataVersion() {
      return dataVersion;
    },
    get hasData() {
      return hasData;
    },
    get isProcessing() {
      return loadingState.status !== 'idle';
    },
    get loadingState() {
      return loadingState;
    },
    uploadFiles,
    clearAll,
  };
}
