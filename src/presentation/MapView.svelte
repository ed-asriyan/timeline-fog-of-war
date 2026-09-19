<!-- Presentation Layer: Map + fog overlay (Svelte) -->
<script lang="ts" module>
  export interface MapBoundsRect {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import L from 'leaflet';
  import type { TimelinePoint, TimelinePath } from '../domains/map/ports';
  import type { FogSettings } from '../infrastructure/repositories/UISettingsRepository';
  import { MIN_VISIBLE_PIXEL_RADIUS, fogPixelRadius } from './scale';

  interface MapViewport {
    lat: number;
    lng: number;
    zoom: number;
  }

  let {
    points,
    segments,
    settings,
    viewport,
    onViewportChange,
    onBoundsChange,
  }: {
    points: TimelinePoint[];
    segments: TimelinePath[];
    settings: FogSettings;
    viewport: MapViewport;
    onViewportChange: (lat: number, lng: number, zoom: number) => void;
    onBoundsChange?: (bounds: MapBoundsRect) => void;
  } = $props();

  let mapContainer: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let map: L.Map | null = null;
  let dragStartCenter: L.LatLng | null = null;

  // Draw fog overlay
  function drawCanvas() {
    if (!map || !canvas) return;

    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) {
      canvas.width = size.x;
      canvas.height = size.y;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Fill with fog
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Erase explored areas
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 1)';

    const center = map.getCenter();
    const pixelRadius = fogPixelRadius(settings.radius, center.lat, map.getZoom());

    if (pixelRadius < MIN_VISIBLE_PIXEL_RADIUS) {
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    // Draw roads (data is pre-filtered by grid query)
    if (settings.connectPaths) {
      ctx.beginPath();
      ctx.lineWidth = pixelRadius * 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      for (const segment of segments) {
        // The new TimelinePath format provides a list of points
        if (segment.points.length < 2) continue;

        // Note: Here we could manually calculate the total distance of all segments
        // if we still want to filter by path length

        ctx.beginPath();
        const startPt = map.latLngToContainerPoint([segment.points[0].lat, segment.points[0].lon]);
        ctx.moveTo(startPt.x, startPt.y);

        for (let i = 1; i < segment.points.length; i++) {
          const p = map.latLngToContainerPoint([segment.points[i].lat, segment.points[i].lon]);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }

    // Draw points (data is pre-filtered by grid query)
    ctx.beginPath();
    for (const point of points) {
      const pt = map.latLngToContainerPoint([point.lat, point.lon]);
      ctx.moveTo(pt.x + pixelRadius, pt.y);
      ctx.arc(pt.x, pt.y, pixelRadius, 0, Math.PI * 2);
    }
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }

  export function centerOnPoint(point: { lat: number; lon: number }) {
    if (map) {
      map.setView([point.lat, point.lon], 13);
    }
  }

  export function flyToLocation(lat: number, lon: number, zoom: number = 15) {
    if (map) {
      map.flyTo([lat, lon], zoom, {
        duration: 1.5,
      });
    }
  }

  onMount(() => {
    const m = L.map(mapContainer, {
      zoomControl: false,
      attributionControl: false,
    }).setView([viewport.lat, viewport.lng], viewport.zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(m);

    L.control.attribution({ position: 'bottomright' }).addTo(m);

    const fireBounds = (target: L.Map) => {
      if (!onBoundsChange) return;
      const b = target.getBounds();
      onBoundsChange({
        minLat: b.getSouth(),
        maxLat: b.getNorth(),
        minLon: b.getWest(),
        maxLon: b.getEast(),
      });
    };

    // Save viewport on move/zoom (with debouncing through moveend)
    m.on('moveend', () => {
      const center = m.getCenter();
      const zoom = m.getZoom();
      onViewportChange(center.lat, center.lng, zoom);
      fireBounds(m);
    });

    // Fire initial bounds once the map is ready
    m.whenReady(() => fireBounds(m));

    map = m;

    // Store the map center when drag starts
    const onMoveStart = () => {
      dragStartCenter = m.getCenter();
    };

    // Move canvas during drag
    const onMove = () => {
      if (!dragStartCenter) return;

      // Calculate pixel offset from where canvas was drawn
      const startPoint = m.latLngToContainerPoint(dragStartCenter);
      const currentCenter = m.getCenter();
      const currentPoint = m.latLngToContainerPoint(currentCenter);

      const offsetX = startPoint.x - currentPoint.x;
      const offsetY = startPoint.y - currentPoint.y;

      // Move canvas by the offset
      canvas.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
    };

    // Reset canvas position and redraw at new location
    const onMoveEnd = () => {
      dragStartCenter = null;
      canvas.style.transform = '';
      drawCanvas();
    };

    m.on('movestart', onMoveStart);
    m.on('move', onMove);
    m.on('moveend', onMoveEnd);
    m.on('zoomend', drawCanvas);
    m.on('resize', drawCanvas);

    drawCanvas();

    return () => {
      m.remove();
      map = null;
    };
  });

  // Redraw whenever data or settings change
  $effect(() => {
    // Track reactive dependencies
    points;
    segments;
    settings;
    if (map) drawCanvas();
  });
</script>

<div class="flex-1 relative isolate">
  <div bind:this={mapContainer} class="absolute inset-0 z-0 bg-gray-200"></div>
  <canvas bind:this={canvas} class="absolute inset-0 z-10 pointer-events-none"></canvas>
</div>
