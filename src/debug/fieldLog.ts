import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { DepthVerdict, SurfaceProbe } from '../world/surfaceMap';

/** Snapshots twice a second, raw sensor frames five times a second; uploads every few seconds. */
const TICK_EVERY = 0.5;
const FRAME_EVERY = 0.2;
const UPLOAD_EVERY = 5;
/** Depth heights (relative to the known ground) are binned in 2 cm steps over ±40 cm. */
const BIN = 0.02;
const HALF_BINS = 20;
/** Depth readings are split by distance, since noise grows with it. */
const RANGE_BANDS = [2, 3.5, Infinity];
const VERDICTS: DepthVerdict[] = ['ground', 'obstacle', 'drop', 'between', 'out of range', 'no ground'];

type Band = { verdicts: Record<string, number>; hist: number[]; ratio: number[] };
/** Depth-over-floor ratios are binned in 2.5% steps from 0.5 to 1.5. */
const RATIO_STEP = 0.025;
const RATIO_BINS = 40;
type Entry = { t: number; kind: string; data: unknown };

/**
 * Field-test mode: records what the sensors and the surface map are doing while you walk
 * around outside, and uploads it to Convex so it can be studied afterwards. Heights are
 * histograms, not raw points, to keep the upload small.
 *
 * On by default while the outdoor thresholds are being tuned; `?nofield` turns it off.
 */
export const FIELD_TEST = !new URLSearchParams(location.search).has('nofield');

export class FieldLog implements SurfaceProbe {
  readonly enabled = FIELD_TEST;
  /** The last snapshot's depth and ground-sample statistics, for the on-screen readout. */
  last: { bands: Band[]; ground: { accepted: number; rejected: number; unknown: number; hist: number[] } } | null = null;
  readonly session = `${new Date().toISOString().slice(0, 16)}-${Math.random().toString(36).slice(2, 6)}`;
  sent = 0;
  failed = 0;
  private client: ConvexClient | null;
  private pending: Entry[] = [];
  private startedAt = performance.now() / 1000;
  private lastTick = 0;
  private lastFrame = 0;
  private lastProjection = '';
  frames = 0;
  marks = 0;
  private lastUpload = 0;
  private bands: Band[] = [];
  private groundStats = { accepted: 0, rejected: 0, unknown: 0, hist: [] as number[] };

  constructor(client: ConvexClient | null) {
    this.client = client;
    this.resetCounts();
  }

  depth(height: number, range: number, verdict: DepthVerdict) {
    const band = this.bands[RANGE_BANDS.findIndex(limit => range < limit)];
    band.verdicts[verdict]++;
    if (Number.isFinite(height)) band.hist[binOf(height)]++;
  }

  ratio(ratio: number, range: number) {
    const band = this.bands[RANGE_BANDS.findIndex(limit => range < limit)];
    const bin = ratio < 0.5 ? 0 : ratio >= 1.5 ? RATIO_BINS + 1 : Math.floor((ratio - 0.5) / RATIO_STEP) + 1;
    band.ratio[bin]++;
  }

  ground(diff: number | null, accepted: boolean, weight: number) {
    if (weight < 1) return;
    if (diff === null) this.groundStats.unknown++;
    else {
      this.groundStats.hist[binOf(diff)]++;
      if (accepted) this.groundStats.accepted++;
      else this.groundStats.rejected++;
    }
  }

  /**
   * Raw sensor readings for replaying a walk on the laptop: the view's pose (and projection when
   * it changes), the depth grid in millimetres, and the floor hits since the last frame.
   */
  frame(now: number, raw: { pose: number[]; projection: number[]; grid: Uint16Array; hits: number[][] }) {
    if (!this.enabled || now - this.lastFrame < FRAME_EVERY || raw.pose.length === 0) return;
    this.lastFrame = now;
    const projection = raw.projection.map(n => +n.toFixed(6)).join(',');
    const bytes = new Uint8Array(raw.grid.buffer, raw.grid.byteOffset, raw.grid.byteLength);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    this.pending.push({
      t: this.clock(),
      kind: 'frame',
      data: {
        pose: raw.pose.map(n => +n.toFixed(5)),
        ...(projection !== this.lastProjection ? { projection: raw.projection.map(n => +n.toFixed(6)) } : {}),
        depth: btoa(binary),
        hits: raw.hits.splice(0).map(hit => hit.map(n => +n.toFixed(4))),
      },
    });
    this.lastProjection = projection;
    this.frames++;
  }

  /** The runner tapped Mark: something worth looking at happened here. */
  mark(details: Record<string, unknown>) {
    if (!this.enabled) return;
    this.marks++;
    this.event('mark', { n: this.marks, ...details });
  }

  /** A one-off event, e.g. where and how a run was placed. */
  event(kind: string, data: unknown) {
    if (!this.enabled) return;
    this.pending.push({ t: this.clock(), kind, data });
  }

  /** Call every frame; takes a snapshot when one is due (the callback only runs then). */
  tick(now: number, snapshot: () => Record<string, unknown>) {
    if (!this.enabled) return;
    if (now - this.lastTick >= TICK_EVERY) {
      this.lastTick = now;
      this.pending.push({
        t: this.clock(),
        kind: 'tick',
        data: { ...snapshot(), depth: this.bands, groundSamples: this.groundStats },
      });
      this.last = { bands: this.bands, ground: this.groundStats };
      this.resetCounts();
    }
    if (now - this.lastUpload >= UPLOAD_EVERY) {
      this.lastUpload = now;
      this.upload();
    }
  }

  upload() {
    if (!this.client || this.pending.length === 0) return;
    const entries = this.pending;
    this.pending = [];
    this.client
      .mutation(api.fieldLog.add, { session: this.session, entries })
      .then(() => (this.sent += entries.length))
      .catch(() => {
        this.failed += entries.length;
        // Keep the newest data for the next try, without growing forever.
        this.pending = [...entries, ...this.pending].slice(-120);
      });
  }

  private clock() {
    return Math.round((performance.now() / 1000 - this.startedAt) * 100) / 100;
  }

  private resetCounts() {
    this.bands = RANGE_BANDS.map(() => ({
      verdicts: Object.fromEntries(VERDICTS.map(verdict => [verdict, 0])),
      hist: new Array(HALF_BINS * 2 + 2).fill(0),
      ratio: new Array(RATIO_BINS + 2).fill(0),
    }));
    this.groundStats = { accepted: 0, rejected: 0, unknown: 0, hist: new Array(HALF_BINS * 2 + 2).fill(0) };
  }
}

/** Readout lines from a snapshot: per distance band, what the depth said and how high it was. */
export function summaryRows(last: NonNullable<FieldLog['last']>): [string, string][] {
  const names = ['depth <2m', 'depth 2-3.5', 'depth 3.5+'];
  const rows: [string, string][] = last.bands.map((band, i) => {
    const v = band.verdicts;
    const judged = v.ground + v.obstacle + v.drop + v.between;
    if (judged === 0) return [names[i], v['no ground'] ? `${v['no ground']} pts, no ground known yet` : 'no points'];
    const pct = (n: number) => `${Math.round((100 * n) / judged)}%`;
    return [names[i], `gnd ${pct(v.ground)} drop ${pct(v.drop)} obs ${pct(v.obstacle)} mid ${cm(medianOf(band.hist))}`];
  });
  const ratios = last.bands.map(band => ratioMedian(band.ratio));
  if (ratios.some(r => r !== null)) rows.push(['depth/floor', ratios.map(r => (r === null ? '–' : `×${r.toFixed(2)}`)).join('  ') + ' (1.00 = right)']);
  const g = last.ground;
  const total = g.accepted + g.rejected;
  rows.push(['floor hits', total === 0 ? `${g.unknown}, no ground known yet` : `${g.accepted}/${total} agree, typ. off ${cm(medianOf(g.hist))}`]);
  return rows;
}

function cm(metres: number | null) {
  if (metres === null) return '–';
  const value = Math.round(metres * 100);
  return `${value > 0 ? '+' : ''}${value} cm`;
}

function ratioMedian(hist: number[]): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= total / 2) return i === 0 ? 0.5 : i === hist.length - 1 ? 1.5 : 0.5 + (i - 0.5) * RATIO_STEP;
  }
  return null;
}

/** Median of a binned histogram (centre of the median bin), or null if empty. */
function medianOf(hist: number[]): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= total / 2) {
      if (i === 0) return -HALF_BINS * BIN;
      if (i === hist.length - 1) return HALF_BINS * BIN;
      return (i - HALF_BINS - 1 + 0.5) * BIN;
    }
  }
  return null;
}

/** Bin index: 0 = below −40 cm, 1..40 = 2 cm steps, 41 = above +40 cm. */
function binOf(height: number) {
  if (height < -HALF_BINS * BIN) return 0;
  if (height >= HALF_BINS * BIN) return HALF_BINS * 2 + 1;
  return Math.floor(height / BIN) + HALF_BINS + 1;
}
