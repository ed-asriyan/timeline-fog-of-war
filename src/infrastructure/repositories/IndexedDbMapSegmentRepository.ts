import { MapSegmentRepository, MapSegment } from "../../domains/map/ports";
import { buildDetailLevels, getLevelForSegmentId } from "../../domains/map/lod";
import { StoredSegment, decodeSegment, encodeSegment } from "./SegmentRecord";

export class IndexedDbMapSegmentRepository implements MapSegmentRepository {
    private static readonly dbName = 'TimelineMapDB';
    private static readonly storeName = 'MapSegments';
    static dbVersion = 5;

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
                store.put(encodeSegment(segment));
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
                        const record = cursor.value as StoredSegment;
                        if (idSet.has(record.id)) {
                            foundById.set(record.id, decodeSegment(record));
                        }
                        cursor.continue();
                    }
                };
            } else {
                for (const id of ids) {
                    const req = store.get(id);
                    req.onsuccess = () => {
                        const record = req.result as StoredSegment | undefined;
                        if (record) {
                            foundById.set(id, decodeSegment(record));
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
        const allRecords: StoredSegment[] = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readonly');
            const req = tx.objectStore(IndexedDbMapSegmentRepository.storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        // decodeSegment reads both the current record and the one written
        // before segments were stored as typed arrays. Level 0 holds
        // everything; the coarser levels are rebuilt from it below.
        const source = allRecords
            .map(decodeSegment)
            .filter(segment => getLevelForSegmentId(segment.index) === 0);

        // Re-segmenting, dropping near-duplicates and filling the levels of
        // detail are all the same pass: paths are stored once per segment they
        // cross, so this also collapses those copies back into one path.
        const rebuilt = buildDetailLevels(
            source.flatMap(segment => segment.group.points),
            source.flatMap(segment => segment.group.paths),
        );

        await new Promise<void>((resolve, reject) => {
            const tx = this.db.transaction(IndexedDbMapSegmentRepository.storeName, 'readwrite');
            const store = tx.objectStore(IndexedDbMapSegmentRepository.storeName);
            store.clear();
            for (const key of Object.keys(rebuilt)) {
                const storedId = Number(key);
                store.put(encodeSegment({ index: storedId, group: rebuilt[storedId] }));
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
                if (oldVersion >= 1 && oldVersion < 5) {
                    // v2 re-segmented the data, v3 dropped near-duplicates, v4
                    // changed the record layout and v5 added the coarser levels
                    // of detail; all are the same full re-write, so one pass
                    // covers however far behind the store is.
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
