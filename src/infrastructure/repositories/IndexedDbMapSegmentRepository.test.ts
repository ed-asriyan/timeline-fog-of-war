import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { IndexedDbMapSegmentRepository } from './IndexedDbMapSegmentRepository';
import { getSegmentIdForPoint } from '../../domains/map/grid';
import { DETAIL_LEVELS, getSegmentIdForLevel } from '../../domains/map/lod';
import { TimelinePath, TimelinePoint } from '../../domains/map/ports';

const DB_NAME = 'TimelineMapDB';
const STORE_NAME = 'MapSegments';

const T0 = Date.UTC(2024, 9, 5, 12, 0, 0);
const point = (lat: number, lon: number, timestamp = T0): TimelinePoint => ({ lat, lon, timestamp });

/** ~11 m in degrees of latitude, inside the 20 m threshold. */
const CLOSE_DEG = 0.0001;

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Writes a database in the pre-deduplication schema. */
function seedLegacyDb(records: Array<{ id: number; points: TimelinePoint[]; paths: TimelinePath[] }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      for (const record of records) tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

describe('IndexedDbMapSegmentRepository migration', () => {
  let opened: IndexedDbMapSegmentRepository[] = [];

  const openRepo = async () => {
    const repo = await IndexedDbMapSegmentRepository.openDb();
    opened.push(repo);
    return repo;
  };

  beforeEach(async () => {
    await deleteDb();
  });

  afterEach(() => {
    // An open connection makes deleteDatabase() hang, so drop them between tests.
    for (const repo of opened) (repo as unknown as { db: IDBDatabase }).db.close();
    opened = [];
  });

  it('drops near-duplicates left over from earlier imports', async () => {
    const home = point(47.62, -122.35);
    const work = point(47.65, -122.30);
    const segmentId = getSegmentIdForPoint(home);

    await seedLegacyDb([
      {
        id: segmentId,
        points: [home, point(home.lat + CLOSE_DEG, home.lon, T0 + 60_000), point(47.63, -122.35)],
        paths: [
          { points: [home, work] },
          { points: [point(home.lat + CLOSE_DEG, home.lon), work] },
          { points: [work, home] }, // the way back
        ],
      },
    ]);

    const repo = await openRepo();
    const [segment] = await repo.loadSegments([segmentId]);

    expect(segment.group.points).toHaveLength(2);
    expect(segment.group.paths).toHaveLength(1);
  });

  it('keeps one copy of a path that was stored in several segments', async () => {
    const start = point(47.62, -122.35);
    const end = point(47.72, -122.35, T0 + 30 * 60_000);
    const path = { points: [start, end] };
    const startSegment = getSegmentIdForPoint(start);
    const endSegment = getSegmentIdForPoint(end);

    await seedLegacyDb([
      { id: startSegment, points: [start], paths: [path] },
      { id: endSegment, points: [end], paths: [path] },
    ]);

    const repo = await openRepo();
    const segments = await repo.loadSegments([startSegment, endSegment]);

    // Still stored in both segments it crosses, but only once in each.
    expect(segments.map(s => s.group.paths.length)).toEqual([1, 1]);
    expect(segments.flatMap(s => s.group.points)).toHaveLength(2);
  });
});

describe('IndexedDbMapSegmentRepository levels of detail', () => {
  let opened: IndexedDbMapSegmentRepository[] = [];

  beforeEach(async () => {
    await deleteDb();
  });

  afterEach(() => {
    for (const repo of opened) (repo as unknown as { db: IDBDatabase }).db.close();
    opened = [];
  });

  it('fills the coarser levels from data that predates them', async () => {
    // 60 points 20 m apart, written the old way with no levels at all.
    const points = Array.from({ length: 60 }, (_, i) => point(47.62 + i * 2 * CLOSE_DEG, -122.35, T0 + i * 60_000));
    const segmentId = getSegmentIdForPoint(points[0]);
    await seedLegacyDb([{ id: segmentId, points, paths: [] }]);

    const repo = await IndexedDbMapSegmentRepository.openDb();
    opened.push(repo);

    const kept: number[] = [];
    for (let level = 0; level < DETAIL_LEVELS.length; level++) {
      const [segment] = await repo.loadSegments([getSegmentIdForLevel(level, segmentId)]);
      kept.push(segment.group.points.length);
    }

    expect(kept[0]).toBe(60);
    for (let level = 1; level < kept.length; level++) {
      expect(kept[level]).toBeLessThan(kept[level - 1]);
      expect(kept[level]).toBeGreaterThan(0);
    }
  });
});
