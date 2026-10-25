/**
 * A 20 cm grid over the floor that learns, per cell, how high the ground is and whether
 * something sticks up from it (an obstacle) or falls away below it (a drop).
 *
 * Everything is measured against the *local* ground, so a slope is not an obstacle and an
 * object on a slope still is. Ground knowledge spreads outward from where you start: a new
 * cell only accepts ground samples close to its neighbours' height, so gentle slopes are
 * followed while sudden steps are not swallowed into the ground.
 */

export const CELL_SIZE = 0.2;

export type Hazard = 'obstacle' | 'drop';

export type HazardCell = { x: number; z: number; y: number; kind: Hazard };


/** Points this far above the local ground count as an obstacle (stops at 2 m to ignore ceilings). */
const OBSTACLE_MIN = 0.15;
const OBSTACLE_MAX = 2.0;
/** Points this close to the local ground refine the ground estimate. */
const GROUND_BAND = 0.06;
/** Points this far below the local ground count as a drop-off (ledge, stairs going down). */
const DROP_MIN = 0.12;
const DROP_MAX = 1.5;
/** A cell is confirmed after this many hits arriving no more than VOTE_WINDOW seconds apart. */
const OBSTACLE_VOTES = 3;
const DROP_VOTES = 4;
const VOTE_WINDOW = 0.9;
/**
 * A confirmed hazard is remembered while out of view. It clears once the camera sees bare
 * floor in that cell with no hazard points for CLEAR_AFTER seconds (someone moved the bag),
 * or after REMEMBER seconds regardless (a person who walked off).
 */
const CLEAR_AFTER = 0.6;
const REMEMBER = 15;
/** How far (in cells) to look for known ground when a cell has none of its own. */
const REFERENCE_RINGS = 7;
/**
 * Depth readings get noisier with distance: beyond NOISE_FROM metres, hazard thresholds grow by
 * NOISE_PER_METRE per metre. Up close they stay strict, so a single step down is still caught
 * well before the buddy reaches it.
 */
const NOISE_FROM = 2;
const NOISE_PER_METRE = 0.02;
const MAX_GROUND_WEIGHT = 20;
/**
 * The phone's own floor detection (AR hit tests) is what sets ground heights; field tests showed
 * it stays right when depth readings drift. If it keeps disagreeing with the map, REBASE_VOTES
 * times within REBASE_WINDOW seconds, agreeing within REBASE_AGREE, that cell's ground moves to
 * it, up or down, by up to REBASE_MAX. Further than that is a real ledge or a table top, which
 * must stay a hazard, not become ground.
 */
const TRUSTED_WEIGHT = 2;
const REBASE_VOTES = 3;
const REBASE_WINDOW = 1;
const REBASE_AGREE = 0.04;
const REBASE_MAX = 0.3;
/**
 * Depth readings can drift (field tests: the near ones sank 15-40 cm below the floor while the
 * phone's floor detection still agreed). When most near readings in a frame say "drop" while
 * the floor detection agrees with the map, depth is the one that's wrong: that frame's drop
 * votes are ignored.
 */
const NEAR_RANGE = 2;
const DISTRUST_BELOW = -0.1;
const DISTRUST_MIN_POINTS = 20;
const TRUST_FLOOR_AGREEMENT = 0.6;

/**
 * Every threshold above, by name, so experiments (the field-test replay) can try other values.
 * The app always uses these defaults.
 */
export const DEFAULT_TUNING = {
  obstacleMin: OBSTACLE_MIN,
  obstacleMax: OBSTACLE_MAX,
  groundBand: GROUND_BAND,
  dropMin: DROP_MIN,
  dropMax: DROP_MAX,
  obstacleVotes: OBSTACLE_VOTES,
  dropVotes: DROP_VOTES,
  voteWindow: VOTE_WINDOW,
  clearAfter: CLEAR_AFTER,
  remember: REMEMBER,
  referenceRings: REFERENCE_RINGS,
  noiseFrom: NOISE_FROM,
  noisePerMetre: NOISE_PER_METRE,
  maxGroundWeight: MAX_GROUND_WEIGHT,
  trustedWeight: TRUSTED_WEIGHT,
  rebaseVotes: REBASE_VOTES,
  rebaseWindow: REBASE_WINDOW,
  rebaseAgree: REBASE_AGREE,
  rebaseMax: REBASE_MAX,
  nearRange: NEAR_RANGE,
  distrustBelow: DISTRUST_BELOW,
  distrustMinPoints: DISTRUST_MIN_POINTS,
  trustFloorAgreement: TRUST_FLOOR_AGREEMENT,
};

export type SurfaceTuning = { [K in keyof typeof DEFAULT_TUNING]: number };

type Vote = { count: number; at: number; confirmed: boolean };

type Cell = {
  ground: number;
  groundWeight: number;
  /** Last time this cell was seen as bare floor. */
  floorSeenAt: number;
  obstacle: Vote;
  drop: Vote;
  /** Upper envelope of obstacle points in this cell (absolute height), e.g. a stair tread. */
  top: number;
  /** Trusted floor readings disagreeing with this cell's ground, gathering towards moving it. */
  rebase: { count: number; at: number; y: number };
};

const hazardActive = (vote: Vote, floorSeenAt: number, now: number, t: SurfaceTuning) =>
  vote.confirmed && now - vote.at < t.remember && floorSeenAt - vote.at < t.clearAfter;

const OFFSET = 32768;
const keyOf = (ix: number, iz: number) => (ix + OFFSET) * 65536 + (iz + OFFSET);
const cellIndex = (v: number) => Math.floor(v / CELL_SIZE);

export class SurfaceMap {
  private cells = new Map<number, Cell>();
  /**
   * Height changes up to this much are walked over, not avoided, and ground may be learned
   * across them. 0 indoors (every step matters); about a kerb outdoors, where stepping off the
   * pavement to cross a road is normal.
   */
  walkableStep = 0;
  /** How many cells have had their ground moved to match the phone's floor detection. */
  rebased = 0;
  /** Depth frames whose drop votes were ignored because depth disagreed with the floor. */
  distrustedFrames = 0;
  /** Running share of trusted floor detections that agree with the map (1 = all agree). */
  private floorAgreement = 1;
  /** Thresholds in use: the defaults, unless an experiment overrides some. */
  readonly tuning: SurfaceTuning;

  constructor(tuning: Partial<SurfaceTuning> = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
  }

  /** How far a trusted ground sample may sit from the known ground and still count as ground. */
  groundTolerance(base: number) {
    return Math.max(base, this.walkableStep);
  }

  reset() {
    this.cells.clear();
    this.rebased = 0;
    this.distrustedFrames = 0;
    this.floorAgreement = 1;
  }

  get size() {
    return this.cells.size;
  }

  /** Forget cells far from a point, so a long run doesn't keep growing memory. */
  prune(x: number, z: number, radius: number) {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    for (const key of this.cells.keys()) {
      const ix = Math.floor(key / 65536) - OFFSET;
      const iz = (key % 65536) - OFFSET;
      if (Math.abs(ix - cx) > r || Math.abs(iz - cz) > r) this.cells.delete(key);
    }
  }

  /** Mark a disc of floor as known ground, e.g. around the spot the user tapped to start. */
  seedGround(x: number, y: number, z: number, radius: number) {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dz * dz > r * r) continue;
        const cell = this.cell(cx + dx, cz + dz);
        cell.ground = y;
        cell.groundWeight = Math.max(cell.groundWeight, 2);
      }
    }
  }

  /** Known ground height at a point, or null if this patch has not been seen yet. */
  groundAt(x: number, z: number): number | null {
    const cell = this.cells.get(keyOf(cellIndex(x), cellIndex(z)));
    return cell && cell.groundWeight > 0 ? cell.ground : null;
  }

  /** Ground height to compare new points against: this cell's, else the nearest known ring's. */
  referenceGround(x: number, z: number): number | null {
    const t = this.tuning;
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    const own = this.cells.get(keyOf(cx, cz));
    if (own && own.groundWeight > 0) return own.ground;
    for (let ring = 1; ring <= t.referenceRings; ring++) {
      let sum = 0;
      let weight = 0;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const c = this.cells.get(keyOf(cx + dx, cz + dz));
          if (c && c.groundWeight > 0) {
            sum += c.ground * c.groundWeight;
            weight += c.groundWeight;
          }
        }
      }
      if (weight > 0) return sum / weight;
    }
    return null;
  }

  /**
   * A trusted ground sample (an AR hit-test against a detected surface). Accepted only when it
   * agrees with the surrounding ground, so the top of a box is not mistaken for floor.
   */
  addGroundSample(x: number, y: number, z: number, weight = 1, tolerance = 0.08, now = -Infinity) {
    const t = this.tuning;
    const reference = this.referenceGround(x, z);
    const rejected = reference !== null && Math.abs(y - reference) > tolerance;
    if (weight >= t.trustedWeight && reference !== null) this.floorAgreement += ((rejected ? 0 : 1) - this.floorAgreement) * 0.05;
    if (rejected) {
      if (weight >= t.trustedWeight && Math.abs(y - reference!) <= t.rebaseMax) this.voteRebase(x, y, z, now);
      return;
    }
    const cell = this.cell(cellIndex(x), cellIndex(z));
    const total = cell.groundWeight + weight;
    cell.ground = cell.groundWeight > 0 ? (cell.ground * cell.groundWeight + y * weight) / total : y;
    cell.groundWeight = Math.min(total, t.maxGroundWeight);
    cell.floorSeenAt = Math.max(cell.floorSeenAt, now);
  }

  /**
   * One 3D point from the depth camera, `range` metres away. Classified by its height above the
   * local ground: near the ground refines it, well above votes "obstacle", well below votes
   * "drop". Points with no nearby ground to compare against are skipped (no guessing).
   */
  /**
   * One frame of depth points (`d` = distance from the phone), nearest first. Like
   * addDepthPoint for each, except that if most of the near points say "drop" while the phone's
   * floor detection agrees with the map, the frame's drop votes are ignored (see DISTRUST_BELOW).
   */
  addDepthFrame(points: readonly { x: number; y: number; z: number; d: number }[], now: number) {
    const t = this.tuning;
    const near: number[] = [];
    for (const p of points) {
      if (p.d >= t.nearRange) continue;
      const reference = this.referenceGround(p.x, p.z);
      if (reference !== null) near.push(p.y - reference);
    }
    near.sort((a, b) => a - b);
    const sinking = near.length >= t.distrustMinPoints && near[near.length >> 1] <= t.distrustBelow;
    const dropsTrusted = !(sinking && this.floorAgreement >= t.trustFloorAgreement);
    if (!dropsTrusted) this.distrustedFrames++;
    for (const p of points) this.addDepthPoint(p.x, p.y, p.z, now, p.d, dropsTrusted);
  }

  addDepthPoint(x: number, y: number, z: number, now: number, range = 0, dropsTrusted = true) {
    const t = this.tuning;
    const reference = this.referenceGround(x, z);
    if (reference === null) return;
    const height = y - reference;
    if (Math.abs(height) <= t.groundBand) {
      // Depth may mark ground as seen, but never moves its height: biased depth would drag the
      // ground along with it, one cell at a time. Heights come from the phone's floor detection.
      const cell = this.cell(cellIndex(x), cellIndex(z));
      if (cell.groundWeight === 0) {
        cell.ground = reference;
        cell.groundWeight = 0.3;
      }
      cell.floorSeenAt = Math.max(cell.floorSeenAt, now);
      return;
    }
    const margin = t.noisePerMetre * Math.max(0, range - t.noiseFrom);
    const isObstacle = height >= Math.max(t.obstacleMin, this.walkableStep) + margin && height <= t.obstacleMax;
    const isDrop = dropsTrusted && height <= -(Math.max(t.dropMin, this.walkableStep) + margin) && height >= -t.dropMax;
    if (!isObstacle && !isDrop) return;
    const cell = this.cell(cellIndex(x), cellIndex(z));
    if (cell.groundWeight === 0) cell.ground = reference;
    vote(isObstacle ? cell.obstacle : cell.drop, isObstacle ? t.obstacleVotes : t.dropVotes, cell.floorSeenAt, now, t);
    if (isObstacle) {
      // Rise quickly to new highs, sink slowly, so the top follows the surface, not stray spikes.
      if (cell.obstacle.count === 1) cell.top = y;
      else cell.top += (y - cell.top) * (y > cell.top ? 0.5 : 0.05);
    }
  }

  /**
   * Turn obstacle cells near a point into walkable ground at their top height. Used once a
   * staircase is recognised: the treads become ground, so knowledge of the ground can carry on
   * up the steps and onto the landing.
   */
  promoteToGround(x: number, z: number, radius: number, now: number, onlyNear?: { y: number; tolerance: number }): number {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    let promoted = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = this.cells.get(keyOf(cx + dx, cz + dz));
        if (!cell || !this.isObstacle(cell, now)) continue;
        if (onlyNear && Math.abs(cell.top - onlyNear.y) > onlyNear.tolerance) continue;
        promoted++;
        cell.ground = cell.top;
        cell.groundWeight = Math.max(cell.groundWeight, 3);
        cell.obstacle = { count: 0, at: -Infinity, confirmed: false };
        cell.floorSeenAt = now;
      }
    }
    return promoted;
  }

  /** Height of the top of an obstacle at a point (absolute), or null if nothing is there now. */
  obstacleTopAt(x: number, z: number, now: number): number | null {
    const cell = this.cells.get(keyOf(cellIndex(x), cellIndex(z)));
    return cell && this.isObstacle(cell, now) ? cell.top : null;
  }

  /** The worst hazard within `radius` of a point right now, or null if the way looks clear. */
  hazardAt(x: number, z: number, radius: number, now: number): Hazard | null {
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    let found: Hazard | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = this.cells.get(keyOf(cx + dx, cz + dz));
        if (!cell) continue;
        if (this.isObstacle(cell, now)) return 'obstacle';
        if (this.isDrop(cell, now)) found = 'drop';
      }
    }
    return found;
  }

  /** Flagged cells near a point, for drawing markers on the floor. */
  hazardCells(x: number, z: number, radius: number, now: number, out: HazardCell[]): HazardCell[] {
    out.length = 0;
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = this.cells.get(keyOf(cx + dx, cz + dz));
        if (!cell) continue;
        const kind: Hazard | null = this.isObstacle(cell, now) ? 'obstacle' : this.isDrop(cell, now) ? 'drop' : null;
        if (kind) out.push({ x: (cx + dx + 0.5) * CELL_SIZE, z: (cz + dz + 0.5) * CELL_SIZE, y: cell.ground, kind });
      }
    }
    return out;
  }

  private voteRebase(x: number, y: number, z: number, now: number) {
    const t = this.tuning;
    const time = Number.isFinite(now) ? now : performance.now() / 1000;
    const cell = this.cell(cellIndex(x), cellIndex(z));
    const rebase = cell.rebase;
    if (time - rebase.at > t.rebaseWindow || Math.abs(y - rebase.y) > t.rebaseAgree) {
      rebase.count = 0;
      rebase.y = y;
    }
    rebase.count++;
    rebase.at = time;
    rebase.y += (y - rebase.y) / rebase.count;
    if (rebase.count < t.rebaseVotes) return;
    cell.ground = rebase.y;
    cell.groundWeight = 3;
    cell.drop = { count: 0, at: -Infinity, confirmed: false };
    cell.obstacle = { count: 0, at: -Infinity, confirmed: false };
    cell.floorSeenAt = time;
    rebase.count = 0;
    this.rebased++;
  }

  private isObstacle(cell: Cell, now: number) {
    return hazardActive(cell.obstacle, cell.floorSeenAt, now, this.tuning);
  }

  private isDrop(cell: Cell, now: number) {
    return hazardActive(cell.drop, cell.floorSeenAt, now, this.tuning);
  }

  private cell(ix: number, iz: number): Cell {
    const key = keyOf(ix, iz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        ground: 0,
        groundWeight: 0,
        floorSeenAt: -Infinity,
        obstacle: { count: 0, at: -Infinity, confirmed: false },
        drop: { count: 0, at: -Infinity, confirmed: false },
        top: 0,
        rebase: { count: 0, at: -Infinity, y: 0 },
      };
      this.cells.set(key, cell);
    }
    return cell;
  }
}

/** Count a hazard sighting. Unconfirmed votes must arrive close together; a cleared hazard starts over. */
function vote(v: Vote, needed: number, floorSeenAt: number, now: number, t: SurfaceTuning) {
  const stale = v.confirmed ? !hazardActive(v, floorSeenAt, now, t) : now - v.at > t.voteWindow;
  if (stale) {
    v.count = 0;
    v.confirmed = false;
  }
  v.count++;
  v.at = now;
  if (v.count >= needed) v.confirmed = true;
}
