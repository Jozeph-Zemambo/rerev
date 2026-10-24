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
const MAX_GROUND_WEIGHT = 20;

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
};

const hazardActive = (vote: Vote, floorSeenAt: number, now: number) =>
  vote.confirmed && now - vote.at < REMEMBER && floorSeenAt - vote.at < CLEAR_AFTER;

const OFFSET = 32768;
const keyOf = (ix: number, iz: number) => (ix + OFFSET) * 65536 + (iz + OFFSET);
const cellIndex = (v: number) => Math.floor(v / CELL_SIZE);

export class SurfaceMap {
  private cells = new Map<number, Cell>();

  reset() {
    this.cells.clear();
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
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    const own = this.cells.get(keyOf(cx, cz));
    if (own && own.groundWeight > 0) return own.ground;
    for (let ring = 1; ring <= REFERENCE_RINGS; ring++) {
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
    const reference = this.referenceGround(x, z);
    if (reference !== null && Math.abs(y - reference) > tolerance) return;
    const cell = this.cell(cellIndex(x), cellIndex(z));
    const total = cell.groundWeight + weight;
    cell.ground = cell.groundWeight > 0 ? (cell.ground * cell.groundWeight + y * weight) / total : y;
    cell.groundWeight = Math.min(total, MAX_GROUND_WEIGHT);
    cell.floorSeenAt = Math.max(cell.floorSeenAt, now);
  }

  /**
   * One 3D point from the depth camera. Classified by its height above the local ground:
   * near the ground refines it, well above votes "obstacle", well below votes "drop".
   * Points with no nearby ground to compare against are skipped (no guessing).
   */
  addDepthPoint(x: number, y: number, z: number, now: number) {
    const reference = this.referenceGround(x, z);
    if (reference === null) return;
    const height = y - reference;
    if (Math.abs(height) <= GROUND_BAND) {
      this.addGroundSample(x, y, z, 0.3, GROUND_BAND, now);
      return;
    }
    const isObstacle = height >= OBSTACLE_MIN && height <= OBSTACLE_MAX;
    const isDrop = height <= -DROP_MIN && height >= -DROP_MAX;
    if (!isObstacle && !isDrop) return;
    const cell = this.cell(cellIndex(x), cellIndex(z));
    if (cell.groundWeight === 0) cell.ground = reference;
    vote(isObstacle ? cell.obstacle : cell.drop, isObstacle ? OBSTACLE_VOTES : DROP_VOTES, cell.floorSeenAt, now);
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

  private isObstacle(cell: Cell, now: number) {
    return hazardActive(cell.obstacle, cell.floorSeenAt, now);
  }

  private isDrop(cell: Cell, now: number) {
    return hazardActive(cell.drop, cell.floorSeenAt, now);
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
      };
      this.cells.set(key, cell);
    }
    return cell;
  }
}

/** Count a hazard sighting. Unconfirmed votes must arrive close together; a cleared hazard starts over. */
function vote(v: Vote, needed: number, floorSeenAt: number, now: number) {
  const stale = v.confirmed ? !hazardActive(v, floorSeenAt, now) : now - v.at > VOTE_WINDOW;
  if (stale) {
    v.count = 0;
    v.confirmed = false;
  }
  v.count++;
  v.at = now;
  if (v.count >= needed) v.confirmed = true;
}
