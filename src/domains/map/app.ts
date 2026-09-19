import {
  Bounds,
  LocationPoint,
  MapApp,
  MapSegment,
  MapSegmentRepository,
  ParserPort,
  Statistics,
  TimelinePoint,
  TimelinePath,
  Settings,
  SettingsRepository,
} from "./ports";
import { calculateDistance } from './geometry';
import { PathDeduplicator } from './dedup';
import { getSegmentIdsForBound, getSegmentIdsForPath, getSegmentIdForPoints } from './grid';
import { DETAIL_LEVELS, buildDetailLevels, getDetailLevel, getSegmentIdForLevel } from './lod';

export class Map implements MapApp {
  private parser: ParserPort;
  private segments: MapSegmentRepository;
  private settings: SettingsRepository;

  constructor(segments: MapSegmentRepository, parser: ParserPort, settings: SettingsRepository) {
    this.segments = segments;
    this.parser = parser;
    this.settings = settings;
  }

  async getSettings(): Promise<Settings> {
    return this.settings.loadSettings();
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.settings.saveSettings(settings);
  }

  async loadPoints(data: string, onProgress?: (status: 'parsing'|'saving', progress: number) => void): Promise<LocationPoint | null> {
    const group = this.parser.parse(data);

    let _last: TimelinePoint | null = null;
    for (const p of group.points) {
      if (!_last || p.timestamp > _last.timestamp) _last = p;
    }
    for (const path of group.paths) {
      for (const p of path.points) {
        if (!_last || p.timestamp > _last.timestamp) _last = p;
      }
    }
    const lastPoint: LocationPoint | null = _last !== null ? { lat: _last.lat, lon: _last.lon } : null;

    // A path is stored in every segment it crosses, so keep its segment ids
    // alongside it: which segments to touch is only known after the geometry.
    // The ids are the same at every level of detail, only the record differs.
    const pathSegmentIds = group.paths.map(path => getSegmentIdsForPath(path));

    const touchedSegmentIds = new Set(Object.keys(getSegmentIdForPoints(group.points)).map(Number));
    for (const segmentIds of pathSegmentIds) {
      for (const segmentId of segmentIds) touchedSegmentIds.add(segmentId);
    }

    // Read every level in one go rather than a round trip per level.
    const idsToLoad: number[] = [];
    for (let level = 0; level < DETAIL_LEVELS.length; level++) {
      for (const segmentId of touchedSegmentIds) idsToLoad.push(getSegmentIdForLevel(level, segmentId));
    }

    onProgress?.('saving', 10);
    const loadedSegments = await this.segments.loadSegments(idsToLoad);
    // Keyed by id rather than a global Map, which this class shadows.
    const segmentById: Record<number, MapSegment> = {};
    for (const segment of loadedSegments) segmentById[segment.index] = segment;

    // Near-duplicates carry no information for the fog, so they are dropped on
    // import rather than stored and re-filtered on every viewport query. The
    // builder is given what is already stored at each level, so re-importing
    // an overlapping export adds nothing.
    const additions = buildDetailLevels(group.points, group.paths, {
      pathSegmentIds,
      seedSegmentIds: touchedSegmentIds,
      existing: storedId => segmentById[storedId]?.group,
      onProgress: fraction => onProgress?.('saving', 10 + fraction * 80),
    });

    const changedSegments = new Set<number>();
    for (const key of Object.keys(additions)) {
      const storedId = Number(key);
      const segment = segmentById[storedId];
      const gained = additions[storedId];
      if (!segment || (gained.points.length === 0 && gained.paths.length === 0)) continue;

      for (const point of gained.points) segment.group.points.push(point);
      for (const path of gained.paths) segment.group.paths.push(path);
      changedSegments.add(storedId);
    }

    await this.segments.saveSegments(loadedSegments.filter(segment => changedSegments.has(segment.index)));
    onProgress?.('saving', 100);

    return lastPoint;
  }

  async clear(): Promise<void> {
    await this.segments.clear();
  }

  async getData(bounds: Bounds, resolutionKm: number = 0): Promise<{ points: TimelinePoint[]; paths: TimelinePath[] }> {
    // Reading a coarser copy where the finer one would land on the same pixels
    // is the difference between a few thousand points and a few hundred
    // thousand; below the finest spacing this is level 0, the data as imported.
    const level = getDetailLevel(resolutionKm);
    const segmentIds = getSegmentIdsForBound(bounds).map(id => getSegmentIdForLevel(level, id));
    const settings = await this.settings.loadSettings();
    const points: TimelinePoint[] = [];
    const paths: TimelinePath[] = [];
    // Every segment holds a full copy of the paths crossing it, so the same
    // path comes back once per segment it touches. Points need no such pass:
    // each one lives in a single segment and is filtered on import.
    const seenPaths = new PathDeduplicator(DETAIL_LEVELS[level]);

    const segments = await this.segments.loadSegments(segmentIds);
    for (const segment of segments) {
      if (segment && segment.group) {
        if (segment.group.points) {
          // Not points.push(...segment.group.points): spreading a segment
          // holding a few hundred thousand points blows the call stack.
          for (const point of segment.group.points) points.push(point);
        }
        if (segment.group.paths) {
          for (const path of segment.group.paths) {
            if (seenPaths.add(path)) {
              let currentSubPath = [path.points[0]];
              
              for (let i = 1; i < path.points.length; i++) {
                const prev = path.points[i - 1];
                const curr = path.points[i];
                
                const linkLength = calculateDistance(prev, curr);
                const durationHours = Math.abs(curr.timestamp - prev.timestamp) / 3600000;
                let linkVelocity = 0;
                if (durationHours > 0) {
                  linkVelocity = linkLength / durationHours;
                } else if (linkLength > 0.05) {
                  linkVelocity = Infinity;
                }

                if (linkLength > settings.maxPathDistanceKm || linkVelocity > settings.maxPathVelocityKmh) {
                  if (currentSubPath.length > 1) {
                    paths.push({ points: currentSubPath });
                  } else {
                    points.push(currentSubPath[0]);
                  }
                  currentSubPath = [curr];
                } else {
                  currentSubPath.push(curr);
                }
              }

              if (currentSubPath.length > 1) {
                paths.push({ points: currentSubPath });
              } else {
                points.push(currentSubPath[0]);
              }
            }
          }
        }
      }
    }
    
    return { points, paths };
  }

  async getStatistics(bounds: Bounds): Promise<Statistics> {
    // Level 0: statistics count what was imported, not what a zoom level draws.
    const segmentIds = getSegmentIdsForBound(bounds).map(id => getSegmentIdForLevel(0, id));
    let totalPoints = 0;
    let totalPaths = 0;

    // Counted the way getData() collects them: a path crossing several
    // segments is still one path.
    const seenPaths = new PathDeduplicator();

    const segments = await this.segments.loadSegments(segmentIds);
    for (const segment of segments) {
      if (segment && segment.group) {
        totalPoints += segment.group.points?.length || 0;
        
        if (segment.group.paths) {
          for (const path of segment.group.paths) {
            if (seenPaths.add(path)) totalPaths += 1;
          }
        }
      }
    }
    return { totalPoints, totalPaths };
  }
}
