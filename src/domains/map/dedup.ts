import { calculateDistance } from './geometry';
import { TimelinePath, TimelinePoint } from './ports';

/**
 * Locations closer than this are treated as the same place. Anything inside
 * 20 m is well below the smallest fog radius, so a second point there uncovers
 * nothing new and a second path between the same two places draws the same line.
 */
export const MIN_DISTANCE_KM = 0.02;

const DEG_TO_RAD = Math.PI / 180;
/** One degree of latitude on the sphere calculateDistance() assumes (R = 6371 km). */
const KM_PER_LAT_DEGREE = (6371 * Math.PI) / 180;

interface Located {
  lat: number;
  lon: number;
}

/** Longitude folded into [0, 360), so the antimeridian is not a discontinuity. */
function normalizeLon(lon: number): number {
  const shifted = (lon + 180) % 360;
  return shifted < 0 ? shifted + 360 : shifted;
}

/**
 * Uniform grid whose cells are never smaller than `cellSizeKm` in either
 * direction, so everything within that distance of a location sits in one of
 * the nine cells around it — the usual spatial-hash trick that keeps the
 * expensive haversine out of the O(n^2) comparison.
 *
 * Longitude cells are widened by 1/cos(lat) so they stay ~`cellSizeKm` across
 * on the ground instead of collapsing towards the poles. The widening uses the
 * centre of the latitude band rather than the item's own latitude, so every
 * item in a band agrees on where the cell borders are.
 */
class SpatialBuckets<T extends Located> {
  private readonly bands = new Map<number, Map<number, T[]>>();
  private readonly latStepDeg: number;

  constructor(cellSizeKm: number) {
    this.latStepDeg = cellSizeKm / KM_PER_LAT_DEGREE;
  }

  insert(item: T): void {
    const latCell = this.latCell(item.lat);
    let band = this.bands.get(latCell);
    if (!band) {
      band = new Map();
      this.bands.set(latCell, band);
    }
    const lonCell = this.lonCell(item.lon, latCell);
    const bucket = band.get(lonCell);
    if (bucket) {
      bucket.push(item);
    } else {
      band.set(lonCell, [item]);
    }
  }

  /**
   * Visits every indexed item that may be within one cell of `location`,
   * stopping early as soon as `visit` returns false.
   */
  forEachNeighbour(location: Located, visit: (item: T) => boolean): void {
    const latCell = this.latCell(location.lat);

    for (let dLat = -1; dLat <= 1; dLat++) {
      const bandCell = latCell + dLat;
      const band = this.bands.get(bandCell);
      if (!band) continue;

      const cellCount = this.lonCellCount(bandCell);
      if (cellCount <= 3) {
        // Polar bands are no wider than the neighbourhood itself, so the
        // wrapped cells would overlap: just scan the whole band.
        for (const bucket of band.values()) {
          for (const item of bucket) {
            if (!visit(item)) return;
          }
        }
        continue;
      }

      const centre = this.lonCell(location.lon, bandCell);
      for (let dLon = -1; dLon <= 1; dLon++) {
        // Longitude wraps: the cells either side of the antimeridian are neighbours.
        const bucket = band.get((centre + dLon + cellCount) % cellCount);
        if (!bucket) continue;
        for (const item of bucket) {
          if (!visit(item)) return;
        }
      }
    }
  }

  private latCell(lat: number): number {
    return Math.floor(lat / this.latStepDeg);
  }

  private lonStepDeg(latCell: number): number {
    const bandLat = (latCell + 0.5) * this.latStepDeg;
    const cos = Math.cos(bandLat * DEG_TO_RAD);
    // A degree of longitude shrinks to nothing at the poles; cap the step at a
    // full turn so a polar band collapses into a single cell instead of NaN.
    return Math.min(this.latStepDeg / Math.max(cos, Number.EPSILON), 360);
  }

  private lonCellCount(latCell: number): number {
    return Math.max(1, Math.ceil(360 / this.lonStepDeg(latCell)));
  }

  private lonCell(lon: number, latCell: number): number {
    const cell = Math.floor(normalizeLon(lon) / this.lonStepDeg(latCell));
    return Math.min(cell, this.lonCellCount(latCell) - 1);
  }
}

/**
 * Keeps the first point of every cluster of points closer than `minDistanceKm`
 * and rejects the rest.
 */
export class PointDeduplicator {
  private readonly buckets: SpatialBuckets<TimelinePoint>;
  private readonly minDistanceKm: number;

  constructor(minDistanceKm: number = MIN_DISTANCE_KM) {
    this.minDistanceKm = minDistanceKm;
    this.buckets = new SpatialBuckets(minDistanceKm);
  }

  /** True when a point already accepted is closer than the threshold. */
  has(location: Located): boolean {
    let found = false;
    this.buckets.forEachNeighbour(location, (other) => {
      found = calculateDistance(location, other) < this.minDistanceKm;
      return !found;
    });
    return found;
  }

  /** Indexes the point and returns false when an earlier point already covers it. */
  add(point: TimelinePoint): boolean {
    if (this.has(point)) return false;
    this.buckets.insert(point);
    return true;
  }
}

interface IndexedPathEnds extends Located {
  start: TimelinePoint;
  end: TimelinePoint;
}

/**
 * Keeps the first of every group of paths whose endpoints match pairwise
 * within `minDistanceKm`. Direction is ignored: A -> B and B -> A cover the
 * same ground, so the second one is redundant for the fog.
 *
 * Only the endpoints are compared — two different routes between the same two
 * places collapse into one.
 */
export class PathDeduplicator {
  private readonly buckets: SpatialBuckets<IndexedPathEnds>;
  private readonly minDistanceKm: number;

  constructor(minDistanceKm: number = MIN_DISTANCE_KM) {
    this.minDistanceKm = minDistanceKm;
    this.buckets = new SpatialBuckets(minDistanceKm);
  }

  /** True when a path already accepted runs between the same two places. */
  has(start: Located, end: Located): boolean {
    let found = false;
    this.buckets.forEachNeighbour(start, (other) => {
      found =
        (this.isSamePlace(start, other.start) && this.isSamePlace(end, other.end)) ||
        (this.isSamePlace(start, other.end) && this.isSamePlace(end, other.start));
      return !found;
    });
    return found;
  }

  /**
   * Indexes the path and returns false when it is a near-duplicate of an
   * earlier one, or when it has too few points to draw.
   */
  add(path: TimelinePath): boolean {
    if (path.points.length < 2) return false;

    const start = path.points[0];
    const end = path.points[path.points.length - 1];
    if (this.has(start, end)) return false;

    // Indexed under both ends so a reversed path is found from either side.
    this.buckets.insert({ lat: start.lat, lon: start.lon, start, end });
    this.buckets.insert({ lat: end.lat, lon: end.lon, start, end });
    return true;
  }

  private isSamePlace(a: Located, b: Located): boolean {
    return calculateDistance(a, b) < this.minDistanceKm;
  }
}
