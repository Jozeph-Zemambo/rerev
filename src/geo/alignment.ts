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

type Pair = { p: ArPoint; q: ArPoint; weight: number; time: number };

/** Pairs older than this are dropped from the fit (AR tracking drifts slowly over time). */
const PAIR_WINDOW = 180;
/** Fit only once the GPS track spans this far, or heading errors swamp the fit. */
const MIN_SPREAD = 20;
/** Each refit moves the transform this fraction of the way, so the path glides instead of jumping. */
const BLEND = 0.35;
const MIN_ACCURACY = 3;

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
  private pairs: Pair[] = [];

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
  }

  /** Record where GPS says you are and where AR tracking says you are, at the same moment. */
  addFix(fix: Enu, ar: ArPoint, accuracy: number, time: number) {
    const weight = 1 / Math.max(accuracy, MIN_ACCURACY) ** 2;
    this.pairs.push({ p: base(fix), q: { ...ar }, weight, time });
    this.pairs = this.pairs.filter(pair => time - pair.time <= PAIR_WINDOW);
  }

  /** Re-fit the transform from recent pairs. Returns true if it moved. */
  refit(): boolean {
    if (!this.transform || this.pairs.length < 4 || this.spread() < MIN_SPREAD) return false;
    const fit = fitRigid(this.pairs);
    const t = this.transform;
    t.theta = wrap(t.theta + wrap(fit.theta - t.theta) * BLEND);
    t.tx += (fit.tx - t.tx) * BLEND;
    t.tz += (fit.tz - t.tz) * BLEND;
    return true;
  }

  private spread(): number {
    let max = 0;
    const first = this.pairs[0].p;
    for (const pair of this.pairs) max = Math.max(max, Math.hypot(pair.p.x - first.x, pair.p.z - first.z));
    return max;
  }
}

/** Weighted 2D best-fit rotation + translation taking each pair's p onto its q (Kabsch). */
export function fitRigid(pairs: { p: ArPoint; q: ArPoint; weight: number }[]): GeoTransform {
  let w = 0;
  let px = 0;
  let pz = 0;
  let qx = 0;
  let qz = 0;
  for (const { p, q, weight } of pairs) {
    w += weight;
    px += p.x * weight;
    pz += p.z * weight;
    qx += q.x * weight;
    qz += q.z * weight;
  }
  px /= w;
  pz /= w;
  qx /= w;
  qz /= w;
  let dot = 0;
  let cross = 0;
  for (const { p, q, weight } of pairs) {
    const ax = p.x - px;
    const az = p.z - pz;
    const bx = q.x - qx;
    const bz = q.z - qz;
    dot += weight * (bx * ax + bz * az);
    cross += weight * (bx * az - bz * ax);
  }
  const theta = Math.atan2(cross, dot);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { theta, tx: qx - (c * px + s * pz), tz: qz - (-s * px + c * pz) };
}
