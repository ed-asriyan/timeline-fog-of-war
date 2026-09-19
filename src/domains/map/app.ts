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
import { PathDeduplicator, PointDeduplicator } from './dedup';
import { getSegmentIdsForBound, getSegmentIdsForPath, getSegmentIdForPoints } from './grid';

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
    const pathSegmentIds = group.paths.map(path => getSegmentIdsForPath(path));
    const pointsBySegment = getSegmentIdForPoints(group.points);

    // Get all unique segment IDs that we need to update
    const allSegmentIds = new Set(Object.keys(pointsBySegment).map(Number));
    for (const segmentIds of pathSegmentIds) {
      for (const segmentId of segmentIds) allSegmentIds.add(segmentId);
    }

    onProgress?.('saving', 10);
    const loadedSegments = await this.segments.loadSegments(Array.from(allSegmentIds));
    // Keyed by id rather than a global Map, which this class shadows.
    const segmentById: Record<number, MapSegment> = {};
    for (const segment of loadedSegments) segmentById[segment.index] = segment;
    const changedSegments = new Set<number>();

    // Near-duplicates carry no information for the fog, so they are dropped on
    // import rather than stored and re-filtered on every viewport query. Both
    // deduplicators are seeded with what is already stored, so re-importing an
    // overlapping export adds nothing.
    const seenPaths = new PathDeduplicator();
    for (const segment of loadedSegments) {
      for (const path of segment.group.paths) seenPaths.add(path);
    }

    for (let i = 0; i < group.paths.length; i++) {
      if (i % 1000 === 0) onProgress?.('saving', 10 + (i / group.paths.length) * 40);
      const path = group.paths[i];
      if (!seenPaths.add(path)) continue;

      for (const segmentId of pathSegmentIds[i]) {
        const segment = segmentById[segmentId];
        if (!segment) continue;
        segment.group.paths.push(path);
        changedSegments.add(segmentId);
      }
    }

    // Points live in exactly one segment, so they are de-duplicated per
    // segment and the index is thrown away as soon as the segment is done.
    const segmentIdsWithPoints = Object.keys(pointsBySegment).map(Number);
    for (let i = 0; i < segmentIdsWithPoints.length; i++) {
      if (i % 100 === 0) onProgress?.('saving', 50 + (i / segmentIdsWithPoints.length) * 40);
      const segmentId = segmentIdsWithPoints[i];
      const segment = segmentById[segmentId];
      if (!segment) continue;

      const seenPoints = new PointDeduplicator();
      for (const point of segment.group.points) seenPoints.add(point);

      for (const point of pointsBySegment[segmentId]) {
        if (!seenPoints.add(point)) continue;
        segment.group.points.push(point);
        changedSegments.add(segmentId);
      }
    }

    await this.segments.saveSegments(loadedSegments.filter(segment => changedSegments.has(segment.index)));
    onProgress?.('saving', 100);

    return lastPoint;
  }

  async clear(): Promise<void> {
    await this.segments.clear();
  }

  async getData(bounds: Bounds): Promise<{ points: TimelinePoint[]; paths: TimelinePath[] }> {
    const segmentIds = getSegmentIdsForBound(bounds);
    const settings = await this.settings.loadSettings();
    const points: TimelinePoint[] = [];
    const paths: TimelinePath[] = [];
    // Every segment holds a full copy of the paths crossing it, so the same
    // path comes back once per segment it touches. Points need no such pass:
    // each one lives in a single segment and is filtered on import.
    const seenPaths = new PathDeduplicator();

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
    const segmentIds = getSegmentIdsForBound(bounds);
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
