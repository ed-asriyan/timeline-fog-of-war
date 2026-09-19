import { describe, it, expect, beforeEach } from 'vitest';
import { CachedMapSegmentRepository } from './CachedMapSegmentRepository';
import { MapSegment, MapSegmentRepository, TimelinePoint } from '../../domains/map/ports';

const point = (lat: number): TimelinePoint => ({ lat, lon: 0, timestamp: 0 });

class CountingRepository implements MapSegmentRepository {
  readonly stored = new Map<number, MapSegment>();
  loadCalls: number[][] = [];
  saveCalls: number[][] = [];
  failNextSave = false;

  async loadSegments(ids: number[]): Promise<MapSegment[]> {
    this.loadCalls.push([...ids]);
    return ids.map(id => structuredClone(this.stored.get(id)) ?? { index: id, group: { points: [], paths: [] } });
  }

  async saveSegments(segments: MapSegment[]): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('write failed');
    }
    this.saveCalls.push(segments.map(s => s.index));
    for (const segment of segments) this.stored.set(segment.index, structuredClone(segment));
  }

  async clear(): Promise<void> {
    this.stored.clear();
  }

  async hasData(): Promise<boolean> {
    return this.stored.size > 0;
  }
}

const segment = (index: number, points: TimelinePoint[] = []): MapSegment => ({
  index,
  group: { points, paths: [] },
});

describe('CachedMapSegmentRepository', () => {
  let store: CountingRepository;
  let repo: CachedMapSegmentRepository;

  beforeEach(() => {
    store = new CountingRepository();
    repo = new CachedMapSegmentRepository(store);
  });

  it('goes to the store only for segments it does not hold', async () => {
    await store.saveSegments([segment(1, [point(1)]), segment(2, [point(2)]), segment(3, [point(3)])]);
    store.loadCalls = [];

    await repo.loadSegments([1, 2]);
    await repo.loadSegments([2, 3]);

    expect(store.loadCalls).toEqual([[1, 2], [3]]);
  });

  it('returns one entry per requested id, in order', async () => {
    await store.saveSegments([segment(7, [point(7)])]);

    const first = await repo.loadSegments([7, 9]);
    const second = await repo.loadSegments([9, 7]);

    expect(first.map(s => s.index)).toEqual([7, 9]);
    expect(second.map(s => s.index)).toEqual([9, 7]);
    expect(second[1].group.points).toHaveLength(1);
  });

  it('serves what was written without reading it back', async () => {
    await repo.saveSegments([segment(4, [point(4)])]);
    store.loadCalls = [];

    const [loaded] = await repo.loadSegments([4]);

    expect(loaded.group.points).toHaveLength(1);
    expect(store.loadCalls).toEqual([]);
  });

  it('drops what it could not write', async () => {
    await repo.loadSegments([5]);
    store.failNextSave = true;

    await expect(repo.saveSegments([segment(5, [point(5)])])).rejects.toThrow('write failed');
    await repo.loadSegments([5]);

    expect(store.loadCalls).toEqual([[5], [5]]);
  });

  it('forgets everything on clear', async () => {
    await store.saveSegments([segment(6, [point(6)])]);
    await repo.loadSegments([6]);
    store.loadCalls = [];

    await repo.clear();
    await repo.loadSegments([6]);

    expect(store.loadCalls).toEqual([[6]]);
  });

  it('evicts the least recently used segment once it is full', async () => {
    const small = new CachedMapSegmentRepository(store, 2);

    await small.loadSegments([1]);
    await small.loadSegments([2]);
    await small.loadSegments([1]); // 2 is now the oldest
    await small.loadSegments([3]);
    store.loadCalls = [];

    await small.loadSegments([1, 3]); // still held
    await small.loadSegments([2]); // evicted

    expect(store.loadCalls).toEqual([[2]]);
  });

  it('evicts by size as well as by count', async () => {
    const small = new CachedMapSegmentRepository(store, 100, 10);
    await store.saveSegments([segment(1, Array.from({ length: 8 }, (_, i) => point(i)))]);
    await store.saveSegments([segment(2, Array.from({ length: 8 }, (_, i) => point(i)))]);
    store.loadCalls = [];

    await small.loadSegments([1]);
    await small.loadSegments([2]); // pushes the total over the budget

    await small.loadSegments([2]);
    await small.loadSegments([1]);

    expect(store.loadCalls).toEqual([[1], [2], [1]]);
  });
});
