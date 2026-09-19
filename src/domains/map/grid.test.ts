import { describe, it, expect } from 'vitest';
import { LON_STEP_COUNTS, getSegmentIdForPoint, getSegmentIdsForBound } from './grid';

describe('getSegmentIdsForBound', () => {
  it('covers the rectangle exactly once', () => {
    const ids = getSegmentIdsForBound({ a: { lat: 47.62, lon: -122.35 }, b: { lat: 47.85, lon: -122.11 } });

    expect(ids).toHaveLength(3 * 3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(getSegmentIdForPoint({ lat: 47.62, lon: -122.35, timestamp: 0 }));
    expect(ids).toContain(getSegmentIdForPoint({ lat: 47.85, lon: -122.11, timestamp: 0 }));
    expect(ids).toContain(getSegmentIdForPoint({ lat: 47.7, lon: -122.2, timestamp: 0 }));
  });

  it('takes the corners in either order', () => {
    const rising = getSegmentIdsForBound({ a: { lat: 10, lon: 20 }, b: { lat: 10.2, lon: 20.2 } });
    const falling = getSegmentIdsForBound({ a: { lat: 10.2, lon: 20.2 }, b: { lat: 10, lon: 20 } });
    expect(rising).toEqual(falling);
  });

  it('clamps to the grid at the edges of the world', () => {
    const ids = getSegmentIdsForBound({ a: { lat: -90, lon: -180 }, b: { lat: 90, lon: 180 } });
    expect(ids).toHaveLength(1800 * LON_STEP_COUNTS);
    expect(ids[0]).toBe(0);
    expect(ids[ids.length - 1]).toBe(1800 * LON_STEP_COUNTS - 1);
  });
});
