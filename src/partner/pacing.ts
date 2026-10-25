/**
 * How fast the buddy should go, as pure functions of the runner's speed and its lead, so the
 * pacing can be tested without a path or a frame loop.
 *
 * Two ways to pace:
 *   - 'match' (Quick start, Walk your course): there's no goal pace, so the buddy goes the
 *     runner's own speed, nudged towards its target lead. It never sprints off and waits.
 *   - 'goal' (a planned map route): the buddy is a pacer. It holds the goal pace while the runner
 *     keeps up, and eases down towards their speed as they drop back, rather than running away
 *     and stopping dead.
 * Either way it only stands and jogs on the spot once the runner has actually stopped.
 */

export type PacingMode = 'match' | 'goal';

/** How fast it may ever go, m/s. */
export const MAX_SPEED = 4;
/** Each metre of lead off the target changes the speed by this much, m/s… */
const LEAD_GAIN = 0.4;
/** …up to this much either way, so closing a gap is a gentle drift rather than a dash. */
const MAX_CORRECTION = 0.6;
/** On a route, it starts easing towards the runner's speed this far beyond its target lead. */
const EASE_FROM = 0.5;

export type PaceInput = {
  mode: PacingMode;
  /** The runner's smoothed speed, m/s. */
  runnerSpeed: number;
  /** How far ahead of the runner the buddy is, metres along the path. */
  lead: number;
  targetLead: number;
  maxLead: number;
  /** Goal pace, m/s (only used on routes). */
  goalPace: number;
  /** The coach's push or ease-off from heart rate: 1 is neutral. */
  effort: number;
  /** Uphill below 1, downhill a little above. */
  hill: number;
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function smoothstep(from: number, to: number, x: number) {
  const t = clamp((x - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The speed the buddy should be heading for while it's moving along with the runner.
 *
 * Matching, it goes the runner's speed scaled by the coach's effort (so easing off lets the gap
 * close a little, and pushing pulls ahead), plus a correction towards the target lead. The hill
 * is already in the runner's own speed. On a route it's the goal pace with effort and hill,
 * never slower than a runner who's right behind it, blending towards the runner's speed as the
 * gap opens towards maxLead.
 */
export function paceTarget(p: PaceInput): number {
  const behind = p.lead - p.targetLead;
  const correction = clamp(-LEAD_GAIN * behind, -MAX_CORRECTION, MAX_CORRECTION);
  if (p.mode === 'match') return clamp(p.runnerSpeed * p.effort + correction, 0, MAX_SPEED);

  const goal = p.goalPace * p.effort * p.hill;
  // Caught up: keep ahead, at the runner's speed if they're quicker than the goal.
  if (behind <= 0) return clamp(Math.max(goal, p.runnerSpeed) + correction, 0, MAX_SPEED);
  // Dropping back: ease from the goal pace towards theirs, and a little under it once well ahead.
  const w = smoothstep(EASE_FROM, Math.max(EASE_FROM + 0.1, p.maxLead - p.targetLead), behind);
  const eased = goal + (Math.min(goal, p.runnerSpeed) - goal) * w;
  return clamp(eased + correction * w, 0, MAX_SPEED);
}

/** Runner speed is averaged over this long. */
const SPEED_WINDOW = 1.5;
/** Stopping and starting are judged over this shorter window, to react sooner. */
const STOP_WINDOW = 0.5;
/** Slower than this (m/s) for STOP_HOLD seconds and the runner has stopped… */
const STOP_BELOW = 0.15;
const STOP_HOLD = 0.4;
/** …and faster than this they've set off again. */
const GO_ABOVE = 0.3;
/** A step along the path bigger than this plus MAX_STEP_SPEED·dt is a re-laid path, not movement. */
const JUMP = 0.5;
const MAX_STEP_SPEED = 6;
const HISTORY = SPEED_WINDOW + 0.5;

/**
 * The runner's speed along the path, from their distance along it each frame. Averages over a
 * window rather than per frame (phone tracking wobbles), and ignores the jumps a re-laid path
 * makes in their distance. Judges stopped and moving with hysteresis, so standing still with a
 * swaying phone stays stopped.
 */
export class RunnerSpeed {
  /** Smoothed speed, m/s. */
  speed = 0;
  /** Over the short window, for stopping and starting. */
  recent = 0;
  /** True from the start until the runner first moves, and whenever they've stood still a moment. */
  stopped = true;

  /**
   * The speed to pace them at: the smoothed speed, except just after they set off, when the
   * long average still remembers them standing and would leave them catching the buddy up.
   */
  get pace() {
    return this.sinceGo < SPEED_WINDOW ? Math.max(this.speed, this.recent) : this.speed;
  }

  private time = 0;
  private distance = 0;
  private lastS: number | null = null;
  private slowFor = 0;
  private sinceGo = Infinity;
  /** (time, distance travelled) samples, oldest first. */
  private samples: { t: number; d: number }[] = [];

  reset(runnerS: number) {
    this.speed = 0;
    this.recent = 0;
    this.stopped = true;
    this.time = 0;
    this.distance = 0;
    this.lastS = runnerS;
    this.slowFor = 0;
    this.sinceGo = Infinity;
    this.samples = [{ t: 0, d: 0 }];
  }

  update(dt: number, runnerS: number) {
    if (this.lastS === null) this.reset(runnerS);
    if (dt <= 0) return;
    const step = runnerS - this.lastS!;
    this.lastS = runnerS;
    if (Math.abs(step) <= JUMP + MAX_STEP_SPEED * dt) this.distance += step;
    this.time += dt;
    this.samples.push({ t: this.time, d: this.distance });
    while (this.samples.length > 2 && this.samples[1].t < this.time - HISTORY) this.samples.shift();

    this.speed = this.averageOver(SPEED_WINDOW);
    this.recent = this.averageOver(STOP_WINDOW);
    this.sinceGo += dt;
    if (this.stopped) {
      if (this.recent > GO_ABOVE) {
        this.stopped = false;
        this.slowFor = 0;
        this.sinceGo = 0;
      }
    } else {
      this.slowFor = this.recent < STOP_BELOW ? this.slowFor + dt : 0;
      if (this.slowFor >= STOP_HOLD) this.stopped = true;
    }
  }

  private averageOver(window: number) {
    const since = this.time - window;
    let from = this.samples[0];
    for (const sample of this.samples) {
      if (sample.t > since) break;
      from = sample;
    }
    const span = this.time - from.t;
    // Early on, a short span says little: average over at least a third of the window.
    return Math.max(0, (this.distance - from.d) / Math.max(span, window / 3));
  }
}
