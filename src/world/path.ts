import * as THREE from 'three';
import { CELL_SIZE, type Hazard, type HazardCell, type SurfaceMap } from './surfaceMap';

/** Route samples are evenly spaced, so the sample index is just distance / STEP. */
const STEP = 0.1;
const DASH_SPACING = 0.25;
const DASH_POOL = 160;
const DASHES_BEHIND = 2;
/** How far ahead dashes are drawn by default (the pool covers about this much). */
const DRAW_AHEAD = 38;
/** How far ahead the path drapes onto the ground and checks for hazards. */
const TERRAIN_AHEAD = 35;
const HAZARD_AHEAD = 6;
/** Half-width of the corridor that must be clear for the runner. */
const CORRIDOR = 0.3;
/**
 * Matching to stretches of route that point against the way you are moving costs as much as
 * being this many metres further away (squared). Out-and-back streets need it: both sides run
 * side by side, and only your direction of travel says which one you're on.
 */
const AGAINST_TRAVEL = 16;
/**
 * Direction of travel is re-measured each time you have moved this far, within this long.
 * Slower drift (phone sway while standing, looking around) doesn't count as travelling.
 */
const TRAVEL_STRIDE = 0.5;
const TRAVEL_WITHIN = 2;
/** Ground at least this far above the path's floor, when looking for stairs, is a tread. */
const RAISED_TREAD = 0.1;
/**
 * Stairs are wider than the buddy: at STAIRS_WIDE_SHARE of the treads, there's tread STAIRS_WIDE
 * to either side of the line too, within TREAD_LEVEL of its height (field tests: a chair, a bin
 * and walls the line ran into obliquely all had rising tops along the line, and nothing beside).
 */
const STAIRS_WIDE = 0.4;
const STAIRS_WIDE_SHARE = 0.6;
const TREAD_LEVEL = 0.12;
/**
 * The buddy is about 0.5 m wide: its body reaches BODY_HALF_WIDTH either side of the line and
 * never overlaps a hazardous cell (measured to the edge of the 20 cm cell that flagged it). It
 * keeps BODY_MARGIN more (a cell: what's flagged is often only part of the thing, field tests
 * had a bin's cells confirmed a few at a time) unless the only way through is a squeeze (a
 * doorway, or a gap between noise and a wall), and prefers more still where there's room: closer
 * than ROOMY costs a little, so it goes round on the side with more space. Cells that may be
 * about to become obstacles count as a squeeze too. The first RUNNER_ROOM ahead isn't held to
 * any of that: it's where the runner already is, so whatever is flagged there they're stepping
 * past.
 */
const BODY_HALF_WIDTH = 0.25;
const BODY_MARGIN = 0.2;
const ROOMY = 0.8;
const RUNNER_ROOM = 0.2;
/**
 * The line may run up to DETOUR_MAX to either side of the route, in LATERAL_STEP steps, moving at
 * most one step sideways per sample (45°), and settles back onto the route over RAMP past the
 * stretch that was checked.
 */
const LATERAL_STEP = 0.1;
const DETOUR_MAX = 1.2;
const LANES = Math.round(DETOUR_MAX / LATERAL_STEP);
const RAMP = 1.0;
/**
 * What the plan weighs, per sample, against a metre to the side: squeezing through with no margin
 * (so it goes up to a couple of metres out of its way rather than squeeze), cramped clearance
 * (at the margin), each step sideways, and differing from the last plan (so it doesn't flip
 * between two equally good sides).
 */
const SQUEEZED = 2;
const CRAMPED = 0.5;
const TURNING = 0.2;
const KEEP_PLAN = 0.3;
/** Bending this far to the side counts as going round something (the buddy says so). */
const DETOUR_SHOWN = 0.3;
/** Cells this close to the line along recognised stairs are its treads. */
const STAIRS_HALF_WIDTH = 0.6;
/**
 * When the route ahead is re-laid (follow-me), the drawn line glides from where it was to its
 * new place instead of jumping: what is left of the move shrinks by this rate per second.
 */
const MORPH_RATE = 5;

const UP = new THREE.Vector3(0, 1, 0);
const DASH_BASE = new THREE.Color(0xffb347);
const DASH_HOT = new THREE.Color(0xfff4d6);
const DASH_DIM = new THREE.Color(0x7a4a1c);
const DASH_BLOCKED = new THREE.Color(0xff4b3e);

export type PathStatus = {
  /** Distance along the route where the way is blocked with no clear side, or null. */
  blockedAtS: number | null;
  blockReason: Hazard | null;
  /** True while the path is bending around something. */
  detouring: boolean;
  /** How far along the route the camera has actually seen the ground. */
  seenUntilS: number;
  /**
   * Where along the route the buddy would reach something that may be about to become an
   * obstacle (not confirmed, not ruled out), or null.
   */
  suspectAtS: number | null;
};

export type RoutePoint = { x: number; z: number };

/** A recognised staircase: where it starts and ends along the route, and its bottom and top heights. */
export type StairSpan = { fromS: number; toS: number; fromY: number; toY: number };

/**
 * The route laid over the real ground. Holds the planned line (from a demo shape or a real
 * map route), drapes it onto the ground heights learned by the SurfaceMap, bends it sideways
 * around obstacles, and draws a moving window of glowing dashes around the runner.
 */
export class Path {
  readonly group = new THREE.Group();
  length = 0;
  readonly status: PathStatus = { blockedAtS: null, blockReason: null, detouring: false, seenUntilS: 0, suspectAtS: null };
  /** Dashes are drawn this far ahead of the runner. Shorter than a lap on courses, so laps don't stack. */
  drawAhead = DRAW_AHEAD;
  /** Staircases found along this route. Kept when the route is only re-anchored. */
  stairs: StairSpan[] = [];

  private count = 0;
  private xs = new Float32Array(0);
  private zs = new Float32Array(0);
  /** Unit sideways vector per sample, for detours. */
  private nx = new Float32Array(0);
  private nz = new Float32Array(0);
  private ys = new Float32Array(0);
  private yTarget = new Float32Array(0);
  private offset = new Float32Array(0);
  private offsetTarget = new Float32Array(0);
  /** What is left of a re-lay's move per sample (drawn position minus the route's), easing to 0. */
  private mx = new Float32Array(0);
  private mz = new Float32Array(0);
  private morphing = false;
  /** The line ahead was re-laid since detours were last planned. */
  private replan = false;
  /** First sample that may still be gliding. */
  private morphFrom = 0;
  private lastProjected = 0;
  /** Where direction of travel was last measured from, and that direction (unit, or zero if unknown). */
  private readonly travelFrom = new THREE.Vector3(NaN, 0, NaN);
  private travelFromTime = 0;
  private readonly travel = new THREE.Vector2();

  private readonly dashes: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly hazardScratch: HazardCell[] = [];
  private readonly suspectScratch: { x: number; z: number }[] = [];
  /** The hazards around the line ahead, as of the last plan. */
  private room: Room | null = null;

  constructor() {
    const geometry = new THREE.PlaneGeometry(0.09, 0.15).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
    this.dashes = new THREE.InstancedMesh(geometry, material, DASH_POOL);
    this.dashes.frustumCulled = false;
    for (let i = 0; i < DASH_POOL; i++) {
      this.dashes.setMatrixAt(i, this.hidden);
      this.dashes.setColorAt(i, DASH_BASE);
    }
    this.group.add(this.dashes);
  }

  /**
   * Lay a route. Points are in AR/world metres; `baseY` is the starting floor height. Pass
   * `reanchor` when the same route has only been shifted, to keep what was learned along it.
   */
  setRoute(points: RoutePoint[], baseY: number, reanchor = false) {
    if (!reanchor) this.stairs = [];
    const resampled = resample(points, STEP);
    this.count = resampled.length;
    this.length = (this.count - 1) * STEP;
    this.xs = new Float32Array(this.count);
    this.zs = new Float32Array(this.count);
    this.nx = new Float32Array(this.count);
    this.nz = new Float32Array(this.count);
    this.ys = new Float32Array(this.count).fill(baseY);
    this.yTarget = new Float32Array(this.count).fill(baseY);
    this.offset = new Float32Array(this.count);
    this.offsetTarget = new Float32Array(this.count);
    this.mx = new Float32Array(this.count);
    this.mz = new Float32Array(this.count);
    this.morphing = false;
    resampled.forEach((p, i) => {
      this.xs[i] = p.x;
      this.zs[i] = p.z;
    });
    this.computeSideways(0);
    this.status.blockedAtS = null;
    this.status.blockReason = null;
    this.status.detouring = false;
    this.status.suspectAtS = null;
    this.room = null;
    // A re-anchored route keeps its progress; distances along it haven't changed.
    if (!reanchor) {
      this.lastProjected = 0;
      this.status.seenUntilS = 0;
      this.travelFrom.set(NaN, 0, NaN);
      this.travel.set(0, 0);
    }
  }

  /** Sideways vectors from a smoothed tangent (so sharp corners do not flip detours), from sample `from` on. */
  private computeSideways(from: number) {
    for (let i = Math.max(0, from); i < this.count; i++) {
      const a = Math.max(0, i - 5);
      const b = Math.min(this.count - 1, i + 5);
      let tx = this.xs[b] - this.xs[a];
      let tz = this.zs[b] - this.zs[a];
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      this.nx[i] = tz;
      this.nz[i] = -tx;
    }
  }

  /**
   * Follow-me: keep the route up to `s` exactly as it is (so the buddy and everything behind it
   * stay put, and distances along it still hold) and replace what lies beyond with `ahead`,
   * joined on from the route's point at `s`. Ground heights carry over and detours beyond `s`
   * are re-planned on the next hazard check. The drawn line glides to its new place.
   */
  relayFrom(s: number, ahead: RoutePoint[]) {
    if (!this.ready || ahead.length === 0) return;
    const keep = THREE.MathUtils.clamp(Math.round(s / STEP), 0, this.count - 1);
    const anchor = { x: this.xs[keep], z: this.zs[keep] };
    const tail = resample([anchor, ...ahead], STEP).slice(1);
    if (tail.length === 0) return;
    const old = { count: this.count, xs: this.xs, zs: this.zs, nx: this.nx, nz: this.nz, ys: this.ys, yTarget: this.yTarget, offset: this.offset, offsetTarget: this.offsetTarget, mx: this.mx, mz: this.mz };
    const count = keep + 1 + tail.length;
    const grow = (from: Float32Array) => {
      const next = new Float32Array(count);
      next.set(from.subarray(0, keep + 1));
      return next;
    };
    this.xs = grow(old.xs);
    this.zs = grow(old.zs);
    this.nx = grow(old.nx);
    this.nz = grow(old.nz);
    this.ys = grow(old.ys);
    this.yTarget = grow(old.yTarget);
    this.offset = grow(old.offset);
    this.offsetTarget = grow(old.offsetTarget);
    this.mx = grow(old.mx);
    this.mz = grow(old.mz);
    this.count = count;
    this.length = (count - 1) * STEP;
    tail.forEach((p, k) => {
      const i = keep + 1 + k;
      this.xs[i] = p.x;
      this.zs[i] = p.z;
      // Start from the old ground height here (or the anchor's), and from where it was drawn.
      const was = i < old.count;
      this.ys[i] = was ? old.ys[i] : old.ys[keep];
      this.yTarget[i] = was ? old.yTarget[i] : old.yTarget[keep];
      if (was) {
        this.mx[i] = old.xs[i] + old.nx[i] * old.offset[i] + old.mx[i] - p.x;
        this.mz[i] = old.zs[i] + old.nz[i] * old.offset[i] + old.mz[i] - p.z;
      }
    });
    this.computeSideways(keep - 5);
    // A detour the old line was bending round carries over onto the new one (the next plan
    // adjusts it), so the line doesn't swing back through what it was going round meanwhile.
    for (let i = keep + 1; i < Math.min(count, old.count); i++) {
      const side = old.offset[i] * (old.nx[i] * this.nx[i] + old.nz[i] * this.nz[i]);
      this.offset[i] = this.offsetTarget[i] = side;
      this.mx[i] -= this.nx[i] * side;
      this.mz[i] -= this.nz[i] * side;
    }
    this.replan = true;
    this.morphFrom = this.morphing ? Math.min(this.morphFrom, keep + 1) : keep + 1;
    this.morphing = true;
    this.lastProjected = Math.min(this.lastProjected, count - 1);
    // Staircases found on the old line ahead aren't on this one.
    const cut = keep * STEP;
    this.stairs = this.stairs.filter(span => span.fromS <= cut);
    // (The next hazard check re-plans it, and re-walks how far the ground has been seen.)
    if (this.status.blockedAtS !== null && this.status.blockedAtS > cut) {
      this.status.blockedAtS = null;
      this.status.blockReason = null;
    }
  }

  /** The route's own line at `s`: no detour, ground height or re-lay glide. */
  centreAt(s: number, out: { x: number; z: number }) {
    const f = THREE.MathUtils.clamp(s / STEP, 0, this.count - 1);
    const i = Math.min(Math.floor(f), this.count - 2);
    const t = f - i;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    return out;
  }

  /** How far the drawn line is bent sideways from the route at `s` by a detour. */
  detourAt(s: number, out: { x: number; z: number }) {
    const i = this.index(s);
    out.x = this.nx[i] * this.offset[i];
    out.z = this.nz[i] * this.offset[i];
    return out;
  }

  /** Distance along the route (between `from` and `to`) of its line's point nearest (x, z). Doesn't move progress. */
  closestS(x: number, z: number, from = 0, to = this.length): { s: number; distance: number } {
    let best = this.index(from);
    let bestD = Infinity;
    for (let i = this.index(from); i <= this.index(to); i++) {
      const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { s: best * STEP, distance: Math.sqrt(bestD) };
  }

  get ready() {
    return this.count > 1;
  }

  /** Displayed position (detours and ground height included) at distance `s` along the route. */
  pointAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const f = THREE.MathUtils.clamp(s / STEP, 0, this.count - 1);
    const i = Math.min(Math.floor(f), this.count - 2);
    const t = f - i;
    const lerp = (arr: Float32Array) => arr[i] + (arr[i + 1] - arr[i]) * t;
    const off = lerp(this.offset);
    return out.set(lerp(this.xs) + lerp(this.nx) * off + lerp(this.mx), lerp(this.ys), lerp(this.zs) + lerp(this.nz) * off + lerp(this.mz));
  }

  /** Horizontal direction of travel at `s`, following the displayed (detoured) line. */
  tangentAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const ahead = this.pointAt(s + 0.15, new THREE.Vector3());
    return this.pointAt(s - 0.15, out).negate().add(ahead).setY(0).normalize();
  }

  /** Rise over run of the ground around `s` (positive = uphill). */
  gradeAt(s: number): number {
    const ahead = this.pointAt(s + 0.5, new THREE.Vector3()).y;
    return (ahead - this.pointAt(s - 0.5, new THREE.Vector3()).y) / 1.0;
  }

  /** Distance along the route nearest to a position. Searches near the last answer first. */
  project(position: THREE.Vector3): number {
    this.measureTravel(position);
    const { x: tx, y: tz } = this.travel;
    // Nearest point, but jumps along the route cost extra: you can't teleport, so when two
    // stretches of route run side by side, staying on the one you were on wins. So does the
    // one heading the way you are.
    const search = (from: number, to: number) => {
      let best = from;
      let bestScore = Infinity;
      let bestDistance = Infinity;
      for (let i = from; i <= to; i++) {
        const d = (this.xs[i] - position.x) ** 2 + (this.zs[i] - position.z) ** 2;
        const jump = Math.max(0, Math.abs(i - this.lastProjected) * STEP - 1.5) * 0.35;
        // Route tangent is (-nz, nx).
        const along = -this.nz[i] * tx + this.nx[i] * tz;
        const score = d + jump * jump + Math.max(0, -along) * AGAINST_TRAVEL;
        if (score < bestScore) {
          bestScore = score;
          bestDistance = d;
          best = i;
        }
      }
      return { best, bestDistance };
    };
    // Track progress continuously: look a little behind and further ahead of where you were.
    // A loop starts and ends in the same place, so a whole-route search could jump to the finish.
    const behind = Math.round(15 / STEP);
    const ahead = Math.round(30 / STEP);
    const near = search(Math.max(0, this.lastProjected - behind), Math.min(this.count - 1, this.lastProjected + ahead));
    let best = near.best;
    if (near.bestDistance > 25 * 25) {
      // Really lost (more than 25 m off): search everywhere, preferring places near the last one.
      let score = Infinity;
      for (let i = 0; i < this.count; i++) {
        const d = (this.xs[i] - position.x) ** 2 + (this.zs[i] - position.z) ** 2 + ((i - this.lastProjected) * STEP * 0.5) ** 2;
        if (d < score) {
          score = d;
          best = i;
        }
      }
    }
    this.lastProjected = best;
    return best * STEP;
  }

  private measureTravel(position: THREE.Vector3) {
    const now = performance.now() / 1000;
    const elapsed = now - this.travelFromTime;
    const moved = Math.hypot(position.x - this.travelFrom.x, position.z - this.travelFrom.z);
    if (Number.isNaN(moved) || elapsed > TRAVEL_WITHIN) {
      // Too slow to be a stride (or the first call): start measuring again from here.
      this.travelFrom.copy(position);
      this.travelFromTime = now;
      return;
    }
    if (moved < TRAVEL_STRIDE) return;
    this.travel.set((position.x - this.travelFrom.x) / moved, (position.z - this.travelFrom.z) / moved);
    this.travelFrom.copy(position);
    this.travelFromTime = now;
  }

  /**
   * Called every frame: drape the line ahead onto known ground, ease detours, and redraw the
   * dashes around the runner. `checkHazards` re-plans detours (run it ~10x a second).
   */
  /**
   * Run the route as given, with no obstacle checks: a course the runner has just walked is
   * clear by definition, and phone depth is noisy enough to invent obstacles on it.
   */
  trustRoute = false;

  update(dt: number, timeSeconds: number, runnerS: number, map: SurfaceMap, now: number, checkHazards: boolean) {
    if (!this.ready) return;
    const i0 = this.index(runnerS - DASHES_BEHIND - 1);
    const i1 = this.index(runnerS + TERRAIN_AHEAD);

    this.drape(i0, i1, map, dt);
    if (this.trustRoute) {
      this.status.blockedAtS = null;
      this.status.blockReason = null;
      this.status.detouring = false;
      this.status.seenUntilS = this.length;
      this.status.suspectAtS = null;
    } else if (checkHazards || this.replan) {
      // A re-laid line is planned straight away, not at the next hazard check.
      this.replan = false;
      this.planDetours(runnerS, map, now);
      this.status.seenUntilS = this.seenUntil(runnerS, map);
      this.status.suspectAtS = this.suspectAhead(runnerS);
    }
    const ease = Math.min(1, dt * 2.5);
    for (let i = i0; i <= i1; i++) this.offset[i] += (this.offsetTarget[i] - this.offset[i]) * ease;
    if (this.morphing) this.settleMorph(dt);

    this.drawDashes(timeSeconds, runnerS);
  }

  /** Let a re-laid stretch glide the rest of the way to where it now lies. */
  private settleMorph(dt: number) {
    const keepLeft = Math.exp(-dt * MORPH_RATE);
    let largest = 0;
    for (let i = this.morphFrom; i < this.count; i++) {
      this.mx[i] *= keepLeft;
      this.mz[i] *= keepLeft;
      largest = Math.max(largest, Math.abs(this.mx[i]), Math.abs(this.mz[i]));
    }
    if (largest < 0.002) {
      this.mx.fill(0);
      this.mz.fill(0);
      this.morphing = false;
    }
  }

  private index(s: number) {
    return THREE.MathUtils.clamp(Math.round(s / STEP), 0, this.count - 1);
  }

  /** Ground heights along the line, smoothed so sensor noise does not make it wobble. */
  private drape(i0: number, i1: number, map: SurfaceMap, dt: number) {
    let carry = this.yTarget[i0];
    for (let i = i0; i <= i1; i++) {
      const s = i * STEP;
      const stairs = this.stairs.find(span => s >= span.fromS && s <= span.toS);
      if (stairs) {
        // Climb a staircase as a straight incline from its bottom to its top.
        carry = stairs.fromY + ((stairs.toY - stairs.fromY) * (s - stairs.fromS)) / Math.max(0.1, stairs.toS - stairs.fromS);
      } else {
        const x = this.xs[i] + this.nx[i] * this.offset[i];
        const z = this.zs[i] + this.nz[i] * this.offset[i];
        const ground = map.groundAt(x, z);
        if (ground !== null) carry = ground;
      }
      this.yTarget[i] = carry;
    }
    // Forward then backward smoothing over roughly half a metre.
    for (let i = i0 + 1; i <= i1; i++) this.yTarget[i] += (this.yTarget[i - 1] - this.yTarget[i]) * 0.6;
    for (let i = i1 - 1; i >= i0; i--) this.yTarget[i] += (this.yTarget[i + 1] - this.yTarget[i]) * 0.6;
    const ease = Math.min(1, dt * 4);
    for (let i = i0; i <= i1; i++) this.ys[i] += (this.yTarget[i] - this.ys[i]) * ease;
  }

  /**
   * Where, ahead of the runner, the displayed line first brings the buddy's body (and its
   * margin) up to a suspect cell, one that may be about to become an obstacle; or null. It isn't
   * known to be clear yet, and by the time it's confirmed a buddy a couple of metres ahead would
   * be in it.
   */
  private suspectAhead(runnerS: number): number | null {
    if (!this.room) return null;
    const from = this.index(runnerS + RUNNER_ROOM);
    const to = this.index(runnerS + HAZARD_AHEAD);
    for (let i = from; i <= to; i++) {
      const x = this.xs[i] + this.nx[i] * this.offset[i];
      const z = this.zs[i] + this.nz[i] * this.offset[i];
      if (this.room.clearance(x, z, SUSPECT) < BODY_HALF_WIDTH + BODY_MARGIN) return i * STEP;
    }
    return null;
  }

  /**
   * Walk forward from the runner along the displayed line until the ground is unknown. Short
   * unseen gaps (a missed cell or two) are tolerated; a 40 cm gap ends the seen stretch.
   */
  private seenUntil(runnerS: number, map: SurfaceMap): number {
    const start = this.index(Math.max(0, runnerS));
    const end = this.index(runnerS + TERRAIN_AHEAD);
    const allowedGap = Math.round(0.4 / STEP);
    let gap = 0;
    let lastSeen = start;
    for (let i = start; i <= end; i++) {
      const x = this.xs[i] + this.nx[i] * this.offset[i];
      const z = this.zs[i] + this.nz[i] * this.offset[i];
      if (map.groundAt(x, z) !== null || this.stairsAt(i * STEP)) {
        gap = 0;
        lastSeen = i;
      } else if (++gap > allowedGap) break;
    }
    return lastSeen * STEP;
  }

  private hazardAtOffset(i: number, side: number, map: SurfaceMap, now: number): Hazard | null {
    const hazard = map.hazardAt(this.xs[i] + this.nx[i] * side, this.zs[i] + this.nz[i] * side, CORRIDOR, now);
    // Just past the top of known stairs, the steps below look like a drop. They're the stairs.
    const s = i * STEP;
    if (hazard === 'drop' && this.stairs.some(span => s > span.toS && s <= span.toS + 0.8)) return null;
    return hazard;
  }

  /**
   * Re-plan the line ahead (to HAZARD_AHEAD): first recognise stairs and landings along it, then
   * pick how far to the side the line runs at each point so the buddy's body keeps clear of
   * every hazard (see BODY_HALF_WIDTH), or mark where there's no way through.
   */
  private planDetours(runnerS: number, map: SurfaceMap, now: number) {
    const a = this.index(runnerS);
    const b = this.index(runnerS + HAZARD_AHEAD);
    const e = Math.min(this.count - 1, b + Math.round(RAMP / STEP));
    const previous = this.offsetTarget.slice(a, e + 1);
    this.offsetTarget.fill(0, a, e + 1);
    this.status.blockedAtS = null;
    this.status.blockReason = null;
    this.status.detouring = false;
    this.findStairs(a, b, map, now);
    const room = this.roomAround(a, e, map, now);
    this.room = room;

    // Best line through the sideways positions (LATERAL_STEP apart), sample by sample: as little
    // to the side as possible, roomy where there's room, steady, and like the last plan.
    const lanes = 2 * LANES + 1;
    const samples = e - a + 1;
    const cost = new Float64Array(samples * lanes).fill(Infinity);
    const from = new Int8Array(samples * lanes);
    let blockedAt = -1;
    for (let k = 0; k < samples; k++) {
      const i = a + k;
      const onStairs = this.stairsAt(i * STEP) !== undefined;
      let reachable = false;
      for (let j = 0; j < lanes; j++) {
        const side = (j - LANES) * LATERAL_STEP;
        let here = Math.abs(side) + KEEP_PLAN * Math.abs(side - (previous[k] ?? 0));
        if (onStairs) {
          // Straight up recognised stairs; their treads aren't in the way.
          if (side !== 0) continue;
        } else if (i <= b && k * STEP >= RUNNER_ROOM) {
          const clear = room.clearance(this.xs[i] + this.nx[i] * side, this.zs[i] + this.nz[i] * side, this.dropsIgnoredAt(i * STEP) ? OBSTACLE : OBSTACLE | DROP);
          const margin = BODY_HALF_WIDTH + BODY_MARGIN;
          if (clear < BODY_HALF_WIDTH) continue;
          if (clear < margin) here += SQUEEZED * ((margin - clear) / BODY_MARGIN) ** 2;
          if (clear < ROOMY) here += CRAMPED * ((ROOMY - Math.max(clear, margin)) / (ROOMY - margin)) ** 2;
          const suspect = room.clearance(this.xs[i] + this.nx[i] * side, this.zs[i] + this.nz[i] * side, SUSPECT);
          if (suspect < margin) here += SQUEEZED * Math.min(1, (margin - suspect) / BODY_MARGIN) ** 2;
        }
        let best = k === 0 ? 0 : Infinity;
        let bestFrom = 0;
        if (k > 0) {
          for (let step = -1; step <= 1; step++) {
            const was = j + step;
            if (was < 0 || was >= lanes) continue;
            const c = cost[(k - 1) * lanes + was] + (step === 0 ? 0 : TURNING);
            if (c < best) {
              best = c;
              bestFrom = was;
            }
          }
        }
        if (best === Infinity) continue;
        cost[k * lanes + j] = best + here;
        from[k * lanes + j] = bestFrom;
        reachable = true;
      }
      if (!reachable) {
        blockedAt = k;
        break;
      }
    }

    const last = blockedAt === -1 ? samples - 1 : blockedAt - 1;
    if (last >= 0) {
      let j = 0;
      for (let l = 1; l < lanes; l++) if (cost[last * lanes + l] < cost[last * lanes + j]) j = l;
      for (let k = last; k >= 0; k--) {
        this.offsetTarget[a + k] = (j - LANES) * LATERAL_STEP;
        j = from[k * lanes + j];
      }
      // Past a block the line holds its side (it's drawn red there anyway).
      this.offsetTarget.fill(this.offsetTarget[a + last], a + last + 1, e + 1);
    }
    for (let i = a; i <= b; i++) if (Math.abs(this.offsetTarget[i]) >= DETOUR_SHOWN) this.status.detouring = true;
    if (blockedAt !== -1) {
      const i = a + blockedAt;
      this.status.blockedAtS = i * STEP;
      this.status.blockReason = room.worstNear(this.xs[i], this.zs[i], DETOUR_MAX + BODY_HALF_WIDTH + BODY_MARGIN, this.dropsIgnoredAt(i * STEP));
    }
  }

  /**
   * Walk the line ahead for blocked stretches that are stairs going up (they're climbed, not
   * avoided), and claim the landing past their top as ground.
   */
  private findStairs(a: number, b: number, map: SurfaceMap, now: number) {
    let i = a;
    while (i <= b) {
      const hazard = this.stairsAt(i * STEP) ? null : this.hazardAtOffset(i, 0, map, now);
      if (!hazard || this.claimLanding(i, map, now)) {
        i++;
        continue;
      }
      let end = i;
      let worst: Hazard = hazard;
      while (end + 1 <= b) {
        const next = this.stairsAt((end + 1) * STEP) ? null : this.hazardAtOffset(end + 1, 0, map, now);
        if (!next) break;
        if (next === 'obstacle') worst = 'obstacle';
        end++;
      }
      const stairs = worst === 'obstacle' ? this.detectStairs(i, map, now) : null;
      if (stairs) this.markStairs(stairs);
      i = stairs ? this.index(stairs.toS) + 1 : end + 1;
    }
  }

  /** Just past the top of known stairs, the steps below look like a drop. They're the stairs. */
  private dropsIgnoredAt(s: number) {
    return this.stairs.some(span => s > span.toS && s <= span.toS + 0.8);
  }

  /**
   * The hazards around samples a..e, wide enough for every sideways position tried, with the
   * treads of recognised stairs left out.
   */
  private roomAround(a: number, e: number, map: SurfaceMap, now: number): Room {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = a; i <= e; i++) {
      x0 = Math.min(x0, this.xs[i]);
      x1 = Math.max(x1, this.xs[i]);
      z0 = Math.min(z0, this.zs[i]);
      z1 = Math.max(z1, this.zs[i]);
    }
    const pad = DETOUR_MAX + ROOMY + CELL_SIZE;
    const radius = Math.max(x1 - x0, z1 - z0) / 2 + pad;
    const room = new Room((x0 + x1) / 2, (z0 + z1) / 2, radius);
    for (const cell of map.hazardCells((x0 + x1) / 2, (z0 + z1) / 2, radius, now, this.hazardScratch, this.suspectScratch)) {
      room.add(cell.x, cell.z, cell.kind === 'obstacle' ? OBSTACLE : DROP);
    }
    for (const cell of this.suspectScratch) room.add(cell.x, cell.z, SUSPECT);
    for (const span of this.stairs) {
      for (let i = this.index(span.fromS); i <= this.index(span.toS); i++) {
        if (i < a || i > e) continue;
        room.clear(this.xs[i], this.zs[i], STAIRS_HALF_WIDTH);
      }
    }
    return room;
  }

  /**
   * Does the blocked stretch starting at sample i0 look like stairs going up? Reads obstacle
   * tops along the line. Stairs rise steadily: tops never drop by more than a few cm, keep
   * climbing over at least half a metre of path, reach 25 cm–1.5 m, at a stair-like slope.
   * A box (flat top), a wall (one tall face) or a drop does not match.
   *
   * Individual steps are not required to show up: map cells (20 cm) don't line up with treads
   * (25–35 cm), so a cell's top often reads as the higher of two neighbouring steps.
   */
  private detectStairs(i0: number, map: SurfaceMap, now: number): StairSpan | null {
    const base = this.ys[Math.max(0, i0 - 3)];
    const tops: { k: number; h: number; wide: boolean }[] = [];
    // Treads the phone's floor detection already found (raised ground) count as much as
    // obstacle tops seen by depth: near ones are often learned as ground before depth confirms them.
    const topAt = (x: number, z: number) => {
      const ground = map.groundAt(x, z);
      return map.obstacleTopAt(x, z, now) ?? (ground !== null && ground - base >= RAISED_TREAD ? ground : null);
    };
    for (let k = 0; k < 45 && i0 + k < this.count; k++) {
      const i = i0 + k;
      const top = topAt(this.xs[i], this.zs[i]);
      if (top === null) continue;
      const h = top - base;
      const previous = tops.at(-1);
      // A sudden tall jump (a wall or railing on the landing) or a drop ends the staircase.
      if (previous && (h - previous.h > 0.35 || h < previous.h - 0.06)) break;
      // A tread runs across the way, to both sides of the line, at about the same height.
      const across = [-STAIRS_WIDE, STAIRS_WIDE].every(side => {
        const beside = topAt(this.xs[i] + this.nx[i] * side, this.zs[i] + this.nz[i] * side);
        return beside !== null && Math.abs(beside - top) <= TREAD_LEVEL;
      });
      tops.push({ k, h: Math.max(h, previous?.h ?? h), wide: across });
    }
    if (tops.length < 4) return null;
    // A bin, a chair or the edge of a wall the line runs into is narrower than any staircase.
    if (tops.filter(t => t.wide).length < STAIRS_WIDE_SHARE * tops.length) return null;
    const first = tops[0];
    const highest = tops.reduce((best, t) => (t.h > best.h + 0.02 ? t : best), first);
    const run = (highest.k - first.k) * STEP;
    const slope = run > 0 ? (highest.h - first.h) / run : 0;
    const isStairs = run >= 0.5 && highest.h >= 0.25 && highest.h <= 1.5 && first.h <= 0.45 && slope >= 0.15 && slope <= 1.2;
    return isStairs ? { fromS: i0 * STEP, toS: (i0 + highest.k) * STEP, fromY: base, toY: base + highest.h } : null;
  }

  /** Remember a staircase and turn its treads into ground so the path can climb it. */
  /**
   * Remember a staircase. Its cells are left as they are (a 20 cm grid can't hold 30 cm treads
   * faithfully); instead the path climbs it as a straight incline and hazards on it are ignored.
   */
  private markStairs(span: StairSpan) {
    const overlapping = this.stairs.find(s => span.fromS <= s.toS + 0.3 && span.toS >= s.fromS - 0.3);
    if (!overlapping) {
      this.stairs.push({ ...span });
      return;
    }
    overlapping.fromS = Math.min(overlapping.fromS, span.fromS);
    overlapping.toY = Math.max(overlapping.toY, span.toY);
    overlapping.toS = Math.max(overlapping.toS, span.toS);
  }

  private stairsAt(s: number): StairSpan | undefined {
    return this.stairs.find(span => s >= span.fromS - 0.3 && s <= span.toS + 0.1);
  }

  /** True if `s` is on, or just before, a recognised staircase. */
  onStairs(s: number): boolean {
    return this.stairs.some(span => s >= span.fromS - 0.6 && s <= span.toS + 0.2);
  }

  /**
   * Just past the top of a staircase, flat obstacle cells at the staircase's top height are the
   * landing, not an obstacle: make them ground so ground knowledge can spread across it.
   */
  private claimLanding(i: number, map: SurfaceMap, now: number): boolean {
    const s = i * STEP;
    const span = this.stairs.find(st => s > st.toS && s <= st.toS + 3);
    if (!span) return false;
    // Check the whole corridor, not just the centre line: the hazard may be a cell beside it.
    // Anything no higher than the landing is the landing or one of the steps up to it.
    map.promoteToGround(this.xs[i], this.zs[i], CORRIDOR + 0.1, now, { from: span.fromY, to: span.toY + 0.1 });
    return this.hazardAtOffset(i, 0, map, now) === null;
  }

  /** A fixed pool of dashes slides along with the runner, so long routes cost nothing extra. */
  private drawDashes(timeSeconds: number, runnerS: number) {
    const first = Math.ceil((runnerS - DASHES_BEHIND) / DASH_SPACING) * DASH_SPACING;
    const pulse = runnerS + ((timeSeconds * 3) % 6);
    const blocked = this.status.blockedAtS;
    for (let k = 0; k < DASH_POOL; k++) {
      const s = first + k * DASH_SPACING;
      if (s < 0 || s > this.length || s > runnerS + this.drawAhead) {
        this.dashes.setMatrixAt(k, this.hidden);
        continue;
      }
      this.pointAt(s, this.position).y += 0.012;
      this.tangentAt(s, this.tangent);
      this.rotation.setFromAxisAngle(UP, Math.atan2(this.tangent.x, this.tangent.z));
      this.dashes.setMatrixAt(k, this.matrix.compose(this.position, this.rotation, unitScale));
      if (blocked !== null && s >= blocked) this.color.copy(DASH_BLOCKED);
      else if (s < runnerS - 0.3) this.color.copy(DASH_DIM);
      else this.color.copy(DASH_BASE).lerp(DASH_HOT, Math.max(0, 1 - Math.abs(s - pulse) / 0.8));
      this.dashes.setColorAt(k, this.color);
    }
    this.dashes.instanceMatrix.needsUpdate = true;
    if (this.dashes.instanceColor) this.dashes.instanceColor.needsUpdate = true;
  }
}

const unitScale = new THREE.Vector3(1, 1, 1);

const NO_HAZARD = 0;
const OBSTACLE = 1;
const DROP = 2;
/** Not a hazard yet, but may be about to become an obstacle (see SurfaceMap.hazardCells). */
const SUSPECT = 4;
/** Clearance is looked for this many cells out (anything further is roomy enough). */
const REACH = Math.ceil(ROOMY / CELL_SIZE) + 1;

/** The hazard cells in a square patch of the map, for answering "how much room is here" quickly. */
class Room {
  private readonly ix0: number;
  private readonly iz0: number;
  private readonly size: number;
  private readonly kinds: Uint8Array;

  constructor(x: number, z: number, radius: number) {
    const r = Math.ceil(radius / CELL_SIZE) + REACH;
    this.ix0 = Math.floor(x / CELL_SIZE) - r;
    this.iz0 = Math.floor(z / CELL_SIZE) - r;
    this.size = 2 * r + 1;
    this.kinds = new Uint8Array(this.size * this.size);
  }

  private at(ix: number, iz: number) {
    const u = ix - this.ix0;
    const v = iz - this.iz0;
    return u < 0 || v < 0 || u >= this.size || v >= this.size ? -1 : u * this.size + v;
  }

  add(x: number, z: number, kind: number) {
    const k = this.at(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE));
    if (k >= 0) this.kinds[k] = kind;
  }

  /** Forget hazards in cells whose centre is within `radius` of a point. */
  clear(x: number, z: number, radius: number) {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const k = this.at(cx + dx, cz + dz);
        if (k < 0 || Math.hypot((cx + dx + 0.5) * CELL_SIZE - x, (cz + dz + 0.5) * CELL_SIZE - z) > radius) continue;
        this.kinds[k] = NO_HAZARD;
      }
    }
  }

  /**
   * Distance from a point to the edge of the nearest cell of the kinds in `mask` (ROOMY or more
   * if none is near).
   */
  clearance(x: number, z: number, mask: number): number {
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    let best = REACH * CELL_SIZE;
    for (let dx = -REACH; dx <= REACH; dx++) {
      for (let dz = -REACH; dz <= REACH; dz++) {
        const k = this.at(cx + dx, cz + dz);
        if (k < 0 || (this.kinds[k] & mask) === 0) continue;
        const ex = Math.max(0, Math.abs(x - (cx + dx + 0.5) * CELL_SIZE) - CELL_SIZE / 2);
        const ez = Math.max(0, Math.abs(z - (cz + dz + 0.5) * CELL_SIZE) - CELL_SIZE / 2);
        best = Math.min(best, Math.hypot(ex, ez));
      }
    }
    return best;
  }

  /** What's in the way within `radius` of a point: an obstacle if there's one, else a drop. */
  worstNear(x: number, z: number, radius: number, ignoreDrops: boolean): Hazard {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    let drop = false;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const k = this.at(cx + dx, cz + dz);
        if (k < 0) continue;
        if (this.kinds[k] === OBSTACLE) return 'obstacle';
        if (this.kinds[k] === DROP && !ignoreDrops) drop = true;
      }
    }
    return drop ? 'drop' : 'obstacle';
  }
}

/** Evenly re-space a polyline so every sample is `step` metres apart. */
export function resample(points: RoutePoint[], step: number): RoutePoint[] {
  if (points.length < 2) return points.slice();
  const out: RoutePoint[] = [{ ...points[0] }];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1].x;
    const az = points[i - 1].z;
    const segment = Math.hypot(points[i].x - ax, points[i].z - az);
    if (segment === 0) continue;
    let d = step - carry;
    while (d <= segment) {
      const t = d / segment;
      out.push({ x: ax + (points[i].x - ax) * t, z: az + (points[i].z - az) * t });
      d += step;
    }
    carry = segment - (d - step);
  }
  return out;
}

/** The indoor demo route: a gentle S-curve heading away from where the user stands. */
export function demoRoute(start: THREE.Vector3, direction: THREE.Vector3, length: number): RoutePoint[] {
  // Straight ahead: a wavy line looked lively in a room but just looked wrong on a sidewalk.
  const points: RoutePoint[] = [];
  for (let u = 0; u <= length; u += 0.5) points.push({ x: start.x + direction.x * u, z: start.z + direction.z * u });
  return points;
}
