import * as THREE from 'three';
import type { Hazard, SurfaceMap } from './surfaceMap';

/** Route samples are evenly spaced, so the sample index is just distance / STEP. */
const STEP = 0.1;
const DASH_SPACING = 0.25;
const DASH_POOL = 160;
const DASHES_BEHIND = 2;
/** How far ahead the path drapes onto the ground and checks for hazards. */
const TERRAIN_AHEAD = 35;
const HAZARD_AHEAD = 6;
/** Half-width of the corridor that must be clear for the runner. */
const CORRIDOR = 0.3;
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

/**
 * The route laid over the real ground. Holds the planned line (from a demo shape or a real
 * map route), drapes it onto the ground heights learned by the SurfaceMap, bends it sideways
 * around obstacles, and draws a moving window of glowing dashes around the runner.
 */
export class Path {
  readonly group = new THREE.Group();
  length = 0;
  readonly status: PathStatus = { blockedAtS: null, blockReason: null, detouring: false, seenUntilS: 0 };

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

  /** Lay a new route. Points are in AR/world metres; `baseY` is the starting floor height. */
  setRoute(points: RoutePoint[], baseY: number) {
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
    this.lastProjected = 0;
    this.status.blockedAtS = null;
    this.status.blockReason = null;
    this.status.detouring = false;
    this.status.seenUntilS = 0;
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
    const search = (from: number, to: number) => {
      let best = from;
      let bestDistance = Infinity;
      for (let i = from; i <= to; i++) {
        const d = (this.xs[i] - position.x) ** 2 + (this.zs[i] - position.z) ** 2;
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
      return { best, bestDistance };
    };
    const window = 200;
    let { best, bestDistance } = search(Math.max(0, this.lastProjected - window), Math.min(this.count - 1, this.lastProjected + window));
    if (bestDistance > 9) ({ best } = search(0, this.count - 1));
    this.lastProjected = best;
    return best * STEP;
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
      const x = this.xs[i] + this.nx[i] * this.offset[i];
      const z = this.zs[i] + this.nz[i] * this.offset[i];
      const ground = map.groundAt(x, z);
      if (ground !== null) carry = ground;
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
      if (map.groundAt(x, z) !== null) {
        gap = 0;
        lastSeen = i;
      } else if (++gap > allowedGap) break;
    }
    return lastSeen * STEP;
  }

  private hazardAtOffset(i: number, side: number, map: SurfaceMap, now: number): Hazard | null {
    return map.hazardAt(this.xs[i] + this.nx[i] * side, this.zs[i] + this.nz[i] * side, CORRIDOR, now);
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
      const hazard = this.hazardAtOffset(i, 0, map, now);
      if (!hazard) {
        i++;
        continue;
      }
      let end = i;
      let worst: Hazard = hazard;
      while (end + 1 <= b) {
        const next = this.hazardAtOffset(end + 1, 0, map, now);
        if (!next) break;
        if (next === 'obstacle') worst = 'obstacle';
        end++;
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
      if (s < 0 || s > this.length) {
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
export function demoRoute(start: THREE.Vector3, direction: THREE.Vector3, length: number): RoutePoint[] {
  const side = new THREE.Vector3().crossVectors(UP, direction).normalize();
  const points: RoutePoint[] = [];
  for (let u = 0; u <= length; u += 0.5) {
    const sway = Math.sin((u / 8) * Math.PI * 2) * 0.6;
    points.push({ x: start.x + direction.x * u + side.x * sway, z: start.z + direction.z * u + side.z * sway });
  }
  return points;
}
