import * as THREE from 'three';
import { COLS, ROWS, TOP, DepthSensor } from '../ar/depthSensor';
import { buddyMotion } from '../partner/buddyMotion';
import { pacePlan, type BuddyClip } from '../partner/buddyPace';
import { BUDDY_HEIGHT } from '../partner/mascot';
import { Partner, type PartnerState } from '../partner/partner';
import { CourseRecording } from '../world/course';
import { FollowMe } from '../world/followMe';
import { Path, resample, type RoutePoint } from '../world/path';
import { SurfaceMap, type DepthVerdict, type Hazard, type SurfaceProbe, type SurfaceTuning } from '../world/surfaceMap';

/**
 * Replays a field recording (see FieldLog) through the app's own SurfaceMap, Path, Partner and
 * DepthSensor, on a laptop, to see why the buddy did what it did and to try other thresholds.
 *
 * It feeds the modules the way main.ts does: floor hits as they arrived, depth through the
 * DepthSensor (fed the recorded grid, pose and projection), the path and buddy updated about 30
 * times a second in between, and `performance.now()` driven by the recording's clock.
 *
 * Not replayed (not recorded): GPS re-anchoring of a map route, the coach's effort from heart
 * rate, and the depth frames between logged ones (the app reads depth 10x a second, logs 5x;
 * see `fillDepthGaps`).
 */

export type Row = { t: number; kind: string; data: any };
export type Vec3 = [number, number, number];

export type RunStartData = {
  mode?: string;
  floorY: number;
  phone: Vec3;
  walkableStep: number;
  points?: [number, number][];
  seeds?: [number, number][];
  laps?: number;
  turnarounds?: number[];
  /** Quick start followed the runner (logged since follow-me). */
  follow?: boolean;
};

export type FrameData = { pose: number[]; projection?: number[]; depth: string; hits: number[][] };

/** Depth readings are summarised by distance, like the field log: under 2 m, 2-3.5 m, beyond. */
export const BANDS = [2, 3.5, Infinity];
export const BAND_NAMES = ['<2m', '2-3.5m', '3.5m+'];

/** As in main.ts. */
const QUICK_PACE = 1.6;
const PRUNE_EVERY = 5;
const PRUNE_RADIUS = 40;
const SENSOR_INTERVAL = 0.1;
/** Path and buddy are stepped this often between recorded frames (the app runs at 30-60 fps). */
const SUBSTEP = 1 / 30;
/** A longer gap between frames is a pause (app in the background): only this much time passes. */
const MAX_SPAN = 0.5;
/** On a course nothing is logged between runs; ticks stopping this long means the run finished. */
const COURSE_RUN_OVER = 1.5;
/** Hazard cells are counted this far around the runner, like the field log's snapshot. */
const HAZARD_RADIUS = 6;
/** A buddy state must hold this long to show in the timeline (blocked always shows). */
const STATE_SETTLE = 0.3;

export type BandStats = {
  ground: number;
  obstacle: number;
  drop: number;
  between: number;
  outOfRange: number;
  noGround: number;
  /** Heights above the map ground of the points that were judged (ground, obstacle, drop, between). */
  heights: number[];
  /** Depth-over-floor ratios (SurfaceProbe.ratio) for points in this band. */
  ratios: number[];
};

export type CloudPoint = { x: number; y: number; z: number; d: number; height: number; verdict: DepthVerdict };

export type FrameReport = {
  t: number;
  camera: Vec3;
  runnerS: number | null;
  buddyS: number | null;
  state: PartnerState | null;
  blockedAtS: number | null;
  blockReason: Hazard | null;
  detouring: boolean;
  seenUntilS: number | null;
  /** Depth points fed to the map this frame. */
  points: number;
  bands: BandStats[];
  hits: { accepted: number; rejected: number; unknown: number };
  /** The depth grid is identical to the previous frame's while the pose moved: a stale depth image. */
  stale: boolean;
  /**
   * Grid and pose both identical to the previous frame: the phone gave no depth this time, the
   * app skipped it and logged the previous frame again. Not fed to the map.
   */
  repeated: boolean;
  distrusted: boolean;
  rebased: number;
  cloud?: CloudPoint[];
};

export type EventKind =
  | 'start'
  | 'end'
  | 'state'
  | 'blocked'
  | 'unblocked'
  | 'detour'
  | 'detour end'
  | 'distrust'
  | 'stale'
  | 'repeated'
  | 'rebase'
  | 'drift'
  | 'gap'
  | 'mark'
  | 'follow'
  | 'note';

export type ReplayEvent = { t: number; s: number | null; kind: EventKind; text: string; data?: Record<string, unknown> };

export type Snapshot = {
  state: string | null;
  blockedAtS: number | null;
  reason: string | null;
  obstacle: number;
  drop: number;
  runnerS: number | null;
  buddyS: number | null;
  distrusted: number;
  rebased: number;
  cells: number;
};

export type TickCompare = { t: number; recorded: Snapshot; replay: Snapshot };

export type Segment = {
  kind: 'run' | 'recording';
  /** 1-based run number (recordings share the number of the run they lead to). */
  index: number;
  mode: string;
  startT: number;
  endT: number;
  endReason: string;
  /** False when the recording has no raw frames or no route to replay (older sessions). */
  replayable: boolean;
  notes: string[];
  start?: RunStartData;
  events: ReplayEvent[];
  frames: FrameReport[];
  ticks: TickCompare[];
  /** Every tick the phone logged in this segment, for sessions that can't be replayed. */
  recordedTicks: Row[];
  marks: Row[];
  /** The replay laid Quick start following the runner, and how often it re-laid the path. */
  follow?: { bends: number; respawns: number; extends: number };
  /** How far the path ahead of the runner stayed from where they actually went (runs only). */
  pathVsTrack?: PathVsTrack;
  /** How the buddy paced the runner (runs only). */
  pacing?: Pacing;
};

/**
 * How steadily the buddy kept pace: time in each state, how often the state changed (every
 * change, however brief), and its lead while the runner was walking (moving faster than
 * WALKING over the last second or so).
 */
export type Pacing = {
  seconds: number;
  stateSeconds: Partial<Record<PartnerState, number>>;
  switches: number;
  /** Buddy lead in metres, sampled every replay step while the runner walked. */
  walkingLeads: number[];
  /** The runner's (smoothed) walking speed, sampled the same way. */
  walkingSpeeds: number[];
  /** Seconds spent in each animation clip the buddy would play (as the mascot picks them), and how often it changed. */
  clipSeconds: Partial<Record<BuddyClip, number>>;
  clipSwitches: number;
  /** Times the buddy itself came to a stop (its own ground speed, not its state) after moving. */
  buddyStops: number;
};

/** Runner speed above which they count as walking, for Pacing. */
const WALKING = 0.3;

/** Distances along the path ahead of the runner at which it's compared with their track. */
export const AHEAD = [2, 3, 4, 5, 6];

export type OffsetStats = { n: number; median: number | null; p90: number | null; max: number | null; over50: number };
/** Per distance ahead (AHEAD), and all together. */
export type PathVsTrack = { byAhead: OffsetStats[]; all: OffsetStats };

/** The path's line ahead of the runner at one moment: [metres ahead, x, z]. */
export type AheadSample = { along: number; points: [number, number, number][] };
/** The runner's track: x, z and how far they had walked there. */
export type TrackPoint = { x: number; z: number; along: number };

/**
 * For each sample, how far each of its points ahead is from the stretch of the runner's track
 * they walked from then on (the nearest point of it). Points further ahead than the runner went
 * before the recording ended are left out.
 */
export function pathVsTrack(samples: readonly AheadSample[], track: readonly TrackPoint[]): PathVsTrack {
  const total = track.at(-1)?.along ?? 0;
  const per = AHEAD.map(() => [] as number[]);
  for (const sample of samples) {
    const first = Math.max(0, track.findIndex(p => p.along >= sample.along - 0.5));
    for (const [d, x, z] of sample.points) {
      if (sample.along + d + 1 > total) continue;
      let best = Infinity;
      for (let i = first; i < track.length - 1; i++) best = Math.min(best, segmentDistance(x, z, track[i], track[i + 1]));
      if (track.length === 1) best = Math.hypot(x - track[0].x, z - track[0].z);
      const k = AHEAD.indexOf(d);
      if (k >= 0 && Number.isFinite(best)) per[k].push(best);
    }
  }
  return { byAhead: per.map(offsetStats), all: offsetStats(per.flat()) };
}

function segmentDistance(x: number, z: number, a: TrackPoint, b: TrackPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / len2, 0, 1) : 0;
  return Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
}

function offsetStats(values: number[]): OffsetStats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  return { n: sorted.length, median: median(sorted), p90: at(0.9), max: sorted.at(-1) ?? null, over50: sorted.filter(v => v > 0.5).length };
}

export type ReplayOptions = {
  tuning?: Partial<SurfaceTuning>;
  /** Overrides the walkable step recorded at run start. */
  walkableStep?: number;
  /** Goal pace (m/s) on a map route; it isn't recorded. Quick runs and courses use the app's 1.6. */
  pace?: number;
  /** Put the buddy on a break whenever the phone's log says it was on one (default true). */
  mirrorBreaks?: boolean;
  /**
   * The app reads depth 10 times a second but logs every other frame. With this on (the
   * default), each logged frame is also fed a sensor tick earlier, standing in for the unlogged
   * one, so hazard votes pile up about as fast as on the phone.
   */
  fillDepthGaps?: boolean;
  /** Keep every depth point (with its verdict) for frames at these times, for point-cloud dumps. */
  keepCloud?: (t: number) => boolean;
  /**
   * Lay Quick start runs following the runner (from the recorded camera track), or with the
   * fixed straight path. By default, whatever the phone did (follow-me runs log it).
   */
  followMe?: boolean;
};

// ---------------------------------------------------------------- decoding and fetching

/** Depth grid from a frame: base64 of a little-endian Uint16Array, millimetres, 0 = no reading. */
export function decodeDepth(base64: string): Uint16Array {
  const binary = atob(base64);
  const out = new Uint16Array(binary.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8);
  return out;
}

/** The inverse of decodeDepth (little-endian whatever the machine), for building test recordings. */
export function encodeDepth(grid: Uint16Array): string {
  let binary = '';
  for (const value of grid) binary += String.fromCharCode(value & 0xff, value >> 8);
  return btoa(binary);
}

/**
 * Every row of a session, a page at a time. Pages are `t > after`, and several rows can share a
 * `t` (it's rounded to 10 ms), so rows at a full page's last `t` are fetched again with the next.
 */
export function fetchAllRows(fetchPage: (after: number | undefined, limit: number) => Row[], limit = 500): Row[] {
  const rows: Row[] = [];
  let after: number | undefined;
  for (;;) {
    const page = fetchPage(after, limit);
    if (page.length < limit) return rows.concat(page);
    const lastT = page[page.length - 1].t;
    const complete = page.filter(row => row.t < lastT);
    if (complete.length === 0) throw new Error(`More than ${limit} rows at t = ${lastT}; can't page past them.`);
    rows.push(...complete);
    after = complete[complete.length - 1].t;
  }
}

// ---------------------------------------------------------------- small helpers

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sameArray = (a: ArrayLike<number> | null, b: ArrayLike<number>) => {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

const emptyBand = (): BandStats => ({ ground: 0, obstacle: 0, drop: 0, between: 0, outOfRange: 0, noGround: 0, heights: [], ratios: [] });

const bandOf = (range: number) => BANDS.findIndex(limit => range < limit);

/** Collects what the map judged during one frame. */
class FrameProbe implements SurfaceProbe {
  depthCalls: { height: number; range: number; verdict: DepthVerdict }[] = [];
  ratios: { ratio: number; range: number }[] = [];
  hits = { accepted: 0, rejected: 0, unknown: 0 };

  clear() {
    this.depthCalls = [];
    this.ratios = [];
    this.hits = { accepted: 0, rejected: 0, unknown: 0 };
  }

  depth(height: number, range: number, verdict: DepthVerdict) {
    this.depthCalls.push({ height, range, verdict });
  }

  ratio(ratio: number, range: number) {
    this.ratios.push({ ratio, range });
  }

  ground(diff: number | null, accepted: boolean) {
    if (diff === null) this.hits.unknown++;
    else if (accepted) this.hits.accepted++;
    else this.hits.rejected++;
  }
}

/** The real SurfaceMap, keeping a copy of the last depth frame it was given. */
class ReplayMap extends SurfaceMap {
  lastFrame: { x: number; y: number; z: number; d: number }[] = [];

  addDepthFrame(points: readonly { x: number; y: number; z: number; d: number }[], now: number, camera?: { x: number; y: number; z: number }) {
    this.lastFrame = points.map(p => ({ x: p.x, y: p.y, z: p.z, d: p.d }));
    super.addDepthFrame(points, now, camera);
  }
}

/** What DepthSensor.sample needs from an XRFrame, answered from a recorded frame. */
function recordedXrFrame(pose: number[], projection: number[], grid: Uint16Array): XRFrame {
  const view = { projectionMatrix: projection, transform: { matrix: pose } };
  const depth = {
    getDepthInMeters(u: number, v: number) {
      const col = THREE.MathUtils.clamp(Math.round(u * COLS - 0.5), 0, COLS - 1);
      const row = THREE.MathUtils.clamp(Math.round(((v - TOP) / (1 - TOP)) * ROWS - 0.5), 0, ROWS - 1);
      return grid[row * COLS + col] / 1000;
    },
  };
  return { getViewerPose: () => ({ views: [view] }), getDepthInformation: () => depth } as unknown as XRFrame;
}

// ---------------------------------------------------------------- the replay

let clock = 0;

/** Replays a whole session. Rows must be one session's, in any order. */
export function replaySession(input: readonly Row[], options: ReplayOptions = {}): Segment[] {
  const rows = [...input].sort((a, b) => a.t - b.t);
  const realNow = performance.now;
  performance.now = () => clock * 1000;
  try {
    return new Replayer(rows, options).run();
  } finally {
    performance.now = realNow;
  }
}

class Replayer {
  private readonly map: ReplayMap;
  private readonly path = new Path();
  private readonly partner = new Partner(this.path);
  private readonly sensor = new DepthSensor();
  private readonly probe = new FrameProbe();
  private readonly recording = new CourseRecording();
  private readonly segments: Segment[] = [];
  private segment: Segment | null = null;
  private phase: 'idle' | 'recording' | 'running' | 'log only' = 'idle';
  private runs = 0;

  private projection: number[] | null = null;
  private previousPose: number[] | null = null;
  private previousGrid: Uint16Array | null = null;
  private lastFrameT: number | null = null;
  private readonly camera = new THREE.Vector3();
  private readonly previousCamera = new THREE.Vector3();
  private runnerS = 0;
  /** The last depth frame's points with their verdicts. */
  private lastCloud: CloudPoint[] = [];
  private lastTickT = -Infinity;
  private lastPrune = -Infinity;
  private floorY = 0;
  private lastState: PartnerState | null = null;
  private pendingState: { state: PartnerState; since: number } | null = null;
  private flips = 0;
  private widestDetour = 0;
  /** Follow-me, when this run follows the runner. */
  private follow: FollowMe | null = null;
  private readonly centre = { x: 0, z: 0 };
  /** The path ahead of the runner at each frame, and the runner's track, for pathVsTrack. */
  private aheadSamples: AheadSample[] = [];
  private track: TrackPoint[] = [];
  private lastBlock: { s: number | null; reason: Hazard | null } = { s: null, reason: null };
  private wasDetouring = false;
  private pacing: Pacing | null = null;
  private pacingState: PartnerState | null = null;
  private walkSpeed = 0;
  /** The clip the mascot would be playing, for Pacing. */
  private clip: BuddyClip | null = null;
  private buddySpeed = 0;
  private buddyMoving = false;
  private lastBuddyS: number | null = null;
  private readonly lastWalkAt = new THREE.Vector3();
  private streaks = { distrust: 0, stale: 0, repeated: 0 };
  private reportedDrift = 0;
  private readonly rows: readonly Row[];
  private readonly options: ReplayOptions;

  constructor(rows: readonly Row[], options: ReplayOptions) {
    this.rows = rows;
    this.options = options;
    this.map = new ReplayMap(options.tuning);
    this.map.probe = this.probe;
  }

  run(): Segment[] {
    this.rows.forEach((row, i) => {
      clock = row.t;
      switch (row.kind) {
        case 'run start':
          return this.runStart(row);
        case 'run end':
          if (this.segment?.kind === 'run') this.close(row.t, 'run end');
          this.phase = 'idle';
          return;
        case 'frame':
          return this.frame(row, i);
        case 'tick':
          return this.tick(row);
        case 'mark':
          return this.mark(row);
      }
    });
    if (this.segment) this.close(this.segment.endT, 'end of the recording');
    return this.segments;
  }

  // ------------------------------------------------------------ segments

  private open(kind: Segment['kind'], t: number, mode: string, replayable: boolean): Segment {
    if (this.segment) this.close(t, kind === 'run' ? 'next run started' : 'recording a course');
    const segment: Segment = {
      kind,
      index: kind === 'run' ? ++this.runs : this.runs + 1,
      mode,
      startT: t,
      endT: t,
      endReason: '',
      replayable,
      notes: [],
      events: [],
      frames: [],
      ticks: [],
      recordedTicks: [],
      marks: [],
    };
    this.segments.push(segment);
    this.segment = segment;
    this.lastState = null;
    this.pendingState = null;
    this.flips = 0;
    this.widestDetour = 0;
    this.lastBlock = { s: null, reason: null };
    this.wasDetouring = false;
    this.streaks = { distrust: 0, stale: 0, repeated: 0 };
    this.lastFrameT = null;
    this.pacing = kind === 'run' ? { seconds: 0, stateSeconds: {}, switches: 0, walkingLeads: [], walkingSpeeds: [], clipSeconds: {}, clipSwitches: 0, buddyStops: 0 } : null;
    this.pacingState = null;
    this.walkSpeed = 0;
    this.clip = null;
    this.buddyMoving = false;
    this.buddySpeed = 0;
    this.lastBuddyS = null;
    if (this.pacing) segment.pacing = this.pacing;
    return segment;
  }

  private close(t: number, reason: string) {
    const segment = this.segment;
    if (!segment) return;
    if (segment.kind === 'run' && segment.replayable && this.track.length) segment.pathVsTrack = pathVsTrack(this.aheadSamples, this.track);
    this.aheadSamples = [];
    this.track = [];
    this.endStreaks(t);
    segment.endT = Math.max(segment.endT, t);
    segment.endReason = reason;
    if (segment.replayable) this.event('end', `${segment.kind === 'run' ? 'run' : 'recording'} ends (${reason})`, t);
    this.segment = null;
  }

  private event(kind: EventKind, text: string, t = clock, data?: Record<string, unknown>) {
    const s = this.segment?.kind === 'run' && this.segment.replayable ? r2(this.runnerS) : null;
    this.segment?.events.push({ t: r2(t), s, kind, text, data });
  }

  // ------------------------------------------------------------ rows

  /** As layRoute (and placeAt / startCourseRun) in main.ts. */
  private runStart(row: Row) {
    const data = row.data as RunStartData;
    const mode = data.mode ?? 'quick';
    if (!data.points || data.points.length < 2) {
      const segment = this.open('run', row.t, mode, false);
      segment.start = data;
      segment.notes.push("This recording predates logging the route at run start, so it can't be replayed; showing what the phone logged.");
      this.phase = 'log only';
      return;
    }
    const segment = this.open('run', row.t, mode, true);
    segment.start = data;
    const points: RoutePoint[] = data.points.map(([x, z]) => ({ x, z }));
    const map = this.map;
    if (mode === 'course') {
      // startCourseRun seeds the walked course (built.points, not logged); the run's points follow it.
      for (const p of resample(points, 0.5)) map.seedGround(p.x, data.floorY, p.z, 0.4);
      segment.notes.push('Course seeding follows the run\'s route (the walked course itself isn\'t logged).');
    } else {
      map.reset();
      this.reportedDrift = 0;
    }
    map.walkableStep = this.options.walkableStep ?? data.walkableStep;
    this.partner.turnarounds = data.turnarounds ?? [];
    for (const [x, z] of data.seeds ?? []) map.seedGround(x, data.floorY, z, 1);
    this.path.setRoute(points, data.floorY);
    this.follow = mode === 'quick' && (this.options.followMe ?? data.follow ?? false) ? new FollowMe() : null;
    this.follow?.reset();
    if (this.follow) {
      segment.follow = { bends: 0, respawns: 0, extends: 0 };
      segment.notes.push(
        data.follow
          ? 'Follow-me: the path follows the runner, re-laid from the recorded camera track (it may not re-lay at exactly the moments the phone did).'
          : 'Follow-me replayed on a run the phone laid as a fixed straight path: the buddy and blocks differ from what the phone did, so the replay-vs-phone comparison is only a rough guide.',
      );
    }
    this.aheadSamples = [];
    this.track = [];
    this.partner.goalPace = mode === 'route' ? (this.options.pace ?? QUICK_PACE) : QUICK_PACE;
    if (mode === 'route' && this.options.pace === undefined) segment.notes.push('Map-route pace isn\'t logged; using 1.6 m/s (try --pace).');
    if (mode === 'route') segment.notes.push('GPS re-anchoring of the route isn\'t logged, so the route stays where it was first laid.');
    this.partner.reset(0);
    this.partner.effort = 1;
    this.partner.trustGroundAhead = mode === 'route';
    this.partner.pacing = mode === 'route' ? 'goal' : 'match';
    this.camera.fromArray(data.phone);
    this.previousCamera.copy(this.camera);
    this.runnerS = 0;
    if (mode !== 'quick') {
      this.runnerS = this.path.project(this.camera);
      this.partner.reset(this.runnerS);
    }
    this.lastTickT = row.t;
    this.lastPrune = row.t;
    this.phase = 'running';
    const seeds = data.seeds?.length ?? 0;
    this.event(
      'start',
      `${mode} run, ${r2(this.path.length)} m path, floor y ${r2(data.floorY)}, phone ${r2(data.phone[1] - data.floorY)} m above it, ` +
        `walkable step ${map.walkableStep}, ${seeds} seed${seeds === 1 ? '' : 's'}` +
        (data.turnarounds?.length ? `, turnarounds at ${data.turnarounds.map(r2).join(', ')}` : '') +
        (data.laps ? `, ${data.laps} laps` : ''),
      row.t,
    );
  }

  /** Recording a course (beginRecording in main.ts): the map learns the floor afresh from the walk. */
  private beginRecording(row: Row, index: number, camera: THREE.Vector3) {
    const segment = this.open('recording', row.t, 'course', true);
    const next = this.rows.slice(index).find(r => r.kind === 'run start')?.data as RunStartData | undefined;
    const hits = (row.data as FrameData).hits.map(h => h[1]);
    this.floorY = next?.floorY ?? median(hits) ?? camera.y - 1.4;
    if (!next) segment.notes.push('No run followed this recording; floor height taken from the floor hits.');
    this.map.reset();
    this.reportedDrift = 0;
    this.map.walkableStep = 0;
    this.map.seedGround(camera.x, this.floorY, camera.z, 1);
    this.recording.clear();
    this.recordAt(camera);
    this.phase = 'recording';
    this.event('start', `recording a course, floor y ${r2(this.floorY)}`, row.t);
  }

  private recordAt(at: THREE.Vector3) {
    if (this.recording.add(at.x, at.z)) this.map.seedGround(at.x, this.floorY, at.z, 0.4);
  }

  private tick(row: Row) {
    if (!this.segment) {
      const segment = this.open('run', row.t, row.data?.mode ?? '?', false);
      segment.notes.push('No run start was logged for these ticks (lost upload?), so they can\'t be replayed.');
      this.phase = 'log only';
    }
    const segment = this.segment!;
    segment.recordedTicks.push(row);
    segment.endT = row.t;
    if (this.phase !== 'running') return;
    this.lastTickT = row.t;
    const data = row.data;
    if (this.options.mirrorBreaks !== false) {
      const onBreak = data.state === 'break';
      if (onBreak !== this.partner.breaking) this.partner.setBreak(onBreak);
    }
    const cells = this.map.hazardCells(this.camera.x, this.camera.z, HAZARD_RADIUS, row.t, []);
    segment.ticks.push({
      t: row.t,
      recorded: {
        state: data.state ?? null,
        blockedAtS: data.path?.blockedAtS ?? null,
        reason: data.path?.reason ?? null,
        obstacle: data.hazardCounts?.obstacle ?? 0,
        drop: data.hazardCounts?.drop ?? 0,
        runnerS: data.runnerS ?? null,
        buddyS: data.buddyS ?? null,
        distrusted: data.distrustedFrames ?? 0,
        rebased: data.rebased ?? 0,
        cells: data.mapCells ?? 0,
      },
      replay: {
        state: this.partner.state,
        blockedAtS: this.path.status.blockedAtS,
        reason: this.path.status.blockReason,
        obstacle: cells.filter(c => c.kind === 'obstacle').length,
        drop: cells.filter(c => c.kind === 'drop').length,
        runnerS: this.runnerS,
        buddyS: this.partner.s,
        distrusted: this.map.distrustedFrames,
        rebased: this.map.rebased,
        cells: this.map.size,
      },
    });
  }

  private mark(row: Row) {
    if (!this.segment) this.open('run', row.t, '?', false);
    this.segment!.marks.push(row);
    const d = row.data ?? {};
    const block = d.blockedAtS == null ? 'not blocked' : `blocked by ${d.reason} at s ${r2(d.blockedAtS)}`;
    this.event('mark', `MARK ${d.n ?? this.segment!.marks.length}: phone said ${d.state}, buddy at s ${d.buddyS == null ? '?' : r2(d.buddyS)}, ${block}`, row.t, d);
  }

  private frame(row: Row, index: number) {
    const data = row.data as FrameData;
    const pose = data.pose;
    if (this.phase === 'running' && this.segment?.mode === 'course' && row.t - this.lastTickT > COURSE_RUN_OVER) {
      this.close(this.lastTickT, 'run finished');
      this.phase = 'idle';
    }
    if (this.phase === 'log only') return;
    this.camera.set(pose[12], pose[13], pose[14]);
    if (this.phase === 'idle') {
      this.beginRecording(row, index, this.camera);
      this.previousCamera.copy(this.camera);
    }
    const segment = this.segment!;
    segment.endT = row.t;
    const running = this.phase === 'running';

    if (data.projection) this.projection = data.projection;
    const grid = decodeDepth(data.depth);
    const sameGrid = sameArray(this.previousGrid, grid);
    const repeated = sameGrid && sameArray(this.previousPose, pose);
    // (An all-empty grid, nothing in range, says nothing about whether the image is updating.)
    const stale = sameGrid && !repeated && grid.some(mm => mm > 0);
    this.previousGrid = grid;
    this.previousPose = pose;

    // The first frame of a segment covers the time since it started (at most one frame's worth).
    const previousT = this.lastFrameT ?? Math.max(segment.startT, row.t - 0.2);
    this.lastFrameT = row.t;
    const gap = row.t - previousT;
    if (gap > MAX_SPAN) this.event('gap', `no frames for ${gap.toFixed(1)} s`, row.t);
    const span = Math.max(0, Math.min(gap, MAX_SPAN));
    const steps = Math.max(1, Math.ceil(span / SUBSTEP - 1e-6));
    const dt = span / steps;
    // The app plans detours on every sensor tick (10x a second); only every other one was logged.
    const planEvery = Math.max(1, Math.round(SENSOR_INTERVAL / Math.max(dt, 1e-6)));

    this.probe.clear();
    let rebased = 0;
    let distrusted = false;
    let points = 0;
    const hits = data.hits ?? [];
    const at = new THREE.Vector3();
    for (let k = 0; k < steps; k++) {
      const t = row.t - span + dt * (k + 1);
      clock = t;
      at.lerpVectors(this.previousCamera, this.camera, (k + 1) / steps);
      // Floor hits arrived over the frame; spread them over the steps.
      const from = Math.floor((k * hits.length) / steps);
      const to = Math.floor(((k + 1) * hits.length) / steps);
      rebased += this.floorHits(hits.slice(from, to), t);

      if (running) {
        this.runnerS = this.path.project(at);
        if (this.follow) this.followUpdate(t, at);
      } else this.recordAt(at);

      const last = k === steps - 1;
      const sensorTick = last || (steps - 1 - k) % planEvery === 0;
      if (this.options.fillDepthGaps !== false && sensorTick && !last && !repeated && this.projection) {
        // Stand-in for the unlogged depth frame in between: this frame's grid, a tick early.
        const before = this.map.distrustedFrames;
        this.sensor.sample(recordedXrFrame(pose, this.projection, grid), {} as XRReferenceSpace, this.map, t);
        distrusted = this.map.distrustedFrames > before;
        this.probe.depthCalls = [];
        this.probe.ratios = [];
      }
      if (last && !repeated && this.projection) {
        const before = this.map.distrustedFrames;
        points = this.sensor.sample(recordedXrFrame(pose, this.projection, grid), {} as XRReferenceSpace, this.map, row.t);
        distrusted ||= this.map.distrustedFrames > before;
        this.lastCloud = this.cloud();
      }
      if (running) {
        this.path.update(dt, t, this.runnerS, this.map, t, sensorTick);
        this.partner.update(dt, this.runnerS);
        this.measurePacing(dt, at);
        if (t - this.lastPrune > PRUNE_EVERY) {
          this.lastPrune = t;
          this.map.prune(at.x, at.z, PRUNE_RADIUS);
        }
        this.watchPath(t);
      }
    }
    this.previousCamera.copy(this.camera);
    if (running) this.sampleAhead();
    if (!this.projection) segment.notes.push(`Frame at ${row.t} s had no projection yet; its depth was skipped.`);

    const report = this.frameReport(row.t, points, stale, repeated, distrusted, rebased);
    segment.frames.push(report);
    this.streak('distrust', distrusted, row.t, 'depth distrusted (most near points read as a drop while floor hits agree): drop votes ignored');
    this.streak('stale', stale, row.t, 'depth grid identical to the last frame while the phone moved (stale depth image)');
    this.streak('repeated', repeated, row.t, 'no depth from the phone (frame logged again unchanged)');
  }

  private measurePacing(dt: number, at: THREE.Vector3) {
    const pacing = this.pacing;
    if (!pacing) return;
    const state = this.partner.state;
    if (this.pacingState === null) this.lastWalkAt.copy(at);
    else if (state !== this.pacingState) pacing.switches++;
    this.pacingState = state;
    pacing.seconds += dt;
    pacing.stateSeconds[state] = (pacing.stateSeconds[state] ?? 0) + dt;
    // As Mascot.update picks the animation.
    const motion = buddyMotion(this.partner.gait, this.clip === 'Run_Jogging' || this.clip === 'Run_JogForward', BUDDY_HEIGHT);
    const runClip = this.clip === 'Run_JogForward' || this.clip === 'Run_Jogging' ? this.clip : null;
    const clip = motion.kind === 'pace' ? pacePlan(motion.speed, BUDDY_HEIGHT, runClip).clip : motion.clip;
    if (this.clip !== null && clip !== this.clip) pacing.clipSwitches++;
    this.clip = clip;
    pacing.clipSeconds[clip] = (pacing.clipSeconds[clip] ?? 0) + dt;
    if (dt <= 0) return;
    // The buddy's own speed over the ground, smoothed over ~0.3 s (a follow-me catch-up jump isn't movement).
    const step = this.lastBuddyS === null ? 0 : this.partner.s - this.lastBuddyS;
    this.lastBuddyS = this.partner.s;
    if (Math.abs(step) < 0.5) this.buddySpeed += (step / dt - this.buddySpeed) * Math.min(1, dt / 0.3);
    if (this.buddyMoving && this.buddySpeed < 0.1) {
      this.buddyMoving = false;
      pacing.buddyStops++;
    } else if (!this.buddyMoving && this.buddySpeed > 0.3) this.buddyMoving = true;
    const moved = Math.hypot(at.x - this.lastWalkAt.x, at.z - this.lastWalkAt.z);
    this.lastWalkAt.copy(at);
    this.walkSpeed += (moved / dt - this.walkSpeed) * Math.min(1, dt / 1);
    if (this.walkSpeed > WALKING) {
      pacing.walkingLeads.push(this.partner.s - this.runnerS);
      pacing.walkingSpeeds.push(this.walkSpeed);
    }
  }

  /** As in main.ts's frame loop: let follow-me re-lay the path, and say when it did. */
  private followUpdate(t: number, at: THREE.Vector3) {
    const event = this.follow!.update(t, at, this.runnerS, this.path, this.partner);
    const counts = this.segment!.follow!;
    if (!event) return;
    if (event.kind === 'extend') {
      counts.extends++;
      return;
    }
    const h = this.follow!.travel.heading;
    const heading = h ? `heading ${Math.round((Math.atan2(h.x, -h.z) * 180) / Math.PI)}°` : '';
    if (event.kind === 'bend') {
      counts.bends++;
      this.event('follow', `path bent onto the runner's line from s ${r2(event.fromS)} (it was ${cm(event.error)} off), ${heading}`, t);
    } else {
      counts.respawns++;
      this.event('follow', `runner got past the buddy: path re-laid from s ${r2(event.fromS)}, buddy picks up at s ${r2(event.buddyS)}, ${heading}`, t);
    }
  }

  /**
   * Where the path's line runs ahead of the runner, and where the runner is: once every 25 cm
   * they move, so time spent standing still doesn't outweigh the walk.
   */
  private sampleAhead() {
    const last = this.track.at(-1);
    const moved = last ? Math.hypot(this.camera.x - last.x, this.camera.z - last.z) : 0;
    if (last && moved < 0.25) return;
    const along = last ? last.along + moved : 0;
    this.track.push({ x: this.camera.x, z: this.camera.z, along });
    const points: [number, number, number][] = [];
    for (const d of AHEAD) {
      if (this.runnerS + d > this.path.length) continue;
      this.path.centreAt(this.runnerS + d, this.centre);
      points.push([d, this.centre.x, this.centre.z]);
    }
    this.aheadSamples.push({ along, points });
  }

  /**
   * One XR frame's floor hits, as GroundRays.sample feeds them. Reports cells whose ground moved
   * to match (re-based) and, once it adds up to 3 cm, the map shifting with the phone's world.
   * Returns how many cells were re-based.
   */
  private floorHits(hits: number[][], t: number): number {
    const map = this.map;
    const before = map.rebased;
    const drift = map.drift;
    const references = hits.map(([x, , z]) => map.referenceGround(x, z));
    map.addFloorHits(hits.map(([x, y, z]) => ({ x, y, z })), t);
    if (Math.abs(map.drift - this.reportedDrift) >= 0.03) {
      this.event('drift', `floor detection says the phone's world moved: map shifted ${cm(map.drift - this.reportedDrift)} (${cm(map.drift)} in all)`, t, {
        drift: map.drift,
      });
      this.reportedDrift = map.drift;
    }
    const rebased = map.rebased - before;
    if (rebased === 0) return 0;
    const shifted = map.drift - drift;
    const seen = new Set<string>();
    hits.forEach(([x, , z], i) => {
      const ground = map.groundAt(x, z);
      const reference = references[i];
      const key = `${Math.floor(x / 0.2)},${Math.floor(z / 0.2)}`;
      if (ground === null || reference === null || seen.has(key) || Math.abs(ground - reference - shifted) < 0.04) return;
      seen.add(key);
      this.event('rebase', `floor detection re-based the cell at x ${r2(x)} z ${r2(z)} to y ${r2(ground)} (${cm(ground - reference - shifted)} from ${r2(reference + shifted)})`, t, {
        x,
        z,
        ground,
        shift: ground - reference - shifted,
      });
    });
    return rebased;
  }

  /**
   * Buddy state, blocks and detours, reported as they change. A state has to hold for
   * STATE_SETTLE seconds to be reported; quicker flips (run/look at the edge of the seen ground)
   * are only counted.
   */
  private watchPath(t: number) {
    const partner = this.partner;
    const status = this.path.status;
    const state = partner.state;
    if (state === this.lastState) {
      if (this.pendingState) this.flips++;
      this.pendingState = null;
    } else if (this.lastState === null) this.reportState(state, t, 0);
    else if (this.pendingState?.state !== state) {
      if (this.pendingState) this.flips++;
      this.pendingState = { state, since: t };
    }
    if (this.pendingState && (t - this.pendingState.since >= STATE_SETTLE || this.pendingState.state === 'blocked')) {
      this.reportState(this.pendingState.state, this.pendingState.since, this.flips);
    }

    const block = { s: status.blockedAtS, reason: status.blockReason };
    const last = this.lastBlock;
    const moved = block.s !== null && (last.s === null || block.reason !== last.reason || Math.abs(block.s - last.s) > 0.5);
    if (moved) this.event('blocked', this.describeBlock(block.s!, block.reason!, t), t, { blockedAtS: block.s, reason: block.reason });
    else if (block.s === null && last.s !== null) this.event('unblocked', 'path clear again', t);
    if (moved || block.s === null) this.lastBlock = block;

    if (status.detouring) this.widestDetour = Math.max(this.widestDetour, this.offsetFromRoute(this.runnerS, this.runnerS + 6));
    if (status.detouring !== this.wasDetouring) {
      if (status.detouring) this.event('detour', this.describeDetour(t), t);
      else {
        const outcome = status.blockedAtS === null ? 'path back on the route' : 'detour dropped (blocked, no clear side)';
        this.event('detour end', `${outcome}; it had bent up to ${this.widestDetour.toFixed(2)} m sideways`, t);
      }
      this.wasDetouring = status.detouring;
      this.widestDetour = 0;
    }
  }

  private reportState(state: PartnerState, since: number, flips: number) {
    const lead = this.partner.s - this.runnerS;
    const seen = this.path.status.seenUntilS - this.runnerS;
    const flicker = flips ? `, after ${flips} brief flip${flips === 1 ? '' : 's'}` : '';
    this.event('state', `buddy ${this.lastState ?? '–'} → ${state} (${lead.toFixed(1)} m ahead, seen to +${seen.toFixed(1)} m${flicker})`, since);
    this.lastState = state;
    this.pendingState = null;
    this.flips = 0;
  }

  /** The route's centre line at `s` (as re-laid, when following). */
  private routeAt(s: number): RoutePoint {
    return this.path.centreAt(s, { x: 0, z: 0 });
  }

  /** Widest sideways gap between the drawn path and the route over a stretch. */
  private offsetFromRoute(from: number, to: number): number {
    const p = new THREE.Vector3();
    let widest = 0;
    for (let s = Math.max(0, from); s <= Math.min(this.path.length, to); s += 0.2) {
      this.path.pointAt(s, p);
      const c = this.routeAt(s);
      widest = Math.max(widest, Math.hypot(p.x - c.x, p.z - c.z));
    }
    return widest;
  }

  private describeBlock(s: number, reason: Hazard, t: number): string {
    // Hazards are looked for around the route's centre line (detours are tried from there).
    const centre = this.routeAt(s);
    const y = this.path.pointAt(s, new THREE.Vector3()).y;
    // The reason is the worst hazard along the blocked stretch, which may start with the other kind.
    const cells = this.map.hazardCells(centre.x, centre.z, 0.5, t, []);
    const obstacles = cells.filter(c => c.kind === 'obstacle');
    const drops = cells.length - obstacles.length;
    let why = `${obstacles.length} obstacle / ${drops} drop cells within 0.5 m`;
    const tops = obstacles.map(c => this.map.obstacleTopAt(c.x, c.z, t)).filter((top): top is number => top !== null);
    if (tops.length) why += `, obstacle top ${cm(Math.max(...tops) - y)} above the path`;
    // The points from the last frame that landed near the block, and how high they sat.
    for (const kind of ['obstacle', 'drop'] as const) {
      const near = this.lastCloudNear(centre.x, centre.z, 0.4).filter(p => p.verdict === kind);
      if (near.length) why += `; last frame: ${near.length} ${kind} points there, median ${cm(median(near.map(p => p.height)))}`;
    }
    return `BLOCKED by ${reason} at s ${r2(s)} (x ${r2(centre.x)} z ${r2(centre.z)}), ${(s - this.runnerS).toFixed(1)} m ahead, no clear side: ${why}`;
  }

  private describeDetour(t: number): string {
    // What it's going round: the first hazard on the route's centre line ahead, as planDetours finds it.
    for (let s = this.runnerS; s <= Math.min(this.path.length, this.runnerS + 6); s += 0.1) {
      const c = this.routeAt(s);
      const hazard = this.map.hazardAt(c.x, c.z, 0.3, t);
      if (hazard) return `detour round ${hazard === 'obstacle' ? 'an obstacle' : 'a drop'} at s ${r2(s)} (x ${r2(c.x)} z ${r2(c.z)}), ${(s - this.runnerS).toFixed(1)} m ahead`;
    }
    return 'detour (hazard no longer on the line)';
  }

  private lastCloudNear(x: number, z: number, radius: number): CloudPoint[] {
    return this.lastCloud.filter(p => (p.x - x) ** 2 + (p.z - z) ** 2 <= radius * radius);
  }

  /** The last depth frame's points paired with what the map judged each one. */
  private cloud(): CloudPoint[] {
    const points = this.map.lastFrame;
    const calls = this.probe.depthCalls;
    if (calls.length !== points.length) return [];
    return points.map((p, i) => ({ ...p, height: calls[i].height, verdict: calls[i].verdict }));
  }

  private frameReport(t: number, points: number, stale: boolean, repeated: boolean, distrusted: boolean, rebased: number): FrameReport {
    const bands = BANDS.map(emptyBand);
    if (points > 0) {
      for (const call of this.probe.depthCalls) {
        const band = bands[bandOf(call.range)];
        if (call.verdict === 'out of range') band.outOfRange++;
        else if (call.verdict === 'no ground') band.noGround++;
        else {
          band[call.verdict]++;
          band.heights.push(call.height);
        }
      }
      for (const { ratio, range } of this.probe.ratios) bands[bandOf(range)].ratios.push(ratio);
    }
    const running = this.phase === 'running';
    const status = this.path.status;
    const report: FrameReport = {
      t,
      camera: this.camera.toArray() as Vec3,
      runnerS: running ? this.runnerS : null,
      buddyS: running ? this.partner.s : null,
      state: running ? this.partner.state : null,
      blockedAtS: running ? status.blockedAtS : null,
      blockReason: running ? status.blockReason : null,
      detouring: running && status.detouring,
      seenUntilS: running ? status.seenUntilS : null,
      points,
      bands,
      hits: { ...this.probe.hits },
      stale,
      repeated,
      distrusted,
      rebased,
    };
    if (points > 0 && this.options.keepCloud?.(t)) report.cloud = this.lastCloud;
    return report;
  }

  /** Report runs of distrusted / stale / repeated frames once at the start and once at the end. */
  private streak(kind: 'distrust' | 'stale' | 'repeated', on: boolean, t: number, text: string) {
    if (on) {
      if (this.streaks[kind]++ === 0) this.event(kind, text, t);
    } else if (this.streaks[kind] > 0) {
      this.event(kind, `…${kind === 'distrust' ? 'depth trusted' : 'depth updating'} again after ${this.streaks[kind]} frame${this.streaks[kind] === 1 ? '' : 's'}`, t);
      this.streaks[kind] = 0;
    }
  }

  private endStreaks(t: number) {
    for (const kind of ['distrust', 'stale', 'repeated'] as const) {
      if (this.streaks[kind] > 0) this.event(kind, `…${kind} until the end (${this.streaks[kind]} frames)`, t);
      this.streaks[kind] = 0;
    }
  }
}

/** Signed centimetres, e.g. "+12 cm". */
export function cm(metres: number | null): string {
  if (metres === null || !Number.isFinite(metres)) return '–';
  const value = Math.round(metres * 100);
  return `${value > 0 ? '+' : ''}${value} cm`;
}

// ---------------------------------------------------------------- how close the replay came

export type Agreement = {
  ticks: number;
  /** Share of ticks where the buddy's state matched. */
  state: number;
  /** Share of ticks where both agreed on blocked vs not blocked. */
  blocked: number;
  /** Of ticks both called blocked, share with the same reason; and mean distance between the blocks. */
  reason: number | null;
  blockedAtDiff: number | null;
  /** Hazard cells within 6 m of the runner, mean per tick: phone vs replay, and mean |difference|. */
  obstacle: { recorded: number; replay: number; diff: number };
  drop: { recorded: number; replay: number; diff: number };
  runnerSDiff: number | null;
  buddySDiff: number | null;
  final: { recorded: Snapshot; replay: Snapshot } | null;
  /** Longest stretches where the buddy's state disagreed. */
  disagreements: { from: number; to: number; recorded: string; replay: string }[];
};

export function agreement(ticks: readonly TickCompare[]): Agreement {
  const n = ticks.length;
  const share = (count: number, of: number) => (of === 0 ? 0 : count / of);
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const bothBlocked = ticks.filter(t => t.recorded.blockedAtS !== null && t.replay.blockedAtS !== null);
  const diffs = (pick: (s: Snapshot) => number | null) =>
    ticks.flatMap(t => {
      const a = pick(t.recorded);
      const b = pick(t.replay);
      return a === null || b === null ? [] : [Math.abs(a - b)];
    });
  const cells = (pick: (s: Snapshot) => number) => ({
    recorded: mean(ticks.map(t => pick(t.recorded))) ?? 0,
    replay: mean(ticks.map(t => pick(t.replay))) ?? 0,
    diff: mean(ticks.map(t => Math.abs(pick(t.recorded) - pick(t.replay)))) ?? 0,
  });
  const disagreements: Agreement['disagreements'] = [];
  for (const tick of ticks) {
    const differ = tick.recorded.state !== tick.replay.state;
    const last = disagreements.at(-1);
    if (differ && last && last.recorded === tick.recorded.state && last.replay === tick.replay.state && tick.t - last.to <= 0.6) last.to = tick.t;
    else if (differ) disagreements.push({ from: tick.t, to: tick.t, recorded: String(tick.recorded.state), replay: String(tick.replay.state) });
  }
  disagreements.sort((a, b) => b.to - b.from - (a.to - a.from));
  return {
    ticks: n,
    state: share(ticks.filter(t => t.recorded.state === t.replay.state).length, n),
    blocked: share(ticks.filter(t => (t.recorded.blockedAtS === null) === (t.replay.blockedAtS === null)).length, n),
    reason: bothBlocked.length ? share(bothBlocked.filter(t => t.recorded.reason === t.replay.reason).length, bothBlocked.length) : null,
    blockedAtDiff: mean(diffs(s => s.blockedAtS)),
    obstacle: cells(s => s.obstacle),
    drop: cells(s => s.drop),
    runnerSDiff: mean(diffs(s => s.runnerS)),
    buddySDiff: mean(diffs(s => s.buddyS)),
    final: n ? { recorded: ticks[n - 1].recorded, replay: ticks[n - 1].replay } : null,
    disagreements: disagreements.slice(0, 5),
  };
}
