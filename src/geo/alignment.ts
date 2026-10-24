import type { Enu } from './geo';

/**
 * Maps map coordinates (east/north metres) onto the phone's AR world (x/z metres).
 *
 *   AR = R(theta) · base(enu) + (tx, tz),   base(e, n) = (x: e, z: -n)
 *
 * so with theta = 0 north is AR -z. R rotates about the vertical axis; a positive theta turns
 * a vector's bearing anticlockwise by theta.
 */
export type GeoTransform = { theta: number; tx: number; tz: number };

export type ArPoint = { x: number; z: number };

/**
 * A map position matched to an AR position. A GPS fix pins both directions. A route match
 * ("the runner is on the route here") only says how far to the side of the route they are, so
 * it carries the route's normal and pins that direction alone.
 */
type Pair = { p: ArPoint; q: ArPoint; weight: number; time: number; kind: PairKind; normal?: ArPoint };

export type PairKind = 'gps' | 'route';

/** Pairs older than this are dropped from the fit (AR tracking drifts slowly over time). */
const PAIR_WINDOW = 180;
/** Route matches only count for a short while: they describe the route as it was drawn then. */
const ROUTE_PAIR_WINDOW = 10;
/** Fit only once the GPS track spans this far, or heading errors swamp the fit. */
const MIN_SPREAD = 20;
/** Route matches carry no GPS noise, so they can settle the heading over a shorter stretch. */
const MIN_ROUTE_SPREAD = 8;
/** Each refit moves the transform this fraction of the way, so the path glides instead of jumping. */
const BLEND = 0.35;
const MIN_ACCURACY = 3;
/**
 * The fit stays near the current transform in directions the pairs don't pin down (e.g. along
 * a straight before GPS has spread out): as if the current one were a fix this many metres off,
 * levered over this many metres for rotation.
 */
const PRIOR_ACCURACY = 10;
const PRIOR_LEVER = 20;

const base = (p: Enu): ArPoint => ({ x: p.e, z: -p.n });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function apply(t: GeoTransform, p: Enu): ArPoint {
  const b = base(p);
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  return { x: c * b.x + s * b.z + t.tx, z: -s * b.x + c * b.z + t.tz };
}

/** Bearing of an AR direction, measured like a compass: 0 = AR -z, 90 = AR +x. */
export function arBearing(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

/**
 * Keeps the map route glued to the real world. It starts from one GPS fix plus a heading (the
 * compass, or "the user is facing along the route"), then keeps refining by matching the GPS
 * track to the phone's own AR track: AR tracking is precise over short distances but drifts,
 * GPS is noisy but never drifts, and a weighted best-fit rotation + shift combines the two.
 */
export class GeoAligner {
  transform: GeoTransform | null = null;
  /** For diagnostics: how many refits, and how far the last one moved the route. */
  readonly stats = { refits: 0, lastShift: 0, lastTurnDeg: 0 };
  private pairs: Pair[] = [];

  /** For diagnostics: pairs in the current window, by kind. */
  pairCounts() {
    const route = this.pairs.filter(pair => pair.kind === 'route').length;
    return { gps: this.pairs.length - route, route };
  }

  /**
   * @param fix where the phone is, in map metres
   * @param ar where the phone is, in AR metres
   * @param headingRad direction the camera faces, radians clockwise from north
   * @param arForwardBearing direction the camera faces in AR (see `arBearing`)
   */
  initialise(fix: Enu, ar: ArPoint, headingRad: number, arForwardBearing: number) {
    const theta = wrap(headingRad - arForwardBearing);
    const placed = apply({ theta, tx: 0, tz: 0 }, fix);
    this.transform = { theta, tx: ar.x - placed.x, tz: ar.z - placed.z };
    this.pairs = [];
    Object.assign(this.stats, { refits: 0, lastShift: 0, lastTurnDeg: 0 });
  }

  /** Record where GPS says you are and where AR tracking says you are, at the same moment. */
  addFix(fix: Enu, ar: ArPoint, accuracy: number, time: number) {
    this.add({ p: base(fix), q: { ...ar }, weight: 1 / Math.max(accuracy, MIN_ACCURACY) ** 2, time, kind: 'gps' });
  }

  /**
   * Record that the runner, at `ar`, is on the route at map point `onRoute`, where the route
   * runs in map direction `along`. Only the sideways offset counts.
   */
  addRouteMatch(onRoute: Enu, along: Enu, ar: ArPoint, accuracy: number, time: number) {
    const length = Math.hypot(along.e, along.n) || 1;
    // Route direction in base coordinates is (e, -n); its normal is (n, e).
    const normal = { x: along.n / length, z: along.e / length };
    this.add({ p: base(onRoute), q: { ...ar }, weight: 1 / Math.max(accuracy, MIN_ACCURACY) ** 2, time, kind: 'route', normal });
  }

  private add(pair: Pair) {
    this.pairs.push(pair);
    this.pairs = this.pairs.filter(old => pair.time - old.time <= (old.kind === 'route' ? ROUTE_PAIR_WINDOW : PAIR_WINDOW));
  }

  /** Re-fit the transform from recent pairs. Returns true if it moved. */
  refit(): boolean {
    if (!this.transform) return false;
    // Once GPS has spread out it is the judge. Before that, route matches alone can fix the
    // compass heading. They're left out afterwards: if the runner follows the drawn line (an open
    // plaza) rather than the real street, they would vote for whatever is drawn, and
    // scripts/align-bench.ts shows them then doing more harm than good.
    const gps = this.pairs.filter(pair => pair.kind === 'gps');
    const route = this.pairs.filter(pair => pair.kind === 'route');
    const usable = spread(gps) >= MIN_SPREAD ? gps : spread(route) >= MIN_ROUTE_SPREAD ? route : null;
    if (!usable || usable.length < 4) return false;
    const fit = fitTransform(usable, this.transform);
    const t = this.transform;
    const turn = wrap(fit.theta - t.theta) * BLEND;
    const shiftX = (fit.tx - t.tx) * BLEND;
    const shiftZ = (fit.tz - t.tz) * BLEND;
    t.theta = wrap(t.theta + turn);
    t.tx += shiftX;
    t.tz += shiftZ;
    this.stats.refits++;
    this.stats.lastShift = Math.hypot(shiftX, shiftZ);
    this.stats.lastTurnDeg = (turn * 180) / Math.PI;
    return true;
  }

}

function spread(pairs: Pair[]): number {
  if (pairs.length === 0) return 0;
  let max = 0;
  const first = pairs[0].p;
  for (const pair of pairs) max = Math.max(max, Math.hypot(pair.p.x - first.x, pair.p.z - first.z));
  return max;
}

/**
 * Weighted least-squares transform: GPS pairs pull point to point, route matches only pull
 * sideways to the route (point to line). Solved by a few Gauss-Newton steps from `from`, with a
 * weak pull back towards `from` so directions nothing constrains stay put.
 */
export function fitTransform(pairs: Pair[], from: GeoTransform): GeoTransform {
  let { theta, tx, tz } = from;
  const priorShift = 1 / PRIOR_ACCURACY ** 2;
  const priorTurn = priorShift * PRIOR_LEVER ** 2;
  for (let step = 0; step < 4; step++) {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Normal equations A·d = b for the update d = (dTheta, dTx, dTz).
    const A = [
      [priorTurn, 0, 0],
      [0, priorShift, 0],
      [0, 0, priorShift],
    ];
    const b = [-priorTurn * wrap(theta - from.theta), -priorShift * (tx - from.tx), -priorShift * (tz - from.tz)];
    const row = (j0: number, j1: number, j2: number, residual: number, weight: number) => {
      const J = [j0, j1, j2];
      for (let i = 0; i < 3; i++) {
        b[i] -= weight * J[i] * residual;
        for (let k = 0; k < 3; k++) A[i][k] += weight * J[i] * J[k];
      }
    };
    for (const { p, q, weight, normal } of pairs) {
      // Rotated map point, and its derivative with respect to theta: (az, -ax).
      const ax = c * p.x + s * p.z;
      const az = -s * p.x + c * p.z;
      const rx = ax + tx - q.x;
      const rz = az + tz - q.z;
      if (normal) {
        const nx = c * normal.x + s * normal.z;
        const nz = -s * normal.x + c * normal.z;
        row(nx * az - nz * ax, nx, nz, nx * rx + nz * rz, weight);
      } else {
        row(az, 1, 0, rx, weight);
        row(-ax, 0, 1, rz, weight);
      }
    }
    const d = solve3(A, b);
    theta += d[0];
    tx += d[1];
    tz += d[2];
  }
  return { theta: wrap(theta), tx, tz };
}

function solve3(A: number[][], b: number[]): number[] {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-12) return [0, 0, 0];
  return [0, 1, 2].map(col => det(A.map((r, i) => r.map((v, k) => (k === col ? b[i] : v)))) / D);
}
