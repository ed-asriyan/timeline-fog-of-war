<!-- Presentation Layer: Main Application Component (Svelte) -->
<script lang="ts">
  import { Menu } from '@lucide/svelte';
  import { createTimelineFiles } from './presentation/hooks/useTimelineFiles.svelte';
  import { createFogSettings } from './presentation/hooks/useFogSettings.svelte';
  import { createMapViewport } from './presentation/hooks/useMapViewport.svelte';
  import SidePanel from './presentation/components/SidePanel.svelte';
  import AddressSearch from './presentation/components/AddressSearch.svelte';
  import MapView, { type MapBoundsRect } from './presentation/MapView.svelte';
  import { MIN_VISIBLE_PIXEL_RADIUS, fogPixelRadius, metersPerPixel } from './presentation/scale';
  import { getSegmentCoverageKey } from './domains/map/grid';
  import { getDetailLevel } from './domains/map/lod';
  import { getSharedFiles } from './utils/share-target';
  import type { Map as MapApp } from './domains/map/app';
  import type { MapSegmentRepository, TimelinePoint, TimelinePath } from './domains/map/ports';

  let {
    mapApp,
    mapSegmentRepository,
  }: {
    mapApp: MapApp;
    mapSegmentRepository: MapSegmentRepository;
  } = $props();

  // State management through composables
  // svelte-ignore state_referenced_locally
  const files = createTimelineFiles(mapApp, mapSegmentRepository, (lat, lon) => {
    mapView?.flyToLocation(lat, lon, 12);
  });
  const fog = createFogSettings();
  const vp = createMapViewport();

  // Error state
  let error = $state<string | null>(null);

  // Viewport query state (async — populated via effect below).
  // $state.raw, not $state: these hold hundreds of thousands of entries and are
  // only ever replaced wholesale, while $state would wrap every point in a
  // reactive proxy and make the draw loop read them through it.
  let points = $state.raw<TimelinePoint[]>([]);
  let segments = $state.raw<TimelinePath[]>([]);
  let mapBounds = $state<MapBoundsRect | null>(null);

  let mapView = $state<ReturnType<typeof MapView>>();

  // What the data currently on screen was queried for. Plain, not $state: the
  // query effect both reads and writes it.
  let appliedQuery = '';

  // Query viewport data using the service (async)
  $effect(() => {
    const bounds = mapBounds;
    const settings = fog.settings;
    // Track data version so the query re-runs after upload/clear
    files.dataVersion;

    if (!bounds) return;

    // Zoomed far enough out the fog circles are smaller than a pixel and the
    // overlay draws nothing at all. Querying for it would walk the whole grid
    // (the world is 6.5M segments) to produce data nobody can see.
    if (fogPixelRadius(settings.radius, vp.viewport.lat, vp.viewport.zoom) < MIN_VISIBLE_PIXEL_RADIUS) {
      points = [];
      segments = [];
      appliedQuery = '';
      return;
    }

    // How much ground one pixel covers, which is the finest detail worth
    // reading: anything closer together than that lands on the same pixel.
    const resolutionKm = metersPerPixel(vp.viewport.lat, vp.viewport.zoom) / 1000;

    let cancelled = false;

    const query = async () => {
      try {
        // Add a small padding (radius) beyond visible area so fog circles near
        // the edge are fully rendered
        const padDeg = settings.radius / 111;

        const queryBounds = {
          a: {
            lat: Math.max(-90, bounds.minLat - padDeg),
            lon: Math.max(-180, bounds.minLon - padDeg),
          },
          b: {
            lat: Math.min(90, bounds.maxLat + padDeg),
            lon: Math.min(180, bounds.maxLon + padDeg),
          },
        };

        // Most pans and every radius change land on the same segments, and the
        // path settings are the only other thing getData() reads.
        const queryKey = [
          getSegmentCoverageKey(queryBounds),
          getDetailLevel(resolutionKm),
          settings.pathLengthKm,
          settings.pathVelocityKmh,
          files.dataVersion,
        ].join('|');
        if (queryKey === appliedQuery) return;

        const resultData = await mapApp.getData(queryBounds, resolutionKm);

        if (!cancelled) {
          points = resultData.points;
          segments = resultData.paths;
          appliedQuery = queryKey;
        }
      } catch (err: any) {
        if (!cancelled) {
          error = err?.message || 'An error occurred while loading map data.';
        }
      }
    };
    query();
    return () => {
      cancelled = true;
    };
  });

  // Check for shared files on mount (from PWA share target)
  let sharedFilesChecked = false;
  $effect(() => {
    if (sharedFilesChecked) return;
    sharedFilesChecked = true;

    (async () => {
      const sharedFiles = await getSharedFiles();
      if (sharedFiles.length > 0) {
        await files.uploadFiles(sharedFiles);
      }
    })();
  });
</script>

<div
  class="flex flex-col h-[100dvh] w-full bg-gray-50 text-gray-900 font-sans overflow-hidden relative"
>
  <!-- Error Alert -->
  {#if error}
    <div
      class="absolute top-4 left-1/2 -translate-x-1/2 z-[1000] bg-red-600 text-white p-4 rounded-xl shadow-xl text-sm border border-red-700/50 animate-in fade-in slide-in-from-top-4 duration-500"
    >
      <strong>Error:</strong>
      {error}
      <button
        class="ml-4 bg-white text-red-600 px-2 py-1 rounded hover:bg-red-100 border border-red-200"
        onclick={() => (error = null)}
      >
        Dismiss
      </button>
    </div>
  {/if}

  <!-- Side Panel -->
  <SidePanel
    isOpen={fog.isPanelOpen}
    onClose={() => fog.setIsPanelOpen(false)}
    settings={fog.settings}
    onRadiusChange={fog.updateRadius}
    onToggleRoads={fog.toggleConnectPaths}
    onMaxLinkDistanceChange={fog.updatePathLength}
    onMaxVelocityChange={fog.updatePathVelocity}
    isProcessing={files.isProcessing}
    loadingState={files.loadingState}
    hasData={files.hasData}
    onFilesSelected={files.uploadFiles}
    onClearAll={files.clearAll}
  />

  <!-- Info Toast (Visible only when no data imported) -->
  {#if !files.hasData && !files.isProcessing}
    <div
      class="absolute bottom-20 left-4 md:top-[calc(100vh-10rem)] md:bottom-auto z-[490] max-w-sm bg-blue-900/90 backdrop-blur text-white p-4 rounded-xl shadow-xl text-sm border border-blue-700/50 pointer-events-auto animate-in fade-in slide-in-from-left-4 duration-500"
    >
      <p class="font-semibold mb-1">Gamify Your Travel History</p>
      <p class="opacity-90 leading-relaxed text-blue-100">
        Your map starts covered in a "Fog of War". Upload your Google Timeline data to clear the fog
        and reveal the world you've explored!
      </p>
    </div>
  {/if}

  <!-- Toggle Button (Floating) -->
  {#if !fog.isPanelOpen}
    <button
      onclick={() => fog.setIsPanelOpen(true)}
      class="absolute z-[500] bg-white p-3 rounded-xl shadow-lg border border-gray-200 text-gray-700 hover:text-blue-600 active:scale-95 transition-all bottom-6 left-4 md:top-4 md:left-4 md:bottom-auto"
    >
      {#if files.isProcessing}
        <svg
          class="animate-spin w-6 h-6 text-blue-500"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      {:else}
        <Menu class="w-6 h-6" />
      {/if}
    </button>
  {/if}

  <!-- Address Search (Top Center) -->
  <div class="absolute z-[500] top-4 left-1/2 -translate-x-1/2 w-[90%] md:w-96 max-w-lg">
    <AddressSearch onLocationSelect={(lat, lon) => mapView?.flyToLocation(lat, lon)} />
  </div>

  <!-- Map Container -->
  <MapView
    bind:this={mapView}
    {points}
    {segments}
    settings={fog.settings}
    viewport={vp.viewport}
    onViewportChange={vp.updateViewport}
    onBoundsChange={(b) => (mapBounds = b)}
  />
</div>
