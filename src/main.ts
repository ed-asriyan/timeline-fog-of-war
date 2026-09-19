import { mount } from 'svelte'
import App from './App.svelte'
import 'leaflet/dist/leaflet.css'
import './index.css'
import { registerSW } from 'virtual:pwa-register'
import { analytics } from './infrastructure/analytics'
import { WorkerImportMapApp } from './infrastructure/import/WorkerImportMapApp'
import { CachedMapSegmentRepository } from './infrastructure/repositories/CachedMapSegmentRepository'
import { IndexedDbMapSegmentRepository } from './infrastructure/repositories/IndexedDbMapSegmentRepository'
import { MapSettingsRepository } from './infrastructure/repositories/MapSettingsRepository'
import { Map as MapApp } from './domains/map/app'

import { TimelineParserFactory } from './infrastructure/parsers/TimelineParser'

// Initialize analytics
analytics.init();

// Register service worker for PWA functionality
registerSW({
  immediate: true,
  onNeedRefresh() {
    console.log('New content available, please refresh.');
  },
  onOfflineReady() {
    console.log('App ready to work offline');
  },
  onRegisteredSW(swUrl, r) {
    console.log('SW registered:', swUrl);
    // Add custom fetch handler for share target
    if (r) {
      r.addEventListener('updatefound', () => {
        console.log('SW update found');
      });
    }
  },
})

// Extend service worker with share target handler
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(() => {
    // The service worker will automatically handle /share-target endpoint
    console.log('Service Worker ready');
  });
}

// Create infrastructure and application objects, then render
IndexedDbMapSegmentRepository.openDb().then(store => {
  // Panning the map asks for segments it just had; keep them in memory.
  const mapSegmentRepository = new CachedMapSegmentRepository(store);
  const mapSettingsRepository = new MapSettingsRepository();

  const parser = new TimelineParserFactory();
  // Imports run in a worker with a connection of their own, so what the cache
  // holds has to go once one finishes.
  const mapApp = new WorkerImportMapApp(
    new MapApp(mapSegmentRepository, parser, mapSettingsRepository),
    () => mapSegmentRepository.forgetAll(),
  );

  mount(App, {
    target: document.getElementById('root')!,
    props: { mapApp, mapSegmentRepository },
  });
}).catch(err => {
  console.error('Failed to initialize app:', err);
  alert('Failed to initialize app. Error: ' + err);
});
