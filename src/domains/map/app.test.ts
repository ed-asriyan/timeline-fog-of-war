import { describe, it, expect, beforeEach } from 'vitest';
import { Map as MapApp } from './app';
import { calculateDistance } from './geometry';
import {
  Group,
  MapSegment,
  MapSegmentRepository,
  ParserPort,
  Settings,
  SettingsRepository,
  TimelinePoint,
} from './ports';
import { getSegmentIdForPoint } from './grid';
import { DETAIL_LEVELS, getLevelForSegmentId } from './lod';

/** ~11 m and ~33 m in degrees of latitude, either side of the 20 m threshold. */
const CLOSE_DEG = 0.0001;
const FAR_DEG = 0.0003;

/** Real timestamps matter: getData() splits a path that implies an absurd speed. */
const T0 = Date.UTC(2024, 9, 5, 12, 0, 0);
const minutes = (n: number) => T0 + n * 60_000;

const point = (lat: number, lon: number, timestamp = T0): TimelinePoint => ({ lat, lon, timestamp });

class MemorySegmentRepository implements MapSegmentRepository {
  readonly stored = new Map<number, MapSegment>();
  savedIds: number[][] = [];

  async saveSegments(segments: MapSegment[]): Promise<void> {
    this.savedIds.push(segments.map(segment => segment.index));
    for (const segment of segments) {
      this.stored.set(segment.index, structuredClone(segment));
    }
  }

  async loadSegments(ids: number[]): Promise<MapSegment[]> {
    // Mirrors IndexedDb: one entry per requested id, detached from what is stored.
    return ids.map(id => {
      const segment = this.stored.get(id);
      return segment ? structuredClone(segment) : { index: id, group: { points: [], paths: [] } };
    });
  }

  async clear(): Promise<void> {
    this.stored.clear();
  }

  async hasData(): Promise<boolean> {
    return this.stored.size > 0;
  }

  /** Level 0 is the data as imported; coarser levels are thinned copies. */
  allPoints(level = 0): TimelinePoint[] {
    return this.atLevel(level).flatMap(segment => segment.group.points);
  }

  pathCount(level = 0): number {
    // Paths are copied into every segment they cross; count each one once.
    return new Set(
      this.atLevel(level).flatMap(segment =>
        segment.group.paths.map(path => JSON.stringify(path.points)),
      ),
    ).size;
  }

  private atLevel(level: number) {
    return [...this.stored.values()].filter(segment => getLevelForSegmentId(segment.index) === level);
  }
}

/** Takes the group itself as its input, so tests do not go through a real format. */
const parser: ParserPort = { parse: (data: string) => JSON.parse(data) as Group };

const settingsRepository: SettingsRepository = {
  async saveSettings(): Promise<void> {},
  async loadSettings(): Promise<Settings> {
    return { maxPathDistanceKm: 1000, maxPathVelocityKmh: 100000 };
  },
};

const bounds = { a: { lat: 47.5, lon: -122.5 }, b: { lat: 47.8, lon: -122.2 } };

describe('Map.loadPoints', () => {
  let segments: MemorySegmentRepository;
  let app: MapApp;

  beforeEach(() => {
    segments = new MemorySegmentRepository();
    app = new MapApp(segments, parser, settingsRepository);
  });

  const load = (group: Group) => app.loadPoints(JSON.stringify(group));

  it('keeps only one of a cluster of points closer than 20 m', async () => {
    await load({
      points: [
        point(47.62, -122.35, minutes(1)),
        point(47.62 + CLOSE_DEG, -122.35, minutes(2)),
        point(47.62, -122.35 + CLOSE_DEG, minutes(3)),
        point(47.62 + FAR_DEG, -122.35, minutes(4)),
      ],
      paths: [],
    });

    expect(segments.allPoints()).toHaveLength(2);
  });

  it('de-duplicates against points imported earlier', async () => {
    await load({ points: [point(47.62, -122.35, minutes(1))], paths: [] });
    await load({ points: [point(47.62 + CLOSE_DEG, -122.35, minutes(2))], paths: [] });

    expect(segments.allPoints()).toHaveLength(1);
    expect(segments.allPoints()[0].timestamp).toBe(minutes(1));
  });

  it('keeps only one of two paths whose endpoints match pairwise', async () => {
    const start = point(47.62, -122.35, minutes(1));
    const end = point(47.65, -122.30, minutes(2));

    await load({
      points: [],
      paths: [
        { points: [start, end] },
        { points: [point(start.lat + CLOSE_DEG, start.lon, minutes(3)), point(end.lat, end.lon, minutes(4))] },
        { points: [point(end.lat, end.lon, minutes(5)), point(start.lat, start.lon, minutes(6))] }, // the way back
        { points: [start, point(end.lat + FAR_DEG, end.lon, minutes(7))] },
      ],
    });

    expect(segments.pathCount()).toBe(2);
  });

  it('writes nothing when the same export is imported twice', async () => {
    const group: Group = {
      points: [point(47.62, -122.35, minutes(1))],
      paths: [{ points: [point(47.62, -122.35, minutes(1)), point(47.65, -122.30, minutes(2))] }],
    };

    await load(group);
    const pointsAfterFirst = segments.allPoints().length;
    const pathsAfterFirst = segments.pathCount();

    segments.savedIds = [];
    await load(group);

    expect(segments.savedIds).toEqual([[]]);
    expect(segments.allPoints()).toHaveLength(pointsAfterFirst);
    expect(segments.pathCount()).toBe(pathsAfterFirst);
  });

  it('does not create empty segments for data that was dropped', async () => {
    const path = { points: [point(47.62, -122.35, minutes(1)), point(47.65, -122.30, minutes(2))] };
    await load({ points: [], paths: [path] });
    const touched = segments.stored.size;

    await load({ points: [], paths: [path] });

    expect(segments.stored.size).toBe(touched);
    expect([...segments.stored.values()].every(s => s.group.points.length + s.group.paths.length > 0)).toBe(true);
  });

  it('thins the data into a copy per level of detail', async () => {
    // 60 points in a 600 m line: 20 m apart, so every level keeps fewer.
    const points = Array.from({ length: 60 }, (_, i) => point(47.62 + i * 2 * CLOSE_DEG, -122.35, minutes(i)));
    await load({ points, paths: [] });

    const kept = DETAIL_LEVELS.map((_, level) => segments.allPoints(level).length);

    expect(kept[0]).toBe(60);
    for (let level = 1; level < kept.length; level++) {
      expect(kept[level]).toBeLessThan(kept[level - 1]);
      expect(kept[level]).toBeGreaterThan(0);
    }
  });

  it('keeps every level at least its own spacing apart', async () => {
    const points = Array.from({ length: 60 }, (_, i) => point(47.62 + i * 2 * CLOSE_DEG, -122.35, minutes(i)));
    await load({ points, paths: [] });

    for (let level = 0; level < DETAIL_LEVELS.length; level++) {
      const kept = segments.allPoints(level).sort((a, b) => a.lat - b.lat);
      for (let i = 1; i < kept.length; i++) {
        expect(calculateDistance(kept[i - 1], kept[i])).toBeGreaterThanOrEqual(DETAIL_LEVELS[level]);
      }
    }
  });

  it('still reports the most recent location of the import', async () => {
    const last = await load({
      points: [point(47.62, -122.35, minutes(10)), point(47.62 + CLOSE_DEG, -122.35, minutes(20))],
      paths: [],
    });

    // The newest point wins even when it is the one dropped as a duplicate:
    // the map centres on where the user actually was last.
    expect(last).toEqual({ lat: 47.62 + CLOSE_DEG, lon: -122.35 });
  });
});

describe('Map.getData', () => {
  let segments: MemorySegmentRepository;
  let app: MapApp;

  beforeEach(() => {
    segments = new MemorySegmentRepository();
    app = new MapApp(segments, parser, settingsRepository);
  });

  it('returns a near-duplicate path once', async () => {
    const start = point(47.62, -122.35, minutes(1));
    const end = point(47.63, -122.34, minutes(2));

    // Data written before import-time filtering existed.
    await segments.saveSegments([
      {
        index: getSegmentIdForPoint(start),
        group: {
          points: [],
          paths: [
            { points: [start, end] },
            { points: [point(start.lat, start.lon, minutes(5)), point(end.lat + CLOSE_DEG, end.lon, minutes(6))] },
          ],
        },
      },
    ]);

    expect((await app.getData(bounds)).paths).toHaveLength(1);
  });

  it('returns a path crossing several segments once', async () => {
    // A path is stored in full in every segment it crosses.
    const start = point(47.62, -122.35, minutes(1));
    const end = point(47.72, -122.35, minutes(30));
    const path = { points: [start, end] };

    await segments.saveSegments([
      { index: getSegmentIdForPoint(start), group: { points: [], paths: [path] } },
      { index: getSegmentIdForPoint(end), group: { points: [], paths: [path] } },
    ]);

    expect(getSegmentIdForPoint(start)).not.toBe(getSegmentIdForPoint(end));
    expect((await app.getData(bounds)).paths).toHaveLength(1);
  });

  it('reads a coarser copy when a pixel covers more ground', async () => {
    // 60 points 20 m apart along 600 m of road.
    const points = Array.from({ length: 60 }, (_, i) => point(47.62 + i * 2 * CLOSE_DEG, -122.35, minutes(i)));
    await app.loadPoints(JSON.stringify({ points, paths: [] }));

    const detailed = await app.getData(bounds, 0);
    const coarse = await app.getData(bounds, DETAIL_LEVELS[1]);
    const coarsest = await app.getData(bounds, DETAIL_LEVELS[DETAIL_LEVELS.length - 1]);

    expect(detailed.points).toHaveLength(60);
    expect(coarse.points.length).toBeLessThan(detailed.points.length);
    expect(coarsest.points.length).toBeLessThanOrEqual(coarse.points.length);
    expect(coarsest.points.length).toBeGreaterThan(0);
  });

  it('counts the same things in the statistics', async () => {
    await app.loadPoints(
      JSON.stringify({
        points: [point(47.62, -122.35, minutes(1)), point(47.62 + CLOSE_DEG, -122.35, minutes(2)), point(47.62 + FAR_DEG, -122.35, minutes(3))],
        paths: [{ points: [point(47.62, -122.35, minutes(1)), point(47.63, -122.34, minutes(2))] }],
      }),
    );

    expect(await app.getStatistics(bounds)).toEqual({ totalPoints: 2, totalPaths: 1 });
  });
});
