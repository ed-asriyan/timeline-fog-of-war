import { MapSegment, MapSegmentRepository } from "../../domains/map/ports";

const DEFAULT_MAX_SEGMENTS = 4096;
const DEFAULT_MAX_ENTRIES = 1_000_000;

/**
 * Keeps recently read segments in memory so that panning the map does not go
 * back to IndexedDB, and through the structured clone, for data it just had.
 *
 * Segments are handed out by reference rather than copied: loadPoints() adds
 * to the segments it is given and writes the changed ones back, and every
 * write updates the cached entry, so the cache never holds a version the store
 * does not have. A failed write drops the entries it touched instead.
 *
 * Eviction is least-recently-used, bounded both by the number of segments and
 * by the number of points and paths in them, since one segment can hold as
 * much as thousands of others.
 */
export class CachedMapSegmentRepository implements MapSegmentRepository {
    private readonly inner: MapSegmentRepository;
    private readonly maxSegments: number;
    private readonly maxEntries: number;

    /** Insertion order is the LRU order: the oldest entry is the first key. */
    private readonly cache = new Map<number, MapSegment>();
    private entries = 0;

    constructor(
        inner: MapSegmentRepository,
        maxSegments: number = DEFAULT_MAX_SEGMENTS,
        maxEntries: number = DEFAULT_MAX_ENTRIES,
    ) {
        this.inner = inner;
        this.maxSegments = maxSegments;
        this.maxEntries = maxEntries;
    }

    async loadSegments(ids: number[]): Promise<MapSegment[]> {
        const bySegmentId = new Map<number, MapSegment>();
        const missing = new Set<number>();

        for (const id of ids) {
            const cached = this.cache.get(id);
            if (cached) {
                this.touch(id, cached);
                bySegmentId.set(id, cached);
            } else {
                missing.add(id);
            }
        }

        if (missing.size > 0) {
            for (const segment of await this.inner.loadSegments(Array.from(missing))) {
                bySegmentId.set(segment.index, segment);
                this.remember(segment);
            }
        }

        // Same contract as the store: one entry per requested id, in order.
        return ids.map(id => bySegmentId.get(id) ?? { index: id, group: { points: [], paths: [] } });
    }

    async saveSegments(segments: MapSegment[]): Promise<void> {
        try {
            await this.inner.saveSegments(segments);
        } catch (error) {
            for (const segment of segments) this.forget(segment.index);
            throw error;
        }
        for (const segment of segments) this.remember(segment);
    }

    async clear(): Promise<void> {
        this.cache.clear();
        this.entries = 0;
        await this.inner.clear();
    }

    async hasData(): Promise<boolean> {
        return this.inner.hasData();
    }

    private static weigh(segment: MapSegment): number {
        return segment.group.points.length + segment.group.paths.length;
    }

    private touch(id: number, segment: MapSegment): void {
        this.cache.delete(id);
        this.cache.set(id, segment);
    }

    private forget(id: number): void {
        const held = this.cache.get(id);
        if (!held) return;
        this.entries -= CachedMapSegmentRepository.weigh(held);
        this.cache.delete(id);
    }

    private remember(segment: MapSegment): void {
        this.forget(segment.index);
        this.cache.set(segment.index, segment);
        this.entries += CachedMapSegmentRepository.weigh(segment);
        this.evict();
    }

    private evict(): void {
        // Always keep the newest entry, even one bigger than the whole budget.
        while (this.cache.size > 1 && (this.cache.size > this.maxSegments || this.entries > this.maxEntries)) {
            const oldest = this.cache.keys().next();
            if (oldest.done) return;
            this.forget(oldest.value);
        }
    }
}
