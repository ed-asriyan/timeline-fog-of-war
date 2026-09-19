export interface LocationPoint {
  lat: number;
  lon: number;
}

export interface TimelinePoint {
  lat: number;
  lon: number;
  timestamp: number;
}

export interface TimelinePath {
  points: TimelinePoint[];
}

export interface Bounds {
  a: LocationPoint;
  b: LocationPoint;
}

export interface Statistics {
  totalPoints: number;
  totalPaths: number;
}

export interface Group {
  points: TimelinePoint[];
  paths: TimelinePath[];
}

export interface MapSegment {
  index: number;
  group: Group;
}

export interface Settings {
    maxPathDistanceKm: number;
    maxPathVelocityKmh: number;
}

export interface MapApp {
  /** A Blob is read where the import runs, which keeps a large file off the page. */
  loadPoints(data: string | Blob, onProgress?: (status: 'parsing'|'saving', progress: number) => void): Promise<LocationPoint | null>;
  clear(): Promise<void>;
  /**
   * `resolutionKm` is how much ground one screen pixel covers: detail finer
   * than that is dropped before it is read. Zero reads everything.
   */
  getData(bounds: Bounds, resolutionKm?: number): Promise<Group>;
  getStatistics(bounds: Bounds): Promise<Statistics>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
}

export interface MapSegmentRepository {
  saveSegments(segments: MapSegment[]): Promise<void>;
  loadSegments(ids: number[]): Promise<MapSegment[]>;
  clear(): Promise<void>;
  hasData(): Promise<boolean>;
}

export interface ParserPort {
  parse(data: string): Group;
}

export interface SettingsRepository {
  saveSettings(settings: Settings): Promise<void>;
  loadSettings(): Promise<Settings>;
}
