import { Bounds, TimelinePoint } from "./ports";

export const LAT_STEP_COUNTS: number = 1800;
export const LON_STEP_COUNTS: number = 3600;

export function getSegmentIdsForBound(bounds: Bounds): number[] {
  const minLat = Math.min(bounds.a.lat, bounds.b.lat);
  const maxLat = Math.max(bounds.a.lat, bounds.b.lat);
  const minLon = Math.min(bounds.a.lon, bounds.b.lon);
  const maxLon = Math.max(bounds.a.lon, bounds.b.lon);

  let startLatIndex = Math.floor((minLat + 90) * 10);
  let endLatIndex = Math.floor((maxLat + 90) * 10);
  let startLonIndex = Math.floor((minLon + 180) * 10);
  let endLonIndex = Math.floor((maxLon + 180) * 10);

  if (startLatIndex >= LAT_STEP_COUNTS) startLatIndex = LAT_STEP_COUNTS - 1;
  if (endLatIndex >= LAT_STEP_COUNTS) endLatIndex = LAT_STEP_COUNTS - 1;
  if (startLonIndex >= LON_STEP_COUNTS) startLonIndex = LON_STEP_COUNTS - 1;
  if (endLonIndex >= LON_STEP_COUNTS) endLonIndex = LON_STEP_COUNTS - 1;

  if (startLatIndex < 0) startLatIndex = 0;
  if (endLatIndex < 0) endLatIndex = 0;
  if (startLonIndex < 0) startLonIndex = 0;
  if (endLonIndex < 0) endLonIndex = 0;

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
