import { MapSegment, TimelinePath, TimelinePoint } from "../../domains/map/ports";

/**
 * Coordinates are stored as integers of 1e-7 degrees, a little over a
 * centimetre, which is four bytes instead of eight and well past the accuracy
 * of anything that produced them.
 */
const COORDINATE_SCALE = 1e7;

/**
 * A segment as it is written to IndexedDB: parallel typed arrays rather than
 * an array of {lat, lon, timestamp} objects.
 *
 * The structured clone that IndexedDB runs on the way in and out then copies a
 * handful of buffers instead of building one object per point, and the record
 * is roughly a quarter of the size. Paths are flattened end to end and
 * delimited by pathStarts, which holds one offset per path plus the total.
 */
export interface SegmentRecord {
  id: number;
  pointLat: Int32Array;
  pointLon: Int32Array;
  pointTime: Float64Array;
  pathLat: Int32Array;
  pathLon: Int32Array;
  pathTime: Float64Array;
  pathStarts: Uint32Array;
}

/** The shape written before segments were stored as typed arrays. */
interface LegacySegmentRecord {
  id: number;
  points?: TimelinePoint[];
  paths?: TimelinePath[];
}

export type StoredSegment = SegmentRecord | LegacySegmentRecord;

function isTypedRecord(record: StoredSegment): record is SegmentRecord {
  // ArrayBuffer.isView rather than instanceof: a value read back out of the
  // store can be a typed array built in another realm, which fails instanceof
  // while behaving like one in every other way.
  return ArrayBuffer.isView((record as SegmentRecord).pointLat);
}

/**
 * Whether a point can be stored and drawn at all. A malformed coordinate would
 * otherwise round to zero and put fog in the Gulf of Guinea.
 */
function isDrawable(point: TimelinePoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon);
}

function encodeCoordinate(degrees: number): number {
  return Math.round(degrees * COORDINATE_SCALE);
}

function decodeCoordinate(stored: number): number {
  return stored / COORDINATE_SCALE;
}

export function encodeSegment(segment: MapSegment): SegmentRecord {
  const points = segment.group.points.filter(isDrawable);
  // A path of fewer than two points draws nothing, and one with a malformed
  // vertex cannot be repaired by dropping the vertex.
  const paths = segment.group.paths.filter(path => path.points.length > 1 && path.points.every(isDrawable));

  const pointLat = new Int32Array(points.length);
  const pointLon = new Int32Array(points.length);
  const pointTime = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    pointLat[i] = encodeCoordinate(points[i].lat);
    pointLon[i] = encodeCoordinate(points[i].lon);
    pointTime[i] = points[i].timestamp;
  }

  let vertices = 0;
  for (const path of paths) vertices += path.points.length;

  const pathLat = new Int32Array(vertices);
  const pathLon = new Int32Array(vertices);
  const pathTime = new Float64Array(vertices);
  const pathStarts = new Uint32Array(paths.length + 1);

  let next = 0;
  for (let p = 0; p < paths.length; p++) {
    pathStarts[p] = next;
    for (const vertex of paths[p].points) {
      pathLat[next] = encodeCoordinate(vertex.lat);
      pathLon[next] = encodeCoordinate(vertex.lon);
      pathTime[next] = vertex.timestamp;
      next++;
    }
  }
  pathStarts[paths.length] = next;

  return { id: segment.index, pointLat, pointLon, pointTime, pathLat, pathLon, pathTime, pathStarts };
}

export function decodeSegment(record: StoredSegment): MapSegment {
  if (!isTypedRecord(record)) {
    return { index: record.id, group: { points: record.points ?? [], paths: record.paths ?? [] } };
  }

  const points: TimelinePoint[] = new Array(record.pointLat.length);
  for (let i = 0; i < record.pointLat.length; i++) {
    points[i] = {
      lat: decodeCoordinate(record.pointLat[i]),
      lon: decodeCoordinate(record.pointLon[i]),
      timestamp: record.pointTime[i],
    };
  }

  const pathCount = Math.max(record.pathStarts.length - 1, 0);
  const paths: TimelinePath[] = new Array(pathCount);
  for (let p = 0; p < pathCount; p++) {
    const from = record.pathStarts[p];
    const to = record.pathStarts[p + 1];
    const vertices: TimelinePoint[] = new Array(to - from);
    for (let i = from; i < to; i++) {
      vertices[i - from] = {
        lat: decodeCoordinate(record.pathLat[i]),
        lon: decodeCoordinate(record.pathLon[i]),
        timestamp: record.pathTime[i],
      };
    }
    paths[p] = { points: vertices };
  }

  return { index: record.id, group: { points, paths } };
}
