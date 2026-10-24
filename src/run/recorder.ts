import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

const SAMPLE_EVERY = 3;
const FLUSH_EVERY = 15;
/** Your pace is smoothed over this many seconds so a single step doesn't swing it. */
const PACE_WINDOW = 6;
/** Recorded distance never grows faster than a sprint, so one bad projection can't add metres. */
const MAX_SPEED = 9;

export type RunSummary = {
  distance: number;
  duration: number;
  avgHr?: number;
  maxHr?: number;
  breaks: number;
  stars: number;
  coins: number;
};

type Sample = { t: number; distance: number; pace: number; hr?: number };

/** One point a second for the end-of-run chart (kept on the phone, not uploaded). */
export type TracePoint = { t: number; hr: number | null; pace: number; breaking: boolean };

/**
 * Tracks the runner's own progress (distance, smoothed pace, heart rate, breaks) and saves it
 * to Convex as the run goes. Works offline too: without a connection it still produces the
 * end-of-run summary.
 */
export class RunRecorder {
  /** Runner's smoothed pace in metres per second. */
  pace = 0;
  stars = 0;
  coins = 0;

  private client: ConvexClient | null;
  private runId: Id<'runs'> | null = null;
  private startedAt = 0;
  private distance = 0;
  private lastUpdate = 0;
  private history: { t: number; s: number }[] = [];
  private pending: Sample[] = [];
  private points: TracePoint[] = [];
  private lastSample = 0;
  private lastFlush = 0;
  private hrSum = 0;
  private hrCount = 0;
  private hrMax = 0;
  private breaks = 0;
  private wasBreaking = false;

  constructor(client: ConvexClient | null) {
    this.client = client;
  }

  get distanceSoFar() {
    return this.distance;
  }

  /** The run so far, one point a second. */
  get trace(): readonly TracePoint[] {
    return this.points;
  }

  start(now: number, details: { kind: 'quick' | 'route'; goalPaceSecPerKm: number; zone: { low: number; high: number }; routeDistance?: number }) {
    Object.assign(this, { pace: 0, stars: 0, coins: 0, distance: 0, hrSum: 0, hrCount: 0, hrMax: 0, breaks: 0, wasBreaking: false });
    this.startedAt = now;
    this.lastSample = now;
    this.lastFlush = now;
    this.lastUpdate = now;
    this.history = [];
    this.pending = [];
    this.points = [];
    this.runId = null;
    this.client
      ?.mutation(api.runs.start, {
        kind: details.kind,
        goalPaceSecPerKm: details.goalPaceSecPerKm,
        zoneLow: details.zone.low,
        zoneHigh: details.zone.high,
        routeDistance: details.routeDistance,
      })
      .then(id => {
        this.runId = id;
      })
      .catch(() => {});
  }

  /** Call every frame with the runner's distance along the route. */
  update(now: number, runnerS: number, bpm: number | null, breaking: boolean) {
    const dt = Math.max(0, now - this.lastUpdate);
    this.lastUpdate = now;
    if (runnerS > this.distance) this.distance = Math.min(runnerS, this.distance + MAX_SPEED * dt);
    // Pace and samples use the capped distance too, so a route re-anchor can't fake a sprint.
    this.history.push({ t: now, s: this.distance });
    while (this.history.length > 2 && now - this.history[0].t > PACE_WINDOW) this.history.shift();
    const oldest = this.history[0];
    const span = now - oldest.t;
    if (span > 1) this.pace = Math.max(0, (this.distance - oldest.s) / span);

    if (bpm !== null) {
      this.hrSum += bpm;
      this.hrCount++;
      this.hrMax = Math.max(this.hrMax, bpm);
    }
    const t = now - this.startedAt;
    if (t - (this.points.at(-1)?.t ?? -1) >= 1) this.points.push({ t, hr: bpm, pace: this.pace, breaking });
    if (breaking && !this.wasBreaking) this.breaks++;
    this.wasBreaking = breaking;

    if (now - this.lastSample >= SAMPLE_EVERY) {
      this.lastSample = now;
      this.pending.push({ t: now - this.startedAt, distance: this.distance, pace: this.pace, hr: bpm ?? undefined });
    }
    if (now - this.lastFlush >= FLUSH_EVERY) this.flush(now);
  }

  finish(now: number): RunSummary {
    const summary: RunSummary = {
      distance: this.distance,
      duration: now - this.startedAt,
      avgHr: this.hrCount ? this.hrSum / this.hrCount : undefined,
      maxHr: this.hrCount ? this.hrMax : undefined,
      breaks: this.breaks,
      stars: this.stars,
      coins: this.coins,
    };
    this.flush(now);
    const runId = this.runId;
    if (runId) this.client?.mutation(api.runs.finish, { runId, summary }).catch(() => {});
    this.runId = null;
    return summary;
  }

  private flush(now: number) {
    this.lastFlush = now;
    if (!this.runId || this.pending.length === 0) return;
    const samples = this.pending;
    this.pending = [];
    this.client?.mutation(api.runs.addSamples, { runId: this.runId, samples }).catch(() => {});
  }
}
