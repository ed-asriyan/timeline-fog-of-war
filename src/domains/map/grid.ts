import { Bounds, TimelinePoint } from "./ports";

export const LAT_STEP_COUNTS: number = 1800;
export const LON_STEP_COUNTS: number = 3600;

interface SegmentIndexRange {
  startLatIndex: number;
  endLatIndex: number;
  startLonIndex: number;
  endLonIndex: number;
}

function clampIndex(index: number, count: number): number {
  if (index >= count) return count - 1;
  if (index < 0) return 0;
  return index;
}

function getSegmentIndexRange(bounds: Bounds): SegmentIndexRange {
  const minLat = Math.min(bounds.a.lat, bounds.b.lat);
  const maxLat = Math.max(bounds.a.lat, bounds.b.lat);
  const minLon = Math.min(bounds.a.lon, bounds.b.lon);
  const maxLon = Math.max(bounds.a.lon, bounds.b.lon);

  return {
    startLatIndex: clampIndex(Math.floor((minLat + 90) * 10), LAT_STEP_COUNTS),
    endLatIndex: clampIndex(Math.floor((maxLat + 90) * 10), LAT_STEP_COUNTS),
    startLonIndex: clampIndex(Math.floor((minLon + 180) * 10), LON_STEP_COUNTS),
    endLonIndex: clampIndex(Math.floor((maxLon + 180) * 10), LON_STEP_COUNTS),
  };
}

/**
 * Identifies the set of segments a rectangle covers. Two rectangles with the
 * same key hold exactly the same data, which lets a caller skip repeating a
 * query after a pan too small to reach another segment.
 */
export function getSegmentCoverageKey(bounds: Bounds): string {
  const { startLatIndex, endLatIndex, startLonIndex, endLonIndex } = getSegmentIndexRange(bounds);
  return `${startLatIndex}:${endLatIndex}:${startLonIndex}:${endLonIndex}`;
}

export function getSegmentIdsForBound(bounds: Bounds): number[] {
  const { startLatIndex, endLatIndex, startLonIndex, endLonIndex } = getSegmentIndexRange(bounds);

  // Every (latIndex, lonIndex) pair in the rectangle maps to its own id, so the
  // list needs no de-duplication: fill an array of the known size instead of
  // going through a Set, which for a zoomed-out view means millions of entries.
  const ids: number[] = new Array((endLatIndex - startLatIndex + 1) * (endLonIndex - startLonIndex + 1));
  let next = 0;
  for (let latIndex = startLatIndex; latIndex <= endLatIndex; latIndex++) {
    const rowStart = latIndex * LON_STEP_COUNTS;
    for (let lonIndex = startLonIndex; lonIndex <= endLonIndex; lonIndex++) {
      ids[next++] = rowStart + lonIndex;
    }
  }

  return ids;
}

export function getSegmentIdForPoint(point: TimelinePoint): number {
  let latIndex = Math.floor((point.lat + 90) * 10);
  let lonIndex = Math.floor((point.lon + 180) * 10);

  if (latIndex >= LAT_STEP_COUNTS) latIndex = LAT_STEP_COUNTS - 1;
  if (lonIndex >= LON_STEP_COUNTS) lonIndex = LON_STEP_COUNTS - 1;

  if (latIndex < 0) latIndex = 0;
  if (lonIndex < 0) lonIndex = 0;

  return latIndex * LON_STEP_COUNTS + lonIndex;
}

export function getSegmentIdsForPath(path: { points: TimelinePoint[] }): number[] {
  if (path.points.length === 0) return [];
  
  const ids = new Set<number>();
  ids.add(getSegmentIdForPoint(path.points[0]));

  for (let i = 1; i < path.points.length; i++) {
    const p1 = path.points[i - 1];
    const p2 = path.points[i];
    
    const distLat = Math.abs(p2.lat - p1.lat);
    const distLon = Math.abs(p2.lon - p1.lon);
    const steps = Math.max(Math.ceil(distLat / 0.05), Math.ceil(distLon / 0.05), 1);
    
    for (let step = 1; step <= steps; step++) {
      const f = step / steps;
      const interpPoint = {
        lat: p1.lat + (p2.lat - p1.lat) * f,
        lon: p1.lon + (p2.lon - p1.lon) * f,
        timestamp: 0 
      };
      ids.add(getSegmentIdForPoint(interpPoint as any));
    }
  }

  return Array.from(ids);
}

export function getSegmentIdForPoints(points: Iterable<TimelinePoint>): Record<number, TimelinePoint[]> {
  const segments: Record<number, TimelinePoint[]> = {};
  for (const point of points) {
    const segmentId = getSegmentIdForPoint(point);
    if (!segments[segmentId]) {
      segments[segmentId] = [];
    }
    segments[segmentId].push(point);
  }
  return segments;
}
