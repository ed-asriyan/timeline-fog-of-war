import { describe, it, expect } from 'vitest';
import { decodeSegment, encodeSegment } from './SegmentRecord';
import { MapSegment, TimelinePoint } from '../../domains/map/ports';

const point = (lat: number, lon: number, timestamp = 1_700_000_000_000): TimelinePoint => ({ lat, lon, timestamp });

const segment = (points: TimelinePoint[], paths: TimelinePoint[][] = []): MapSegment => ({
  index: 42,
  group: { points, paths: paths.map(p => ({ points: p })) },
});

describe('SegmentRecord', () => {
  it('round trips points and paths', () => {
    const original = segment(
      [point(47.6205, -122.3493), point(-33.8688, 151.2093)],
      [
        [point(47.62, -122.35), point(47.63, -122.34, 1_700_000_060_000)],
        [point(10, 20), point(11, 21), point(12, 22)],
      ],
    );

    const back = decodeSegment(encodeSegment(original));

    expect(back.index).toBe(42);
    expect(back.group.points).toHaveLength(2);
    expect(back.group.paths.map(p => p.points.length)).toEqual([2, 3]);
    expect(back.group.points[0].lat).toBeCloseTo(47.6205, 7);
    expect(back.group.points[1].lon).toBeCloseTo(151.2093, 7);
    expect(back.group.paths[1].points[2].lat).toBeCloseTo(12, 7);
    expect(back.group.paths[0].points[1].timestamp).toBe(1_700_000_060_000);
  });

  it('keeps coordinates to about a centimetre', () => {
    const original = segment([point(47.62051239, -122.34931765)]);

    const [back] = decodeSegment(encodeSegment(original)).group.points;

    // 1e-7 degrees is a little over a centimetre of latitude.
    expect(Math.abs(back.lat - 47.62051239)).toBeLessThan(1e-7);
    expect(Math.abs(back.lon - -122.34931765)).toBeLessThan(1e-7);
  });

  it('holds the extremes of the coordinate range', () => {
    const original = segment([point(90, 180), point(-90, -180)]);

    const back = decodeSegment(encodeSegment(original)).group.points;

    expect(back[0]).toMatchObject({ lat: 90, lon: 180 });
    expect(back[1]).toMatchObject({ lat: -90, lon: -180 });
  });

  it('drops what cannot be drawn', () => {
    const original = segment(
      [point(47.62, -122.35), point(NaN, -122.35), point(47.62, Infinity)],
      [
        [point(47.62, -122.35), point(47.63, -122.34)],
        [point(47.62, -122.35), point(NaN, -122.34)], // a broken vertex takes the path with it
        [point(47.62, -122.35)], // nothing to draw
      ],
    );

    const back = decodeSegment(encodeSegment(original));

    expect(back.group.points).toHaveLength(1);
    expect(back.group.paths).toHaveLength(1);
  });

  it('reads the records written before typed arrays', () => {
    const legacy = {
      id: 7,
      points: [point(47.62, -122.35)],
      paths: [{ points: [point(47.62, -122.35), point(47.63, -122.34)] }],
    };

    const back = decodeSegment(legacy);

    expect(back.index).toBe(7);
    expect(back.group.points).toEqual(legacy.points);
    expect(back.group.paths).toEqual(legacy.paths);
  });

  it('reads an empty segment', () => {
    expect(decodeSegment(encodeSegment(segment([]))).group).toEqual({ points: [], paths: [] });
    expect(decodeSegment({ id: 3 }).group).toEqual({ points: [], paths: [] });
  });
});
