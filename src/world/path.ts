import * as THREE from 'three';
import type { Hazard, SurfaceMap } from './surfaceMap';

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
/** Direction of travel is re-measured each time you have moved this far. */
const TRAVEL_STRIDE = 0.5;
/** Side-steps tried, in metres, when something blocks the way. */
const DETOURS = [0.6, 0.9, 1.2];
/** Margin kept clear before and after an obstacle, and length of the ramp into a detour. */
const CLEARANCE = 0.4;
const RAMP = 1.0;

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
  readonly status: PathStatus = { blockedAtS: null, blockReason: null, detouring: false, seenUntilS: 0 };
  /** Dashes are drawn this far ahead of the runner. Shorter than a lap on lap courses, so laps don't stack. */
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
  private lastProjected = 0;
  /** Where direction of travel was last measured from, and that direction (unit, or zero if unknown). */
  private readonly travelFrom = new THREE.Vector3(NaN, 0, NaN);
  private readonly travel = new THREE.Vector2();

  private readonly dashes: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

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
    resampled.forEach((p, i) => {
      this.xs[i] = p.x;
      this.zs[i] = p.z;
    });
    // Sideways vectors from a smoothed tangent so sharp corners do not flip detours.
    for (let i = 0; i < this.count; i++) {
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
    this.status.blockedAtS = null;
    this.status.blockReason = null;
    this.status.detouring = false;
    // A re-anchored route keeps its progress; distances along it haven't changed.
    if (!reanchor) {
      this.lastProjected = 0;
      this.status.seenUntilS = 0;
      this.travelFrom.set(NaN, 0, NaN);
      this.travel.set(0, 0);
    }
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
    return out.set(lerp(this.xs) + lerp(this.nx) * off, lerp(this.ys), lerp(this.zs) + lerp(this.nz) * off);
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
    if (Number.isNaN(this.travelFrom.x)) {
      this.travelFrom.copy(position);
      return;
    }
    const dx = position.x - this.travelFrom.x;
    const dz = position.z - this.travelFrom.z;
    const moved = Math.hypot(dx, dz);
    if (moved < TRAVEL_STRIDE) return;
    this.travel.set(dx / moved, dz / moved);
    this.travelFrom.copy(position);
  }

  /**
   * Called every frame: drape the line ahead onto known ground, ease detours, and redraw the
   * dashes around the runner. `checkHazards` re-plans detours (run it ~10x a second).
   */
  update(dt: number, timeSeconds: number, runnerS: number, map: SurfaceMap, now: number, checkHazards: boolean) {
    if (!this.ready) return;
    const i0 = this.index(runnerS - DASHES_BEHIND - 1);
    const i1 = this.index(runnerS + TERRAIN_AHEAD);

    this.drape(i0, i1, map, dt);
    if (checkHazards) {
      this.planDetours(runnerS, map, now);
      this.status.seenUntilS = this.seenUntil(runnerS, map);
    }
    const ease = Math.min(1, dt * 2.5);
    for (let i = i0; i <= i1; i++) this.offset[i] += (this.offsetTarget[i] - this.offset[i]) * ease;

    this.drawDashes(timeSeconds, runnerS);
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

  /** Find blocked stretches ahead and try to side-step each one; otherwise mark it blocked. */
  private planDetours(runnerS: number, map: SurfaceMap, now: number) {
    const a = this.index(runnerS);
    const b = this.index(runnerS + HAZARD_AHEAD);
    const ramp = Math.round(RAMP / STEP);
    const margin = Math.round(CLEARANCE / STEP);
    const previous = this.offsetTarget.slice(a, b + 1);
    for (let i = a; i <= Math.min(this.count - 1, b + ramp); i++) this.offsetTarget[i] = 0;

    this.status.blockedAtS = null;
    this.status.blockReason = null;
    this.status.detouring = false;

    let i = a;
    while (i <= b) {
      // Recognised stairs are passable, and their landing gets learned as ground.
      const onStairs = this.stairsAt(i * STEP) !== undefined;
      const hazard = onStairs ? null : this.hazardAtOffset(i, 0, map, now);
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
      if (worst === 'obstacle') {
        const stairs = this.detectStairs(i, map, now);
        if (stairs) {
          this.markStairs(stairs);
          i = this.index(stairs.toS) + 1;
          continue;
        }
      }
      const preferred = Math.sign(previous[Math.min(previous.length - 1, i - a)] || 0) || 1;
      const side = this.findClearSide(i - margin, end + margin, preferred, map, now);
      if (side === null) {
        this.status.blockedAtS = i * STEP;
        this.status.blockReason = worst;
        // Nothing beyond a blocked stretch is reachable, so stop planning there.
        break;
      }
      this.status.detouring = true;
      for (let k = Math.max(0, i - margin - ramp); k <= Math.min(this.count - 1, end + margin + ramp); k++) {
        const before = i - margin - k;
        const after = k - (end + margin);
        const distance = Math.max(before, after, 0);
        const weight = distance === 0 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * distance) / ramp);
        if (Math.abs(side * weight) > Math.abs(this.offsetTarget[k])) this.offsetTarget[k] = side * weight;
      }
      i = end + 1;
    }
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
    const tops: { k: number; h: number }[] = [];
    for (let k = 0; k < 45 && i0 + k < this.count; k++) {
      const top = map.obstacleTopAt(this.xs[i0 + k], this.zs[i0 + k], now);
      if (top === null) continue;
      const h = top - base;
      const previous = tops.at(-1);
      // A sudden tall jump (a wall or railing on the landing) or a drop ends the staircase.
      if (previous && (h - previous.h > 0.35 || h < previous.h - 0.06)) break;
      tops.push({ k, h: Math.max(h, previous?.h ?? h) });
    }
    if (tops.length < 4) return null;
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
    map.promoteToGround(this.xs[i], this.zs[i], CORRIDOR + 0.1, now, { y: span.toY, tolerance: 0.1 });
    return this.hazardAtOffset(i, 0, map, now) === null;
  }

  private findClearSide(from: number, to: number, preferred: number, map: SurfaceMap, now: number): number | null {
    const lo = Math.max(0, from);
    const hi = Math.min(this.count - 1, to);
    for (const distance of DETOURS) {
      for (const sign of [preferred, -preferred]) {
        const side = distance * sign;
        let clear = true;
        for (let i = lo; i <= hi && clear; i += 2) clear = this.hazardAtOffset(i, side, map, now) === null;
        if (clear) return side;
      }
    }
    return null;
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

/** Evenly re-space a polyline so every sample is `step` metres apart. */
function resample(points: RoutePoint[], step: number): RoutePoint[] {
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
/** One lap of the lap course: a running-track oval that fits in a room, starting at the tap. */
export const LAP = { straight: 3, radius: 1.2 };
export const LAP_LENGTH = 2 * LAP.straight + 2 * Math.PI * LAP.radius;

/**
 * `laps` laps of a small running-track oval: from `start` along `direction` for the straight,
 * a half circle to the left, back down the other straight, and a half circle home.
 */
export function lapRoute(start: THREE.Vector3, direction: THREE.Vector3, laps: number): RoutePoint[] {
  const left = new THREE.Vector3().crossVectors(UP, direction).normalize();
  const { straight, radius } = LAP;
  const at = (along: number, across: number): RoutePoint => ({
    x: start.x + direction.x * along + left.x * across,
    z: start.z + direction.z * along + left.z * across,
  });
  const lap: RoutePoint[] = [];
  for (let u = 0; u < straight; u += 0.25) lap.push(at(u, 0));
  for (let a = 0; a < Math.PI; a += 0.2) lap.push(at(straight + Math.sin(a) * radius, radius - Math.cos(a) * radius));
  for (let u = straight; u > 0; u -= 0.25) lap.push(at(u, 2 * radius));
  for (let a = 0; a < Math.PI; a += 0.2) lap.push(at(-Math.sin(a) * radius, radius + Math.cos(a) * radius));
  const points: RoutePoint[] = [];
  for (let i = 0; i < laps; i++) points.push(...lap);
  points.push(at(0, 0));
  return points;
}

export function demoRoute(start: THREE.Vector3, direction: THREE.Vector3, length: number): RoutePoint[] {
  const side = new THREE.Vector3().crossVectors(UP, direction).normalize();
  const points: RoutePoint[] = [];
  for (let u = 0; u <= length; u += 0.5) {
    const sway = Math.sin((u / 8) * Math.PI * 2) * 0.6;
    points.push({ x: start.x + direction.x * u + side.x * sway, z: start.z + direction.z * u + side.z * sway });
  }
  return points;
}
