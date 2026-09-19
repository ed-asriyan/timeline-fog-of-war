import { describe, it, expect } from 'vitest';
import { MIN_DISTANCE_KM, PathDeduplicator, PointDeduplicator } from './dedup';
import { calculateDistance } from './geometry';
import { TimelinePoint } from './ports';

const point = (lat: number, lon: number, timestamp = 0): TimelinePoint => ({ lat, lon, timestamp });
const path = (...points: TimelinePoint[]) => ({ points });

/** ~11 m and ~33 m in degrees of latitude, either side of the 20 m threshold. */
const CLOSE_DEG = 0.0001;
const FAR_DEG = 0.0003;

describe('PointDeduplicator', () => {
  it('rejects a point closer than the threshold', () => {
    const dedup = new PointDeduplicator();
    expect(dedup.add(point(47.62, -122.35))).toBe(true);
    expect(dedup.add(point(47.62 + CLOSE_DEG, -122.35))).toBe(false);
    expect(dedup.add(point(47.62, -122.35 + CLOSE_DEG))).toBe(false);
  });

  it('keeps a point further away than the threshold', () => {
    const dedup = new PointDeduplicator();
    expect(dedup.add(point(47.62, -122.35))).toBe(true);
    expect(dedup.add(point(47.62 + FAR_DEG, -122.35))).toBe(true);
    expect(dedup.add(point(47.62, -122.35 + FAR_DEG))).toBe(true);
  });

  it('ignores the timestamp', () => {
    const dedup = new PointDeduplicator();
    expect(dedup.add(point(47.62, -122.35, 1))).toBe(true);
    expect(dedup.add(point(47.62, -122.35, 2_000_000))).toBe(false);
  });

  it('measures against the point that was kept, not the one that was dropped', () => {
    const dedup = new PointDeduplicator();
    // Three points 11 m apart in a row: the middle one is dropped, the third
    // one is 22 m from the first and therefore kept.
    expect(dedup.add(point(0, 0))).toBe(true);
    expect(dedup.add(point(CLOSE_DEG, 0))).toBe(false);
    expect(dedup.add(point(2 * CLOSE_DEG, 0))).toBe(true);
  });

  it('matches across the antimeridian', () => {
    const dedup = new PointDeduplicator();
    expect(calculateDistance({ lat: 0, lon: 179.99995 }, { lat: 0, lon: -179.99995 }))
      .toBeLessThan(MIN_DISTANCE_KM);
    expect(dedup.add(point(0, 179.99995))).toBe(true);
    expect(dedup.add(point(0, -179.99995))).toBe(false);
    expect(dedup.add(point(0, -179.999))).toBe(true);
  });

  it('accounts for meridians converging at high latitude', () => {
    const dedup = new PointDeduplicator();
    // 0.001 deg of longitude is ~19 m at 80 deg north, but ~111 m at the equator.
    expect(dedup.add(point(80, 10))).toBe(true);
    expect(dedup.add(point(80, 10.001))).toBe(false);
    expect(dedup.add(point(80, 10.003))).toBe(true);

    const equator = new PointDeduplicator();
    expect(equator.add(point(0, 10))).toBe(true);
    expect(equator.add(point(0, 10.001))).toBe(true);
  });

  it('works at the poles', () => {
    const dedup = new PointDeduplicator();
    expect(dedup.add(point(89.9999, 0))).toBe(true);
    expect(dedup.add(point(89.9999, 120))).toBe(false); // ~1 m apart on the ground
    expect(dedup.add(point(89.99, 0))).toBe(true);
  });

  it('honours a custom threshold', () => {
    const dedup = new PointDeduplicator(1); // 1 km
    expect(dedup.add(point(47.62, -122.35))).toBe(true);
    expect(dedup.add(point(47.625, -122.35))).toBe(false); // ~556 m
    expect(dedup.add(point(47.64, -122.35))).toBe(true); // ~2.2 km
  });
});

describe('PathDeduplicator', () => {
  const a = point(47.62, -122.35);
  const b = point(47.65, -122.30);

  it('rejects a path whose endpoints both match pairwise', () => {
    const dedup = new PathDeduplicator();
    expect(dedup.add(path(a, b))).toBe(true);
    expect(dedup.add(path(point(a.lat + CLOSE_DEG, a.lon), point(b.lat, b.lon + CLOSE_DEG)))).toBe(false);
  });

  it('keeps a path when only one endpoint matches', () => {
    const dedup = new PathDeduplicator();
    expect(dedup.add(path(a, b))).toBe(true);
    expect(dedup.add(path(a, point(b.lat + FAR_DEG, b.lon)))).toBe(true);
  });

  it('treats the way back as the same path', () => {
    const dedup = new PathDeduplicator();
    expect(dedup.add(path(a, b))).toBe(true);
    expect(dedup.add(path(point(b.lat, b.lon + CLOSE_DEG), a))).toBe(false);
  });

  it('compares endpoints only, so intermediate points do not matter', () => {
    const dedup = new PathDeduplicator();
    expect(dedup.add(path(a, point(47.63, -122.34), b))).toBe(true);
    expect(dedup.add(path(a, point(47.60, -122.31), b))).toBe(false);
  });

  it('drops a path that has fewer than two points', () => {
    const dedup = new PathDeduplicator();
    expect(dedup.add(path())).toBe(false);
    expect(dedup.add(path(a))).toBe(false);
  });
});
