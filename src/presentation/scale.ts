// Presentation Layer: screen scale of the Web Mercator tile grid

/** Circumference of the Earth at the equator, the width of the world in Web Mercator. */
const EQUATOR_METERS = 40075016.686;

/** Below this the fog circles cover less than a pixel and nothing of them shows. */
export const MIN_VISIBLE_PIXEL_RADIUS = 0.5;

/** Ground resolution in metres per screen pixel at this latitude and zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METERS * Math.abs(Math.cos((lat * Math.PI) / 180))) / Math.pow(2, zoom + 8);
}

/** Radius of a fog circle in screen pixels. */
export function fogPixelRadius(radiusKm: number, lat: number, zoom: number): number {
  return (radiusKm * 1000) / metersPerPixel(lat, zoom);
}
