import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { DepthVerdict, SurfaceProbe } from '../world/surfaceMap';

/** Snapshots twice a second; uploads every few seconds. */
const TICK_EVERY = 0.5;
const UPLOAD_EVERY = 5;
/** Depth heights (relative to the known ground) are binned in 2 cm steps over ±40 cm. */
const BIN = 0.02;
const HALF_BINS = 20;
/** Depth readings are split by distance, since noise grows with it. */
const RANGE_BANDS = [2, 3.5, Infinity];
const VERDICTS: DepthVerdict[] = ['ground', 'obstacle', 'drop', 'between', 'out of range', 'no ground'];

type Band = { verdicts: Record<string, number>; hist: number[] };
type Entry = { t: number; kind: string; data: unknown };

/**
 * Field-test mode (`?field` in the link): records what the sensors and the surface map are
 * doing while you walk around outside, and uploads it to Convex so it can be studied
 * afterwards. Heights are histograms, not raw points, to keep the upload small.
 */
export class FieldLog implements SurfaceProbe {
  readonly enabled = new URLSearchParams(location.search).has('field');
  readonly session = `${new Date().toISOString().slice(0, 16)}-${Math.random().toString(36).slice(2, 6)}`;
  sent = 0;
  failed = 0;
  private client: ConvexClient | null;
  private pending: Entry[] = [];
  private startedAt = performance.now() / 1000;
  private lastTick = 0;
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

  ground(diff: number | null, accepted: boolean, weight: number) {
    if (weight < 1) return;
    if (diff === null) this.groundStats.unknown++;
    else {
      this.groundStats.hist[binOf(diff)]++;
      if (accepted) this.groundStats.accepted++;
      else this.groundStats.rejected++;
    }
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
    }));
    this.groundStats = { accepted: 0, rejected: 0, unknown: 0, hist: new Array(HALF_BINS * 2 + 2).fill(0) };
  }
}

/** Bin index: 0 = below −40 cm, 1..40 = 2 cm steps, 41 = above +40 cm. */
function binOf(height: number) {
  if (height < -HALF_BINS * BIN) return 0;
  if (height >= HALF_BINS * BIN) return HALF_BINS * 2 + 1;
  return Math.floor(height / BIN) + HALF_BINS + 1;
}
