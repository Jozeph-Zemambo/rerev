import { resample, type RoutePoint } from './path';

/** While recording, a sample is taken every this many metres of horizontal movement. */
export const RECORD_STEP = 0.25;
/** A course shorter than this is too short to run. */
export const MIN_COURSE = 4;
/** Finishing this close to where you started makes the course a loop. */
export const LOOP_CLOSE = 2;
/**
 * A walk back to where you started that encloses almost no area (out along a hallway and back)
 * is an out-and-back, not a loop. A circle scores 1/4π ≈ 0.08 on area / length².
 */
const THIN_LOOP = 0.015;
/** Coming back within this distance of the way out counts as coming back the same way. */
const RETRACE = 0.75;
/** Wobble smaller than this (phone sway, tracking jitter) is simplified away. Corners stay. */
const SIMPLIFY = 0.12;
/** Corners are rounded by at most this much on each side, so the buddy doesn't pivot on a pin. */
const CORNER_CUT = 0.2;
/**
 * On an out-and-back each direction keeps this far to its own right, so the two legs don't sit
 * exactly on top of each other and the turnaround has a real (tight) radius.
 */
export const KEEP_RIGHT = 0.15;
/** A run repeats the course to about this distance. */
const RUN_DISTANCE = 400;
const MIN_LAPS = 2;
const MAX_LAPS = 60;

export type CourseKind = 'loop' | 'line';

/** A walked course, cleaned up. A loop's last point equals its first. */
export type Course = { kind: CourseKind; points: RoutePoint[]; length: number };

/** The course laid out for one run, starting from where the runner is. */
export type CourseRun = {
  points: RoutePoint[];
  /** Distances along `points` where the buddy turns round (out-and-back only). */
  turnarounds: number[];
  laps: number;
  /** One lap of a loop, or one there-and-back of an out-and-back. */
  lapLength: number;
};

/** Samples the phone's floor position as you walk, every RECORD_STEP of horizontal movement. */
export class CourseRecording {
  readonly points: RoutePoint[] = [];
  length = 0;

  /** Returns true if this position was far enough from the last to be recorded. */
  add(x: number, z: number): boolean {
    const last = this.points.at(-1);
    if (last) {
      const d = Math.hypot(x - last.x, z - last.z);
      if (d < RECORD_STEP) return false;
      this.length += d;
    }
    this.points.push({ x, z });
    return true;
  }

  clear() {
    this.points.length = 0;
    this.length = 0;
  }
}

/**
 * Turn a recorded walk into a course: light smoothing, then simplification (which removes sway
 * but keeps real corners), then corners rounded a little. A walk that ends near its start (and
 * goes round something) is a loop, joined back onto its start; anything else is an out-and-back.
 * Returns null if the walk is too short.
 */
export function buildCourse(raw: RoutePoint[]): Course | null {
  if (polylineLength(raw) < MIN_COURSE) return null;
  const smoothed = smooth(raw);
  const closing = loopClosure(smoothed);
  if (closing !== null) {
    const loop = closeLoop(smoothed.slice(0, closing + 1));
    const points = roundCorners(simplify(loop, SIMPLIFY), true);
    return { kind: 'loop', points, length: polylineLength(points) };
  }
  let line = smoothed;
  // Walked out and then back the same way (all the way to the start, or only some of it): the
  // course is the way out, as far as you got. Otherwise the fold would be a spike in the course.
  const fold = farthestFrom(smoothed, smoothed[0]);
  if (retraces(smoothed.slice(fold), smoothed.slice(0, fold + 1))) {
    line = smoothed.slice(0, fold + 1);
    if (polylineLength(line) < MIN_COURSE / 2) return null;
  }
  const points = roundCorners(simplify(line, SIMPLIFY), false);
  return { kind: 'line', points, length: polylineLength(points) };
}

/**
 * Lay the course out for a run starting from `from` (where the runner stands). A loop starts at
 * its nearest point and repeats in the walked direction. An out-and-back starts at its nearer
 * end, so after recording (you're standing at the far end) the run heads back along it.
 */
export function courseRun(course: Course, from: RoutePoint, laps?: number): CourseRun {
  if (course.kind === 'loop') {
    const ring = resample(course.points, 0.25);
    // Resampling may land a sample right on the closing point, which repeats the first.
    if (ring.length > 2 && dist(ring.at(-1)!, ring[0]) < 0.05) ring.pop();
    const start = nearestIndex(ring, from);
    const lap = [...ring.slice(start), ...ring.slice(0, start)];
    const length = course.length;
    const count = laps ?? lapsFor(length);
    const points: RoutePoint[] = [];
    for (let i = 0; i < count; i++) points.push(...lap);
    points.push({ ...lap[0] });
    return { points, turnarounds: [], laps: count, lapLength: length };
  }

  const ends = [course.points[0], course.points.at(-1)!];
  const startAtEnd = dist(ends[1], from) < dist(ends[0], from);
  const out = startAtEnd ? course.points.slice().reverse() : course.points.slice();
  const back = out.slice().reverse();
  const legs = [offsetRight(out, KEEP_RIGHT), offsetRight(back, KEEP_RIGHT)];
  const count = laps ?? lapsFor(2 * course.length);
  const points: RoutePoint[] = [];
  const turnarounds: number[] = [];
  let travelled = 0;
  for (let leg = 0; leg < 2 * count; leg++) {
    const line = legs[leg % 2];
    if (leg > 0) {
      // A tight half circle round the end of the leg, apex in the middle.
      const turn = uTurn(leg % 2 === 1 ? out : back, KEEP_RIGHT);
      const half = Math.floor(turn.length / 2);
      for (let k = 0; k < turn.length; k++) {
        travelled += dist(points.at(-1)!, turn[k]);
        points.push(turn[k]);
        if (k === half) turnarounds.push(travelled);
      }
    }
    for (const p of line) {
      if (points.length) travelled += dist(points.at(-1)!, p);
      points.push(p);
    }
  }
  return { points, turnarounds, laps: count, lapLength: travelled / count };
}

function lapsFor(lapLength: number) {
  return Math.min(MAX_LAPS, Math.max(MIN_LAPS, Math.round(RUN_DISTANCE / lapLength)));
}

// ---------------------------------------------------------------- geometry

const dist = (a: RoutePoint, b: RoutePoint) => Math.hypot(a.x - b.x, a.z - b.z);

export function polylineLength(points: RoutePoint[]) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** Shoelace area enclosed by a closed polyline (sign ignored). */
export function enclosedArea(points: RoutePoint[]) {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

/** A light [⅙ ⅔ ⅙] smoothing pass; the ends stay where they were. */
function smooth(points: RoutePoint[]): RoutePoint[] {
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return { ...p };
    const a = points[i - 1];
    const b = points[i + 1];
    return { x: (a.x + 4 * p.x + b.x) / 6, z: (a.z + 4 * p.z + b.z) / 6 };
  });
}

/**
 * If the walk comes back to its start (in its second half, so standing still at the start
 * doesn't count) and goes round something, the index where it is closest to the start.
 * Overshooting the start a little is fine: the loop is cut there.
 */
function loopClosure(points: RoutePoint[]): number | null {
  const total = polylineLength(points);
  let s = 0;
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 1; i < points.length; i++) {
    s += dist(points[i - 1], points[i]);
    if (s < total / 2) continue;
    const d = dist(points[i], points[0]);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  if (best < 0 || bestDistance > LOOP_CLOSE) return null;
  const loop = points.slice(0, best + 1);
  const length = polylineLength(loop) + bestDistance;
  if (length < MIN_COURSE || enclosedArea(loop) / (length * length) < THIN_LOOP) return null;
  return best;
}

/**
 * Join the end of the walk back to its start. You usually stop a step or two short, still
 * heading for the start, so a straight join is what you would have walked; the corner rounding
 * that follows takes the edge off the join.
 */
function closeLoop(points: RoutePoint[]): RoutePoint[] {
  const out = points.map(p => ({ ...p }));
  if (dist(out.at(-1)!, out[0]) < 0.05) out.pop();
  out.push({ ...out[0] });
  return out;
}

/** True if (nearly) all of `rest` runs within RETRACE of `line`: you came back the way you went. */
function retraces(rest: RoutePoint[], line: RoutePoint[]) {
  if (rest.length < 2 || line.length < 2) return false;
  let near = 0;
  for (const p of rest) {
    let best = Infinity;
    for (let i = 1; i < line.length && best > RETRACE; i++) best = Math.min(best, segmentDistance(p, line[i - 1], line[i]));
    if (best <= RETRACE) near++;
  }
  return near >= rest.length * 0.9;
}

function farthestFrom(points: RoutePoint[], from: RoutePoint) {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (dist(points[i], from) > dist(points[best], from)) best = i;
  return best;
}

function nearestIndex(points: RoutePoint[], to: RoutePoint) {
  let best = 0;
  for (let i = 1; i < points.length; i++) if (dist(points[i], to) < dist(points[best], to)) best = i;
  return best;
}

/** Ramer–Douglas–Peucker: keep only the points that stray more than `epsilon` from the line. */
export function simplify(points: RoutePoint[], epsilon: number): RoutePoint[] {
  if (points.length < 3) return points.map(p => ({ ...p }));
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstDistance = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i], points[a], points[b]);
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  return points.filter((_, i) => keep[i]).map(p => ({ ...p }));
}

function segmentDistance(p: RoutePoint, a: RoutePoint, b: RoutePoint) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq));
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/**
 * Replace each corner with a short three-point bevel: in by up to CORNER_CUT along each side
 * (less for gentler bends), plus a point a quarter of the way into the corner. Straights stay straight and corners stay
 * corners, just not knife-edged. On a loop the start counts as a corner too.
 */
function roundCorners(points: RoutePoint[], closed: boolean): RoutePoint[] {
  const ring = closed ? points.slice(0, -1) : points;
  const n = ring.length;
  if (n < 3) return points.map(p => ({ ...p }));
  const out: RoutePoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    if (!closed && (i === 0 || i === n - 1)) {
      out.push({ ...p });
      continue;
    }
    const prev = ring[(i - 1 + n) % n];
    const next = ring[(i + 1) % n];
    // Gentle bends get a gentler bevel: a right angle gets the full cut, 45° half of it.
    const bend = Math.abs(Math.atan2(cross(prev, p, next), dot(prev, p, next)));
    const cut = CORNER_CUT * Math.min(1, bend / (Math.PI / 2));
    if (cut < 0.02) {
      out.push({ ...p });
      continue;
    }
    const cutIn = Math.min(cut, dist(prev, p) / 3);
    const cutOut = Math.min(cut, dist(p, next) / 3);
    const a = toward(p, prev, cutIn);
    const b = toward(p, next, cutOut);
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    out.push(a, toward(mid, p, dist(mid, p) / 2), b);
  }
  if (closed) out.push({ ...out[0] });
  return out;
}

/** Cross and dot products of the directions a→b and b→c. */
function cross(a: RoutePoint, b: RoutePoint, c: RoutePoint) {
  return (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
}

function dot(a: RoutePoint, b: RoutePoint, c: RoutePoint) {
  return (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z);
}

function toward(from: RoutePoint, to: RoutePoint, by: number): RoutePoint {
  const d = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) * by) / d, z: from.z + ((to.z - from.z) * by) / d };
}

/** Unit vector to the right of travel from a to b (y up: right of (dx, dz) is (-dz, dx)). */
function rightOf(a: RoutePoint, b: RoutePoint): RoutePoint {
  const d = dist(a, b) || 1;
  return { x: -(b.z - a.z) / d, z: (b.x - a.x) / d };
}

/** The same line, shifted `by` metres to the right of its direction of travel. */
function offsetRight(points: RoutePoint[], by: number): RoutePoint[] {
  return points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    const before = i > 0 ? rightOf(a, p) : rightOf(p, b);
    const after = i < points.length - 1 ? rightOf(p, b) : before;
    const nx = before.x + after.x;
    const nz = before.z + after.z;
    const len = Math.hypot(nx, nz) || 1;
    return { x: p.x + (nx / len) * by, z: p.z + (nz / len) * by };
  });
}

/**
 * Half circle of `radius` round the end of `leg` (the leg just run), from its right-hand side,
 * through straight ahead, to its left-hand side, where the way back keeps right. Excludes the
 * two ends, which are the legs' own end points.
 */
function uTurn(leg: RoutePoint[], radius: number): RoutePoint[] {
  const end = leg.at(-1)!;
  const right = rightOf(leg.at(-2)!, end);
  const forward = { x: right.z, z: -right.x };
  const out: RoutePoint[] = [];
  const steps = 8;
  for (let k = 1; k < steps; k++) {
    const a = (Math.PI * k) / steps;
    // From the right (a = 0) round through forward (a = π/2) to the left (a = π).
    out.push({
      x: end.x + (right.x * Math.cos(a) + forward.x * Math.sin(a)) * radius,
      z: end.z + (right.z * Math.cos(a) + forward.z * Math.sin(a)) * radius,
    });
  }
  return out;
}
