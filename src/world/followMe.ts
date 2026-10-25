import type { Partner } from '../partner/partner';
import type { Path, RoutePoint } from './path';

/**
 * Follow-me for Quick start: the runner decides where to go and the path follows. The line ahead
 * is laid along the runner's recent direction of travel; when they turn a corner, cross a street
 * or drift towards a hallway wall, the stretch beyond the buddy is re-laid to bend onto their
 * line. Everything up to the buddy stays as it is, so the buddy never jumps and distances along
 * the path still hold. If the runner gets past the buddy, the buddy picks up again a couple of
 * metres ahead of them, on their new line.
 */

type XZ = { x: number; z: number };

/** Direction of travel is measured over about this much of the runner's own track. */
export const HEADING_WINDOW = 3;
/** The track keeps a point each time the runner has moved this far (smaller wobbles don't count). */
const STRIDE = 0.25;
/** Over the window, they must have got at least this far from where it starts for a direction. */
const MIN_DISPLACEMENT = 1;
/** A jump this far in one update is tracking relocalising, not running: start the track afresh. */
const JUMP = 2;

/** Where the path is checked against the runner's line: this far ahead of them along it. */
const PROBES = [6, 9];
/** The path ahead is re-laid once it is this far off the runner's line... */
const BEND_ERROR = 0.35;
/** ...for this long (a sway or a glance doesn't count)... */
const BEND_HOLD = 0.25;
/** ...and not more often than this. */
const RELAY_GAP = 0.4;
/** Re-laid stretches start this far past the buddy, so its footing doesn't move. */
const ANCHOR_PAST_BUDDY = 0.2;
/** The re-laid stretch bends from the buddy onto the runner's line over about this far. */
const BLEND = 3;
/** The buddy counts as passed once it's less than this far ahead of the runner, along their direction... */
const PASS_LEAD = 0.2;
/** ...for this long. */
const PASS_HOLD = 0.4;
/** After being passed it picks up this far ahead of the runner, joining their line over this far. */
const RESPAWN_LEAD = 2;
const RESPAWN_BLEND = 1.5;
/** Each re-lay lays this much straight line past the bend. */
const LAY_AHEAD = 25;
/** The path is extended when less than this is left ahead of the buddy. */
const EXTEND_WHEN = 15;
/**
 * While the runner follows the path round an obstacle (it's bent at least this far sideways where
 * they are), their sidestep isn't a change of direction: no re-lays until they've gone a window's
 * length past it. A detour still ahead of them doesn't count: bending the path onto their line
 * is often what clears it (a hallway wall the old line ran into).
 */
const ON_DETOUR = 0.15;

/**
 * The runner's direction of travel, smoothed over the last few metres of their track, and the
 * distance they've actually covered. Standing still or turning on the spot changes neither.
 */
export class TravelHeading {
  /** Unit vector, or null until they've walked far enough to tell. Holds its last value when they stop. */
  heading: XZ | null = null;
  /** Metres travelled along the track (stride by stride, so standing-still jitter adds nothing). */
  odometer = 0;
  private trail: XZ[] = [];
  private readonly window: number;

  constructor(window = HEADING_WINDOW) {
    this.window = window;
  }

  reset() {
    this.heading = null;
    this.odometer = 0;
    this.trail = [];
  }

  update(x: number, z: number) {
    const last = this.trail.at(-1);
    if (!last) {
      this.trail.push({ x, z });
      return;
    }
    const moved = Math.hypot(x - last.x, z - last.z);
    if (moved > JUMP) {
      // The world shifted under us; the direction we had still stands.
      this.trail = [{ x, z }];
      return;
    }
    if (moved >= STRIDE) {
      this.trail.push({ x, z });
      this.odometer += moved;
      if (this.trail.length > Math.ceil((this.window * 3) / STRIDE)) this.trail.shift();
    }
    // The last window's worth of track, and the straight line that best fits it (its principal
    // axis): side-to-side sway averages out instead of tilting the direction.
    let i = this.trail.length - 1;
    let along = Math.hypot(x - this.trail[i].x, z - this.trail[i].z);
    while (i > 0 && along < this.window) {
      along += Math.hypot(this.trail[i].x - this.trail[i - 1].x, this.trail[i].z - this.trail[i - 1].z);
      i--;
    }
    const dx = x - this.trail[i].x;
    const dz = z - this.trail[i].z;
    const displacement = Math.hypot(dx, dz);
    if (displacement < MIN_DISPLACEMENT) return;
    const n = this.trail.length - i + 1;
    let mx = x;
    let mz = z;
    for (let k = i; k < this.trail.length; k++) {
      mx += this.trail[k].x;
      mz += this.trail[k].z;
    }
    mx /= n;
    mz /= n;
    let sxx = (x - mx) ** 2;
    let szz = (z - mz) ** 2;
    let sxz = (x - mx) * (z - mz);
    for (let k = i; k < this.trail.length; k++) {
      const px = this.trail[k].x - mx;
      const pz = this.trail[k].z - mz;
      sxx += px * px;
      szz += pz * pz;
      sxz += px * pz;
    }
    const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let hx = Math.cos(angle);
    let hz = Math.sin(angle);
    // The axis has no direction of its own: point it the way they went.
    if (hx * dx + hz * dz < 0) {
      hx = -hx;
      hz = -hz;
    }
    this.heading = { x: hx, z: hz };
  }
}

/**
 * The route ahead from `anchor` (excluded) bending onto the runner's line (from `runner` along
 * `heading`), then straight along it for `length`: a cubic curve that leaves the anchor along
 * `tangent` and meets the line `blend` metres past the anchor's place along it. Without a
 * tangent (or one pointing back against the heading) it heads straight for the join.
 */
export function bendToward(anchor: XZ, tangent: XZ | null, runner: XZ, heading: XZ, blend: number, length: number): RoutePoint[] {
  const along = Math.max(0, (anchor.x - runner.x) * heading.x + (anchor.z - runner.z) * heading.z);
  const join = { x: runner.x + heading.x * (along + blend), z: runner.z + heading.z * (along + blend) };
  const chord = Math.hypot(join.x - anchor.x, join.z - anchor.z);
  let t = tangent;
  if (!t || t.x * heading.x + t.z * heading.z < 0.2) t = chord > 1e-6 ? { x: (join.x - anchor.x) / chord, z: (join.z - anchor.z) / chord } : heading;
  const k = chord / 3;
  const p1 = { x: anchor.x + t.x * k, z: anchor.z + t.z * k };
  const p2 = { x: join.x - heading.x * k, z: join.z - heading.z * k };
  const points: RoutePoint[] = [];
  const n = Math.max(4, Math.ceil(chord / 0.2));
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    const a = (1 - u) ** 3;
    const b = 3 * (1 - u) ** 2 * u;
    const c = 3 * (1 - u) * u * u;
    const d = u ** 3;
    points.push({ x: a * anchor.x + b * p1.x + c * p2.x + d * join.x, z: a * anchor.z + b * p1.z + c * p2.z + d * join.z });
  }
  for (let u = 0.5; u <= length + 1e-6; u += 0.5) points.push({ x: join.x + heading.x * u, z: join.z + heading.z * u });
  return points;
}

/**
 * How far the path is from the runner's line: the largest gap between a point `PROBES` metres
 * ahead of the runner along their heading and the nearest point of the path ahead of them.
 */
export function offLine(path: Path, runner: XZ, heading: XZ, runnerS: number): number {
  let worst = 0;
  for (const d of PROBES) {
    const near = path.closestS(runner.x + heading.x * d, runner.z + heading.z * d, runnerS, runnerS + 30);
    worst = Math.max(worst, near.distance);
  }
  return worst;
}

export type FollowEvent =
  /** The path beyond the buddy was bent onto the runner's line. */
  | { kind: 'bend'; fromS: number; error: number }
  /** The runner got past the buddy: the path was re-laid from them and the buddy moved to `buddyS`. */
  | { kind: 'respawn'; fromS: number; buddyS: number }
  /** More straight path was laid on the end. */
  | { kind: 'extend'; fromS: number };

/** Decides, every frame, whether the path ahead needs re-laying, and does it. */
export class FollowMe {
  readonly travel = new TravelHeading();
  bends = 0;
  respawns = 0;
  private lastRelay = -Infinity;
  private offSince: number | null = null;
  private passedSince: number | null = null;
  private quietUntil = 0;
  private readonly at = { x: 0, z: 0 };
  private readonly behind = { x: 0, z: 0 };

  reset() {
    this.travel.reset();
    this.bends = 0;
    this.respawns = 0;
    this.lastRelay = -Infinity;
    this.offSince = null;
    this.passedSince = null;
    this.quietUntil = 0;
  }

  /** `runner` is where the runner is now (the phone), `runnerS` their progress along the path. */
  update(now: number, runner: XZ, runnerS: number, path: Path, partner: Partner): FollowEvent | null {
    this.travel.update(runner.x, runner.z);
    if (!path.ready) return null;
    const side = path.detourAt(runnerS, this.at);
    if (Math.hypot(side.x, side.z) > ON_DETOUR) this.quietUntil = this.travel.odometer + HEADING_WINDOW;

    if (path.length - Math.max(runnerS, partner.s) < EXTEND_WHEN) return this.extend(path);

    const heading = this.travel.heading;
    // On a breather the runner wanders about; that's not where the run is going.
    if (!heading || partner.breaking || now - this.lastRelay < RELAY_GAP) {
      this.offSince = this.passedSince = null;
      return null;
    }

    path.centreAt(partner.s, this.at);
    const lead = (this.at.x - runner.x) * heading.x + (this.at.z - runner.z) * heading.z;
    if (lead < PASS_LEAD) {
      this.passedSince ??= now;
      this.offSince = null;
      return now - this.passedSince >= PASS_HOLD ? this.respawn(now, runner, heading, runnerS, path, partner) : null;
    }
    this.passedSince = null;

    if (this.travel.odometer < this.quietUntil) {
      this.offSince = null;
      return null;
    }
    const error = offLine(path, runner, heading, runnerS);
    if (error <= BEND_ERROR) {
      this.offSince = null;
      return null;
    }
    this.offSince ??= now;
    if (now - this.offSince < BEND_HOLD) return null;

    const fromS = Math.min(path.length, partner.s + ANCHOR_PAST_BUDDY);
    path.centreAt(fromS, this.at);
    path.centreAt(fromS - 0.3, this.behind);
    const tx = this.at.x - this.behind.x;
    const tz = this.at.z - this.behind.z;
    const len = Math.hypot(tx, tz);
    path.relayFrom(fromS, bendToward(this.at, len > 1e-6 ? { x: tx / len, z: tz / len } : null, runner, heading, BLEND, LAY_AHEAD));
    this.relayed(now);
    this.bends++;
    return { kind: 'bend', fromS, error };
  }

  private respawn(now: number, runner: XZ, heading: XZ, runnerS: number, path: Path, partner: Partner): FollowEvent {
    const fromS = Math.max(0, Math.min(path.length, runnerS));
    path.centreAt(fromS, this.at);
    path.relayFrom(fromS, bendToward(this.at, null, runner, heading, RESPAWN_BLEND, LAY_AHEAD));
    const target = { x: runner.x + heading.x * RESPAWN_LEAD, z: runner.z + heading.z * RESPAWN_LEAD };
    const buddyS = path.closestS(target.x, target.z, fromS, fromS + RESPAWN_LEAD + RESPAWN_BLEND + 5).s;
    partner.skipTo(Math.max(buddyS, runnerS + 0.5));
    this.relayed(now);
    this.respawns++;
    return { kind: 'respawn', fromS, buddyS: partner.s };
  }

  private extend(path: Path): FollowEvent {
    const fromS = path.length;
    path.centreAt(fromS, this.at);
    path.centreAt(fromS - 0.5, this.behind);
    const tx = this.at.x - this.behind.x;
    const tz = this.at.z - this.behind.z;
    const len = Math.hypot(tx, tz) || 1;
    const points: RoutePoint[] = [];
    for (let u = 0.5; u <= LAY_AHEAD; u += 0.5) points.push({ x: this.at.x + (tx / len) * u, z: this.at.z + (tz / len) * u });
    path.relayFrom(fromS, points);
    return { kind: 'extend', fromS };
  }

  private relayed(now: number) {
    this.lastRelay = now;
    this.offSince = null;
    this.passedSince = null;
  }
}
