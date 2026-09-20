import { describe, it, expect } from 'vitest';
import L from 'leaflet';
import { MAX_MERCATOR_LATITUDE, mercatorScale, mercatorX, mercatorY } from './mercator';

/** Places spread over the map, plus the edges of what Mercator covers. */
const places: Array<[number, number]> = [
  [0, 0],
  [47.6205, -122.3493],
  [-33.8688, 151.2093],
  [55.7558, 37.6173],
  [-89, -179.9999],
  [MAX_MERCATOR_LATITUDE, 180],
  [91, 200], // out of range, clamped the same way Leaflet clamps it
];

describe('mercator', () => {
  it('projects exactly like Leaflet does', () => {
    for (const zoom of [0, 3, 9, 13, 16, 19]) {
      const scale = mercatorScale(zoom);
      for (const [lat, lon] of places) {
        const expected = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lon), zoom);
        // Six decimals of a pixel: the two differ only in the last bits of the
        // double, since the arithmetic is the same in a different order.
        expect(mercatorX(lon, scale)).toBeCloseTo(expected.x, 6);
        expect(mercatorY(lat, scale)).toBeCloseTo(expected.y, 6);
      }
    }
  });

  it('doubles in size with every zoom level', () => {
    expect(mercatorScale(0)).toBe(256);
    expect(mercatorScale(10)).toBe(mercatorScale(9) * 2);
  });
});
