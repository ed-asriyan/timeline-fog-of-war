import { MapSegmentRepository, MapSegment, TimelinePoint, TimelinePath } from "../../domains/map/ports";
import { PathDeduplicator, PointDeduplicator } from "../../domains/map/dedup";
import { getSegmentIdForPoints, getSegmentIdsForPath } from "../../domains/map/grid";

export class IndexedDbMapSegmentRepository implements MapSegmentRepository {
    private static readonly dbName = 'TimelineMapDB';
    private static readonly storeName = 'MapSegments';
    static dbVersion = 3;

    private db: IDBDatabase;

    private constructor(db: IDBDatabase) {
        this.db = db;
    }



    async saveSegments(segments: MapSegment[]): Promise<void> {
        if (segments.length === 0) return;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readwrite');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

            for (const segment of segments) {
                const record = {
                    id: segment.index,
                    points: segment.group.points.map(p => ({ lat: p.lat, lon: p.lon, timestamp: p.timestamp })),
                    paths: segment.group.paths.map(p => ({ points: p.points.map(pt => ({ lat: pt.lat, lon: pt.lon, timestamp: pt.timestamp })) })),
                };
                store.put(record);
            }
        });
    }

    async loadSegments(ids: number[]): Promise<MapSegment[]> {
        if (ids.length === 0) return [];
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readonly');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            // Always emit one entry per requested id (placeholder if missing), same contract as the old loadSegment.
            const foundById = new Map<number, MapSegment>();

            tx.oncomplete = () => resolve(ids.map(id => foundById.get(id) ?? { index: id, group: { points: [], paths: [] } }));
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));

            if (ids.length > 10000) {
                // If requesting too many IDs, it's faster to cursor through all existing data
                // and check if they are in the requested set.
                const idSet = new Set(ids);
                const req = store.openCursor();
                req.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                    if (cursor) {
                        const record = cursor.value;
                        if (idSet.has(record.id)) {
                            foundById.set(record.id, {
                                index: record.id,
                                group: { points: record.points ?? [], paths: record.paths ?? [] }
                            });
                        }
                        cursor.continue();
                    }
                };
            } else {
                for (const id of ids) {
                    const req = store.get(id);
                    req.onsuccess = () => {
                        const record = req.result;
                        if (record) {
                            foundById.set(id, {
                                index: record.id,
                                group: { points: record.points ?? [], paths: record.paths ?? [] }
                            });
                        }
                    };
                }
            }
        });
    }

    async clear(): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readwrite');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            const req = store.clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async hasData(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readonly');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            const req = store.count();
            req.onsuccess = () => resolve(req.result > 0);
            req.onerror = () => reject(req.error);
        });
    }

    private async reprocessAllData(): Promise<void> {
        const allRecords: Array<{ id: number; points: TimelinePoint[]; paths: TimelinePath[] }> =
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readonly');
                const req = tx.objectStore(IndexedDbMapSegmentRepository.storeName).getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

        // Everything imported before the near-duplicate filtering existed is
        // put through it once here. Paths are stored once per segment they
        // cross, so this also collapses those copies back into one path.
        const seenPoints = new PointDeduplicator();
        const allPoints: TimelinePoint[] = allRecords
            .flatMap(r => r.points ?? [])
            .filter(point => seenPoints.add(point));

        const seenPaths = new PathDeduplicator();
        const allPaths: TimelinePath[] = allRecords
            .flatMap(r => r.paths ?? [])
            .filter(path => seenPaths.add(path));

        const pointsBySegment = getSegmentIdForPoints(allPoints);

        const pathsBySegment: Record<number, TimelinePath[]> = {};
        for (const path of allPaths) {
            for (const segmentId of getSegmentIdsForPath(path)) {
                if (!pathsBySegment[segmentId]) pathsBySegment[segmentId] = [];
                pathsBySegment[segmentId].push(path);
            }
        }

        const allSegmentIds = new Set([
            ...Object.keys(pointsBySegment).map(Number),
            ...Object.keys(pathsBySegment).map(Number),
        ]);

        await new Promise<void>((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readwrite');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            store.clear();
            for (const segmentId of allSegmentIds) {
                store.put({
                    id: segmentId,
                    points: pointsBySegment[segmentId] ?? [],
                    paths: pathsBySegment[segmentId] ?? [],
                });
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    static async openDb(): Promise<IndexedDbMapSegmentRepository> {
        return new Promise((resolve, reject) => {
            let needsMigration = false;
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                const oldVersion = event.oldVersion;

                if (oldVersion < 1) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
                if (oldVersion >= 1 && oldVersion < 3) {
                    // v2 re-segmented the data, v3 drops near-duplicates;
                    // both are the same full re-write.
                    needsMigration = true;
                }
            };

            request.onsuccess = () => {
                const repo = new IndexedDbMapSegmentRepository(request.result as IDBDatabase);
                if (needsMigration) {
                    repo.reprocessAllData().then(() => resolve(repo)).catch(reject);
                } else {
                    resolve(repo);
                }
            };

            request.onerror = () => {
                reject(request.error);
            };
        });
    }
}
