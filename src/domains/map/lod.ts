import { MIN_DISTANCE_KM, PathDeduplicator, PointDeduplicator } from './dedup';
import { LAT_STEP_COUNTS, LON_STEP_COUNTS, getSegmentIdForPoints, getSegmentIdsForPath } from './grid';
import { Group, TimelinePath, TimelinePoint } from './ports';

/**
 * How far apart the points kept at each level of detail are. Level 0 is the
 * data as imported; each coarser level is a thinned copy of the one before it,
 * so a zoomed-out view reads a few thousand points instead of a few hundred
 * thousand that land on the same pixels.
 */
export const DETAIL_LEVELS: readonly number[] = [MIN_DISTANCE_KM, 0.1, 0.5, 2.5];

/** Coarser copies of a segment are stored under ids above every real one. */
const LEVEL_STRIDE = LAT_STEP_COUNTS * LON_STEP_COUNTS;

/**
 * The coarsest level whose points are still closer together than one screen
 * pixel, so what it drops cannot be seen. Below the finest level's spacing
 * there is nothing coarser to gain, and level 0 is used.
 */
export function getDetailLevel(resolutionKm: number): number {
  let level = 0;
  for (let i = 1; i < DETAIL_LEVELS.length; i++) {
    if (DETAIL_LEVELS[i] <= resolutionKm) level = i;
  }
  return level;
}

/** Where the copy of a segment for this level of detail is stored. */
export function getSegmentIdForLevel(level: number, segmentId: number): number {
  return level * LEVEL_STRIDE + segmentId;
}

/** The segment a stored id belongs to, whichever level it holds. */
export function getBaseSegmentId(storedId: number): number {
  return storedId % LEVEL_STRIDE;
}

/** Which level of detail a stored id holds. */
export function getLevelForSegmentId(storedId: number): number {
  return Math.floor(storedId / LEVEL_STRIDE);
}

export interface DetailLevelOptions {
  /** Segment ids of each path, in the same order. Computed here when absent. */
  pathSegmentIds?: number[][];
  /** What a stored segment already holds, so its level is not filled twice. */
  existing?: (storedId: number) => Group | undefined;
  /** Stored segments to seed the path filter from, beyond those the paths touch. */
  seedSegmentIds?: Iterable<number>;
  onProgress?: (fraction: number) => void;
}

/**
 * Spreads points and paths across the levels of detail and returns what each
 * stored segment gains, keyed by stored segment id.
 *
 * Levels cascade: what a level drops as too close to something it kept is
 * already represented there, so the coarser level never looks at it again.
 * That is what keeps building every level from costing as much as the first
 * one over again.
 *
 * Points are filtered per segment and paths across the whole run, matching how
 * each is stored: a point lives in one segment, a path in every segment it
 * crosses.
 */
export function buildDetailLevels(
  points: TimelinePoint[],
  paths: TimelinePath[],
  options: DetailLevelOptions = {},
): Record<number, Group> {
  const existing = options.existing ?? (() => undefined);
  const additions: Record<number, Group> = {};

  const gain = (storedId: number): Group => {
    let group = additions[storedId];
    if (!group) {
      group = { points: [], paths: [] };
      additions[storedId] = group;
    }
    return group;
  };

  let levelPoints = points;
  let levelPaths = paths;
  let levelPathSegmentIds = options.pathSegmentIds ?? paths.map(path => getSegmentIdsForPath(path));

  for (let level = 0; level < DETAIL_LEVELS.length && (levelPoints.length > 0 || levelPaths.length > 0); level++) {
    const minDistanceKm = DETAIL_LEVELS[level];
    const progressBase = level / DETAIL_LEVELS.length;
    const progressShare = 1 / DETAIL_LEVELS.length;

    const seenPaths = new PathDeduplicator(minDistanceKm);
    const seeded = new Set<number>();
    const seed = (segmentId: number) => {
      const storedId = getSegmentIdForLevel(level, segmentId);
      if (seeded.has(storedId)) return;
      seeded.add(storedId);
      const stored = existing(storedId);
      if (stored) for (const path of stored.paths) seenPaths.add(path);
      for (const path of additions[storedId]?.paths ?? []) seenPaths.add(path);
    };
    for (const segmentId of options.seedSegmentIds ?? []) seed(segmentId);
    for (const segmentIds of levelPathSegmentIds) for (const segmentId of segmentIds) seed(segmentId);

    const acceptedPaths: TimelinePath[] = [];
    const acceptedPathSegmentIds: number[][] = [];
    for (let i = 0; i < levelPaths.length; i++) {
      if (i % 1000 === 0) options.onProgress?.(progressBase + (i / levelPaths.length) * progressShare * 0.5);
      if (!seenPaths.add(levelPaths[i])) continue;

      acceptedPaths.push(levelPaths[i]);
      acceptedPathSegmentIds.push(levelPathSegmentIds[i]);
      for (const segmentId of levelPathSegmentIds[i]) {
        gain(getSegmentIdForLevel(level, segmentId)).paths.push(levelPaths[i]);
      }
    }

    const pointsBySegment = getSegmentIdForPoints(levelPoints);
    const segmentIds = Object.keys(pointsBySegment).map(Number);
    const acceptedPoints: TimelinePoint[] = [];

    for (let i = 0; i < segmentIds.length; i++) {
      if (i % 100 === 0) {
        options.onProgress?.(progressBase + progressShare * (0.5 + (i / segmentIds.length) * 0.5));
      }
      const storedId = getSegmentIdForLevel(level, segmentIds[i]);
      const seenPoints = new PointDeduplicator(minDistanceKm);
      for (const point of existing(storedId)?.points ?? []) seenPoints.add(point);
      for (const point of additions[storedId]?.points ?? []) seenPoints.add(point);

      for (const point of pointsBySegment[segmentIds[i]]) {
        if (!seenPoints.add(point)) continue;
        gain(storedId).points.push(point);
        acceptedPoints.push(point);
      }
    }

    levelPoints = acceptedPoints;
    levelPaths = acceptedPaths;
    levelPathSegmentIds = acceptedPathSegmentIds;
  }

  return additions;
}
