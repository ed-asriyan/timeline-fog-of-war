// Presentation Layer: Web Mercator projection

/**
 * Leaflet's EPSG:3857 with 256 px tiles, written out so the draw loop can
 * project a few hundred thousand points without calling into Leaflet, which
 * allocates a LatLng and a Point per call.
 *
 * Subtract the map's pixel origin (getPixelBounds().min) from the result to
 * land in container coordinates, exactly what latLngToContainerPoint returns.
 */

const DEG_TO_RAD = Math.PI / 180;

/** Web Mercator is undefined at the poles; Leaflet cuts it off here. */
export const MAX_MERCATOR_LATITUDE = 85.0511287798;

/** Width of the whole world in pixels at this zoom. */
export function mercatorScale(zoom: number): number {
  return 256 * Math.pow(2, zoom);
}

export function mercatorX(lon: number, scale: number): number {
  return (scale * (lon + 180)) / 360;
}

export function mercatorY(lat: number, scale: number): number {
  const clamped = lat > MAX_MERCATOR_LATITUDE
    ? MAX_MERCATOR_LATITUDE
    : lat < -MAX_MERCATOR_LATITUDE
      ? -MAX_MERCATOR_LATITUDE
      : lat;
  const sin = Math.sin(clamped * DEG_TO_RAD);
  return scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
}
