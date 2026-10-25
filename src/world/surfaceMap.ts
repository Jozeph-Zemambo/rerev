/**
 * A 20 cm grid over the floor that learns, per cell, how high the ground is and whether
 * something sticks up from it (an obstacle) or falls away below it (a drop).
 *
 * Everything is measured against the *local* ground, so a slope is not an obstacle and an
 * object on a slope still is. Ground knowledge spreads outward from where you start: a new
 * cell only accepts ground samples close to its neighbours' height, so gentle slopes are
 * followed while sudden steps are not swallowed into the ground.
 *
 * Phone depth is noisy while walking (field tests on a flat hallway: a tenth of the floor points
 * within 2.5 m read 15 cm+ off, and beyond that it gets far worse), so no single reading, or burst
 * of readings, makes a hazard. Each cell weighs up, over time, how much of what it saw was ground
 * and how much was obstacle or drop, trusting near readings far more than distant ones. A hazard
 * is confirmed only when hazard readings clearly outweigh ground there, over several frames, with
 * a neighbouring cell agreeing. The phone's floor detection (AR hit tests) outranks depth.
 */

export const CELL_SIZE = 0.2;

export type Hazard = 'obstacle' | 'drop';

export type HazardCell = { x: number; z: number; y: number; kind: Hazard };

/** What a depth point was judged as: refined the ground, voted a hazard, or was left out. */
export type DepthVerdict = 'ground' | 'obstacle' | 'drop' | 'between' | 'out of range' | 'no ground';

/** Optional listener for field testing: sees every judgement the map makes, raw. */
export type SurfaceProbe = {
  depth(height: number, range: number, verdict: DepthVerdict): void;
  /** A ground sample (`diff` = its height minus the known ground, null if none known yet). */
  ground(diff: number | null, accepted: boolean, weight: number): void;
  /**
   * How far depth said a point on the floor was, over how far the known floor actually is along
   * that line of sight (1 = right; above 1 = depth reads too far, so points sink below the floor).
   */
  ratio?(ratio: number, range: number): void;
};

/** Points this far above the local ground count as an obstacle (stops at 2 m to ignore ceilings). */
const OBSTACLE_MIN = 0.15;
const OBSTACLE_MAX = 2.0;
/** Points this close to the local ground mark it as seen. */
const GROUND_BAND = 0.06;
/** Points this far below the local ground count as a drop-off (ledge, stairs going down). */
const DROP_MIN = 0.12;
const DROP_MAX = 1.5;
/**
 * How much one depth point counts, by distance. Field tests on a flat floor (5-95% of the height
 * error): -17/+14 cm under 1.5 m, ±37 cm at 1.5-2.5 m, -26/+83 cm at 2.5-3.5 m. Far out, the floor
 * reads 15 cm+ high often, so such a reading says little, while a reading near the floor is still
 * good evidence there's nothing there. So points count fully up to FULL_WEIGHT_TO; beyond it a
 * hazard reading counts MID_HAZARD_WEIGHT at MID_AT and FAR_HAZARD_WEIGHT at FAR_AT, any other
 * reading FLOOR_WEIGHT; nothing counts from HAZARD_RANGE (it only marks the ground as seen).
 * (Weights roughly follow how much likelier each reading is on a 35 cm box than on bare floor.)
 * Drops are only looked for within DROP_RANGE.
 */
const FULL_WEIGHT_TO = 1.5;
const MID_AT = 2;
const FAR_AT = 3;
const MID_HAZARD_WEIGHT = 0.5;
const FAR_HAZARD_WEIGHT = 0.25;
const FLOOR_WEIGHT = 0.45;
const HAZARD_RANGE = 3.5;
const DROP_RANGE = 2.5;
/**
 * Beyond 2.5 m the field-test floor read 15 cm+ high about as often as it read as floor, so
 * readings from there can back a hazard but never confirm one: it must have been seen from within
 * CONFIRM_RANGE.
 */
const CONFIRM_RANGE = 2.8;
/** Evidence fades with this time constant (seconds), so a cell reflects what it looks like now. */
const EVIDENCE_TIME = 1.5;
/**
 * An obstacle is confirmed once obstacle readings make up OBSTACLE_SHARE of the cell's evidence,
 * weigh at least OBSTACLE_MASS (near points), came from at least OBSTACLE_FRAMES frames, and a
 * neighbouring cell has at least NEIGHBOUR_SHARE obstacle evidence too (a real object spans cells;
 * a stray reading doesn't). It stays until its share falls below KEEP_SHARE (bare floor seen
 * there again) or nothing has backed it for REMEMBER seconds (out of view: a person walks off).
 * Drops need stronger, nearer evidence: depth that sinks below the floor is the commonest error.
 */
const OBSTACLE_SHARE = 0.6;
const OBSTACLE_MASS = 6;
const OBSTACLE_FRAMES = 4;
const DROP_SHARE = 0.7;
const DROP_MASS = 8;
const DROP_FRAMES = 6;
const NEIGHBOUR_SHARE = 0.35;
/**
 * Depth from a phone that's barely moving can hold a phantom for seconds (field test: a 45 cm
 * "object" 2 m ahead, 90% of what its cells saw, while the runner stood at the start). Real
 * things stay put as you move. So a hazard further than CLOSE_RANGE must have been seen from
 * places at least PARALLAX apart.
 */
const PARALLAX = 0.4;
const CLOSE_RANGE = 1.2;
const KEEP_SHARE = 0.3;
const REMEMBER = 15;
/**
 * A floor detection on a cell, at its ground height, is bare floor seen there: it counts as
 * HIT_GROUND of ground evidence, and rules out a drop for HIT_VETO seconds. It can't rule out an
 * obstacle outright: the phone's floor planes reach under things standing on the floor.
 */
const HIT_GROUND = 1;
const HIT_VETO = 1;
/**
 * Where the floor detection saw bare floor in the last HIT_RECENT seconds, depth should read the
 * floor too. Walking often sinks or lifts the whole depth image (field tests: 10-70 cm for
 * seconds at a time), which scattered noise doesn't do: so if the points landing there (at least
 * QUALITY_POINTS) sit, by their median, more than SHIFT_OK off the floor, the frame counts for
 * less, and for nothing from SHIFT_BAD.
 */
const HIT_RECENT = 0.5;
const QUALITY_POINTS = 20;
const SHIFT_OK = 0.06;
const SHIFT_BAD = 0.16;
/** How far (in cells) to look for known ground when a cell has none of its own. */
const REFERENCE_RINGS = 7;
/**
 * Hazard thresholds grow by NOISE_PER_METRE per metre beyond NOISE_FROM metres. Up close they
 * stay strict, so a single step down is still caught well before the buddy reaches it.
 */
const NOISE_FROM = 2;
const NOISE_PER_METRE = 0.03;
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
 * The phone's whole world drifts up and down as tracking corrects itself (field test: the floor,
 * and everything with it, moved 18 cm within a second, and by 14 cm over a walk), which leaves
 * every remembered height wrong by that much. When at least DRIFT_HITS floor detections in one
 * frame land on cells whose height was already known and agree, within DRIFT_AGREE, on how far
 * off those are, the whole map shifts by that much.
 */
const DRIFT_HITS = 3;
const DRIFT_AGREE = 0.03;
/**
 * The drift can also creep in through a second floor plane at the new height, so hits land on
 * both and cells get re-based one by one, leaving the rest of the map at the old height (field
 * test: +12 cm, read by depth as a long "obstacle" along the walk). So when DRIFT_REBASES cells
 * whose height the floor detection had already set are re-based by the same amount (within
 * DRIFT_AGREE) within DRIFT_WINDOW seconds, the whole map shifts by that much. (Past a real step
 * the floor detection finds new ground; it doesn't move ground it already knew.)
 */
const DRIFT_REBASES = 3;
const DRIFT_WINDOW = 2;
/**
 * Depth readings can drift (field tests: the near ones sank 15-40 cm below the floor while the
 * phone's floor detection still agreed). When most near readings in a frame say "drop" while
 * the floor detection agrees with the map, depth is the one that's wrong: that frame's drop
 * readings are ignored.
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
  fullWeightTo: FULL_WEIGHT_TO,
  midAt: MID_AT,
  farAt: FAR_AT,
  midHazardWeight: MID_HAZARD_WEIGHT,
  farHazardWeight: FAR_HAZARD_WEIGHT,
  floorWeight: FLOOR_WEIGHT,
  hazardRange: HAZARD_RANGE,
  dropRange: DROP_RANGE,
  confirmRange: CONFIRM_RANGE,
  evidenceTime: EVIDENCE_TIME,
  obstacleShare: OBSTACLE_SHARE,
  obstacleMass: OBSTACLE_MASS,
  obstacleFrames: OBSTACLE_FRAMES,
  dropShare: DROP_SHARE,
  dropMass: DROP_MASS,
  dropFrames: DROP_FRAMES,
  neighbourShare: NEIGHBOUR_SHARE,
  parallax: PARALLAX,
  closeRange: CLOSE_RANGE,
  keepShare: KEEP_SHARE,
  remember: REMEMBER,
  hitGround: HIT_GROUND,
  hitVeto: HIT_VETO,
  hitRecent: HIT_RECENT,
  qualityPoints: QUALITY_POINTS,
  shiftOk: SHIFT_OK,
  shiftBad: SHIFT_BAD,
  referenceRings: REFERENCE_RINGS,
  noiseFrom: NOISE_FROM,
  noisePerMetre: NOISE_PER_METRE,
  maxGroundWeight: MAX_GROUND_WEIGHT,
  trustedWeight: TRUSTED_WEIGHT,
  rebaseVotes: REBASE_VOTES,
  rebaseWindow: REBASE_WINDOW,
  rebaseAgree: REBASE_AGREE,
  rebaseMax: REBASE_MAX,
  driftHits: DRIFT_HITS,
  driftAgree: DRIFT_AGREE,
  driftRebases: DRIFT_REBASES,
  driftWindow: DRIFT_WINDOW,
  nearRange: NEAR_RANGE,
  distrustBelow: DISTRUST_BELOW,
  distrustMinPoints: DISTRUST_MIN_POINTS,
  trustFloorAgreement: TRUST_FLOOR_AGREEMENT,
};

export type SurfaceTuning = { [K in keyof typeof DEFAULT_TUNING]: number };

type Cell = {
  ix: number;
  iz: number;
  /** Ground height, before the map-wide drift correction (see SurfaceMap.drift). */
  ground: number;
  groundWeight: number;
  /** Faded evidence: how much of what was seen here was ground, obstacle, drop. */
  seenGround: number;
  seenObstacle: number;
  seenDrop: number;
  /** Faded count of frames in which most of what was seen here was an obstacle / a drop. */
  obstacleFrames: number;
  dropFrames: number;
  /**
   * Since obstacle / drop readings started here: the nearest they came from, and how far apart
   * the places they were seen from are (see PARALLAX), measured from where they were first seen.
   */
  obstacleNear: number;
  obstacleSpread: number;
  obstacleFrom: { x: number; z: number; range: number };
  dropNear: number;
  dropSpread: number;
  dropFrom: { x: number; z: number; range: number };
  /** When the evidence was last faded. */
  evidenceAt: number;
  obstacle: boolean;
  drop: boolean;
  /** Last time obstacle / drop readings backed this cell. */
  obstacleAt: number;
  dropAt: number;
  /** Last time the phone's floor detection saw bare floor here. */
  floorHitAt: number;
  /** This frame's readings, not yet added to the evidence. */
  frameGround: number;
  frameObstacle: number;
  frameDrop: number;
  frameRange: number;
  pending: boolean;
  /** Upper envelope of obstacle points in this cell (before drift correction), e.g. a stair tread. */
  top: number;
  topSet: boolean;
  /** Trusted floor readings disagreeing with this cell's ground, gathering towards moving it. */
  rebase: { count: number; at: number; y: number };
};

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
  /** Field testing only: told about every judgement. */
  probe: SurfaceProbe | null = null;
  /** How many cells have had their ground moved to match the phone's floor detection. */
  rebased = 0;
  /** Depth frames whose drop readings were ignored because depth disagreed with the floor. */
  distrustedFrames = 0;
  /**
   * How far the phone's world has drifted up (+) or down since the map started: every stored
   * height is read back plus this.
   */
  drift = 0;
  /** Running share of trusted floor detections that agree with the map (1 = all agree). */
  private floorAgreement = 1;
  /** Cells with readings from the current frame, and the time of that frame. */
  private pending: Cell[] = [];
  private pendingAt = -Infinity;
  /** Where the phone was for the frame being added, if the caller said. */
  private frameCamera: { x: number; z: number } | null = null;
  /** How much the frame being added counts (see SHIFT_OK); 1 for points added one by one. */
  private frameWeight = 1;
  /** How much the last depth frame counted, 0-1 (field testing). */
  lastFrameQuality = 1;
  private readonly residuals: number[] = [];
  private recentRebases: { cell: Cell; shift: number; at: number }[] = [];
  private readonly shifts: number[] = [];
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
    this.pending.length = 0;
    this.pendingAt = -Infinity;
    this.rebased = 0;
    this.distrustedFrames = 0;
    this.drift = 0;
    this.floorAgreement = 1;
    this.recentRebases.length = 0;
  }

  get size() {
    return this.cells.size;
  }

  /** Forget cells far from a point, so a long run doesn't keep growing memory. */
  prune(x: number, z: number, radius: number) {
    this.flush();
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    for (const [key, cell] of this.cells) {
      if (Math.abs(cell.ix - cx) > r || Math.abs(cell.iz - cz) > r) this.cells.delete(key);
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
        cell.ground = y - this.drift;
        cell.groundWeight = Math.max(cell.groundWeight, 2);
      }
    }
  }

  /** Known ground height at a point, or null if this patch has not been seen yet. */
  groundAt(x: number, z: number): number | null {
    const cell = this.cells.get(keyOf(cellIndex(x), cellIndex(z)));
    return cell && cell.groundWeight > 0 ? cell.ground + this.drift : null;
  }

  /**
   * Ground height to compare new points against: this cell's, else the nearest known ring's. If
   * that ring holds two levels (the edge of a step), the one nearer `from` (where the phone is):
   * you step off the edge from the side you're on, and an average of both levels would hide it.
   */
  referenceGround(x: number, z: number, from?: { x: number; z: number } | null): number | null {
    const t = this.tuning;
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    const own = this.cells.get(keyOf(cx, cz));
    if (own && own.groundWeight > 0) return own.ground + this.drift;
    for (let ring = 1; ring <= t.referenceRings; ring++) {
      let sum = 0;
      let weight = 0;
      let low = Infinity;
      let high = -Infinity;
      let nearest: Cell | null = null;
      let nearestDistance = Infinity;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const c = this.cells.get(keyOf(cx + dx, cz + dz));
          if (c && c.groundWeight > 0) {
            sum += c.ground * c.groundWeight;
            weight += c.groundWeight;
            low = Math.min(low, c.ground);
            high = Math.max(high, c.ground);
            if (from) {
              const distance = ((c.ix + 0.5) * CELL_SIZE - from.x) ** 2 + ((c.iz + 0.5) * CELL_SIZE - from.z) ** 2;
              if (distance < nearestDistance) {
                nearestDistance = distance;
                nearest = c;
              }
            }
          }
        }
      }
      if (weight === 0) continue;
      if (nearest && high - low > t.groundBand) return nearest.ground + this.drift;
      return sum / weight + this.drift;
    }
    return null;
  }

  /**
   * One frame of the phone's floor detections (AR hit tests against detected surfaces). First
   * corrects for the phone's world drifting up or down (see DRIFT_HITS), then adds each as a
   * trusted ground sample.
   */
  addFloorHits(hits: readonly { x: number; y: number; z: number }[], now: number) {
    const t = this.tuning;
    const residuals = this.residuals;
    residuals.length = 0;
    for (const { x, y, z } of hits) {
      const cell = this.cells.get(keyOf(cellIndex(x), cellIndex(z)));
      if (!cell || cell.groundWeight < 2) continue;
      const off = y - (cell.ground + this.drift);
      if (Math.abs(off) <= t.rebaseMax) residuals.push(off);
    }
    if (residuals.length >= t.driftHits) {
      residuals.sort((a, b) => a - b);
      const middle = residuals[residuals.length >> 1];
      const agreeing = residuals.filter(r => Math.abs(r - middle) <= t.driftAgree).length;
      if (agreeing >= t.driftHits && agreeing * 2 > residuals.length) this.drift += middle;
    }
    for (const { x, y, z } of hits) this.addGroundSample(x, y, z, 2, this.groundTolerance(0.1), now);
  }

  /**
   * A trusted ground sample (an AR hit-test against a detected surface). Accepted only when it
   * agrees with the surrounding ground, so the top of a box is not mistaken for floor.
   */
  addGroundSample(x: number, y: number, z: number, weight = 1, tolerance = 0.08, now = -Infinity) {
    const t = this.tuning;
    const reference = this.referenceGround(x, z);
    const rejected = reference !== null && Math.abs(y - reference) > tolerance;
    if (weight >= 1) this.probe?.ground(reference === null ? null : y - reference, !rejected, weight);
    if (weight >= t.trustedWeight && reference !== null) this.floorAgreement += ((rejected ? 0 : 1) - this.floorAgreement) * 0.05;
    if (rejected) {
      if (weight >= t.trustedWeight && Math.abs(y - reference!) <= t.rebaseMax) this.voteRebase(x, y, z, now);
      return;
    }
    const cell = this.cell(cellIndex(x), cellIndex(z));
    const stored = y - this.drift;
    const total = cell.groundWeight + weight;
    cell.ground = cell.groundWeight > 0 ? (cell.ground * cell.groundWeight + stored * weight) / total : stored;
    cell.groundWeight = Math.min(total, t.maxGroundWeight);
    if (weight >= t.trustedWeight && Number.isFinite(now)) {
      // Bare floor seen here by the phone's floor detection.
      this.fade(cell, now);
      cell.seenGround += t.hitGround;
      cell.floorHitAt = now;
      cell.drop = false;
      if (cell.obstacle && cell.seenObstacle < t.keepShare * this.evidence(cell)) cell.obstacle = false;
    }
  }

  /**
   * One frame of depth points (`d` = distance from the phone), nearest first. Like
   * addDepthPoint for each, except that if most of the near points say "drop" while the phone's
   * floor detection agrees with the map, the frame's drop readings are ignored (see DISTRUST_BELOW).
   * `camera` is where the phone was, for the field-test depth check.
   */
  addDepthFrame(points: readonly { x: number; y: number; z: number; d: number }[], now: number, camera?: { x: number; y: number; z: number }) {
    const t = this.tuning;
    const near: number[] = [];
    const onFloorHits = this.shifts;
    onFloorHits.length = 0;
    for (const p of points) {
      const cell = this.cells.get(keyOf(cellIndex(p.x), cellIndex(p.z)));
      const recentHit = cell !== undefined && now - cell.floorHitAt <= t.hitRecent;
      if (p.d >= t.nearRange && !recentHit) continue;
      const reference = this.referenceGround(p.x, p.z, camera);
      if (reference === null) continue;
      if (p.d < t.nearRange) near.push(p.y - reference);
      if (recentHit) onFloorHits.push(p.y - reference);
    }
    let quality = 1;
    if (onFloorHits.length >= t.qualityPoints) {
      onFloorHits.sort((a, b) => a - b);
      const shift = Math.abs(onFloorHits[onFloorHits.length >> 1]);
      quality = Math.min(1, Math.max(0, (t.shiftBad - shift) / (t.shiftBad - t.shiftOk)));
    }
    this.lastFrameQuality = quality;
    near.sort((a, b) => a - b);
    const sinking = near.length >= t.distrustMinPoints && near[near.length >> 1] <= t.distrustBelow;
    const dropsTrusted = !(sinking && this.floorAgreement >= t.trustFloorAgreement);
    if (!dropsTrusted) this.distrustedFrames++;
    this.flush();
    this.frameCamera = camera ?? null;
    this.frameWeight = quality;
    for (const p of points) {
      if (camera && this.probe?.ratio) {
        // How far depth measured along this line of sight, against how far the known floor is.
        const reference = this.referenceGround(p.x, p.z);
        const drop = p.y - camera.y;
        if (reference !== null && drop < -0.2) this.probe.ratio(drop / (reference - camera.y), p.d);
      }
      this.addDepthPoint(p.x, p.y, p.z, now, p.d, dropsTrusted);
    }
    this.flush();
    this.frameCamera = null;
    this.frameWeight = 1;
  }

  /**
   * One 3D point from the depth camera, `range` metres away. Classified by its height above the
   * local ground: near the ground it marks the ground seen, well above it is obstacle evidence,
   * well below it drop evidence. Points with no nearby ground to compare against are skipped (no
   * guessing). Points given with the same `now` are one frame; the frame is weighed up once the
   * next one starts (or the map is asked about hazards).
   */
  addDepthPoint(x: number, y: number, z: number, now: number, range = 0, dropsTrusted = true) {
    const t = this.tuning;
    if (now !== this.pendingAt) this.flush();
    this.pendingAt = now;
    if (!Number.isFinite(x + y + z)) return;
    const reference = this.referenceGround(x, z, this.frameCamera);
    if (reference === null) {
      this.probe?.depth(NaN, range, 'no ground');
      return;
    }
    const height = y - reference;
    const margin = t.noisePerMetre * Math.max(0, range - t.noiseFrom);
    const obstacleFrom = Math.max(t.obstacleMin, this.walkableStep) + margin;
    const dropFrom = Math.max(t.dropMin, this.walkableStep) + margin;
    const isGround = Math.abs(height) <= t.groundBand;
    const isObstacle = !isGround && height >= obstacleFrom && height <= t.obstacleMax;
    const isDrop = !isGround && dropsTrusted && height <= -dropFrom && height >= -t.dropMax;
    this.probe?.depth(height, range, isGround ? 'ground' : isObstacle ? 'obstacle' : isDrop ? 'drop' : Math.abs(height) > 1.5 ? 'out of range' : 'between');

    const cell = this.cell(cellIndex(x), cellIndex(z));
    // Depth may mark ground as seen, but never moves its height: biased depth would drag the
    // ground along with it, one cell at a time. Heights come from the phone's floor detection.
    if (cell.groundWeight === 0) {
      cell.ground = reference - this.drift;
      if (isGround) cell.groundWeight = 0.3;
    }
    // Too far to weigh, but still seeing a known obstacle there keeps it remembered.
    if (isObstacle && cell.obstacle) cell.obstacleAt = Math.max(cell.obstacleAt, now);
    if (range >= t.hazardRange || Math.abs(height) > t.dropMax) return;
    const countsAsDrop = isDrop && range <= t.dropRange;
    const weight = this.weightAt(range, isObstacle || countsAsDrop) * this.frameWeight;
    if (weight <= 0) return;
    if (!cell.pending) {
      cell.pending = true;
      cell.frameRange = range;
      this.pending.push(cell);
    }
    // Anything that isn't an obstacle or a drop reading counts against both.
    if (!isObstacle && !countsAsDrop) cell.frameGround += weight;
    else if (isObstacle) {
      cell.frameObstacle += weight;
      // Rise quickly to new highs, sink slowly, so the top follows the surface, not stray spikes.
      const stored = y - this.drift;
      if (!cell.topSet || (!cell.obstacle && cell.seenObstacle < 0.05)) cell.top = stored;
      else cell.top += (stored - cell.top) * (stored > cell.top ? 0.5 : 0.05);
      cell.topSet = true;
    } else cell.frameDrop += weight;
  }

  /** How much a depth point at this distance counts, as a hazard reading or not (see FULL_WEIGHT_TO). */
  private weightAt(range: number, hazard: boolean) {
    const t = this.tuning;
    const lerp = (from: number, to: number, a: number, b: number) => a + ((b - a) * (range - from)) / (to - from);
    if (range <= t.fullWeightTo) return 1;
    const mid = hazard ? t.midHazardWeight : t.floorWeight;
    const far = hazard ? t.farHazardWeight : t.floorWeight;
    if (range <= t.midAt) return lerp(t.fullWeightTo, t.midAt, 1, mid);
    if (range <= t.farAt) return lerp(t.midAt, t.farAt, mid, far);
    if (range < t.hazardRange) return lerp(t.farAt, t.hazardRange, far, 0);
    return 0;
  }

  /** Weigh up the readings of the frame just finished, cell by cell. */
  private flush() {
    const now = this.pendingAt;
    const cells = this.pending;
    for (const cell of cells) this.fold(cell, now);
    for (const cell of cells) this.judge(cell, now);
    cells.length = 0;
  }

  private fade(cell: Cell, now: number) {
    const elapsed = now - cell.evidenceAt;
    if (!(elapsed > 0)) return;
    const k = Number.isFinite(elapsed) ? Math.exp(-elapsed / this.tuning.evidenceTime) : 0;
    cell.seenGround *= k;
    cell.seenObstacle *= k;
    cell.seenDrop *= k;
    cell.obstacleFrames *= k;
    cell.dropFrames *= k;
    cell.evidenceAt = now;
  }

  private evidence(cell: Cell) {
    return cell.seenGround + cell.seenObstacle + cell.seenDrop;
  }

  private fold(cell: Cell, now: number) {
    this.fade(cell, now);
    const g = cell.frameGround;
    const o = cell.frameObstacle;
    const d = cell.frameDrop;
    cell.seenGround += g;
    cell.seenObstacle += o;
    cell.seenDrop += d;
    if (cell.seenObstacle < 0.5) {
      cell.obstacleNear = Infinity;
      cell.obstacleSpread = 0;
    }
    if (cell.seenDrop < 0.5) {
      cell.dropNear = Infinity;
      cell.dropSpread = 0;
    }
    if (o > 0 && o >= g + d) {
      cell.obstacleFrames += this.frameWeight;
      cell.obstacleSpread = this.spread(cell.obstacleFrom, cell.obstacleNear === Infinity, cell.frameRange, cell.obstacleSpread);
      cell.obstacleNear = Math.min(cell.obstacleNear, cell.frameRange);
    }
    if (d > 0 && d >= g + o) {
      cell.dropFrames += this.frameWeight;
      cell.dropSpread = this.spread(cell.dropFrom, cell.dropNear === Infinity, cell.frameRange, cell.dropSpread);
      cell.dropNear = Math.min(cell.dropNear, cell.frameRange);
    }
    if (o > 0) cell.obstacleAt = now;
    if (d > 0) cell.dropAt = now;
    cell.frameGround = cell.frameObstacle = cell.frameDrop = 0;
    cell.pending = false;
  }

  /**
   * How far apart the places a cell's hazard was seen from are: from where the phone was (when
   * the frame said), else from how far away the cell was.
   */
  private spread(from: { x: number; z: number; range: number }, first: boolean, range: number, spread: number) {
    const camera = this.frameCamera;
    if (first) {
      from.x = camera ? camera.x : NaN;
      from.z = camera ? camera.z : NaN;
      from.range = range;
      return 0;
    }
    const moved = camera && Number.isFinite(from.x) ? Math.hypot(camera.x - from.x, camera.z - from.z) : Math.abs(range - from.range);
    return Math.max(spread, moved);
  }

  /** Confirm or clear this cell's hazards from its evidence. */
  private judge(cell: Cell, now: number) {
    const t = this.tuning;
    const total = this.evidence(cell);
    if (cell.obstacle) cell.obstacle = cell.seenObstacle >= t.keepShare * total;
    else
      cell.obstacle =
        cell.seenObstacle >= t.obstacleMass &&
        cell.seenObstacle >= t.obstacleShare * total &&
        cell.obstacleFrames >= t.obstacleFrames &&
        cell.obstacleNear <= t.confirmRange &&
        (cell.obstacleNear <= t.closeRange || cell.obstacleSpread >= t.parallax) &&
        this.neighbourAgrees(cell);
    const vetoed = now - cell.floorHitAt < t.hitVeto;
    if (cell.drop) cell.drop = !vetoed && cell.seenDrop >= t.keepShare * total;
    else
      cell.drop =
        !vetoed &&
        cell.seenDrop >= t.dropMass &&
        cell.seenDrop >= t.dropShare * total &&
        cell.dropFrames >= t.dropFrames &&
        (cell.dropNear <= t.closeRange || cell.dropSpread >= t.parallax);
  }

  /** Does a neighbouring cell also see an obstacle? */
  private neighbourAgrees(cell: Cell) {
    const share = this.tuning.neighbourShare;
    if (share <= 0) return true;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.cells.get(keyOf(cell.ix + dx, cell.iz + dz));
        if (!n) continue;
        const seen = n.seenObstacle + n.frameObstacle;
        if (n.obstacle || (seen > 0 && seen >= share * (this.evidence(n) + n.frameGround + n.frameObstacle + n.frameDrop))) return true;
      }
    }
    return false;
  }

  /**
   * Turn obstacle cells near a point into walkable ground at their top height. Used once a
   * staircase is recognised: the treads become ground, so knowledge of the ground can carry on
   * up the steps and onto the landing.
   */
  promoteToGround(x: number, z: number, radius: number, now: number, onlyTops?: { from: number; to: number }): number {
    this.flush();
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    let promoted = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = this.cells.get(keyOf(cx + dx, cz + dz));
        if (!cell || !this.isObstacle(cell, now)) continue;
        const top = cell.top + this.drift;
        if (onlyTops && (top < onlyTops.from || top > onlyTops.to)) continue;
        promoted++;
        cell.ground = cell.top;
        cell.groundWeight = Math.max(cell.groundWeight, 3);
        this.clearEvidence(cell);
      }
    }
    return promoted;
  }

  /** Height of the top of an obstacle at a point (absolute), or null if nothing is there now. */
  obstacleTopAt(x: number, z: number, now: number): number | null {
    this.flush();
    const cell = this.cells.get(keyOf(cellIndex(x), cellIndex(z)));
    return cell && this.isObstacle(cell, now) ? cell.top + this.drift : null;
  }

  /** The worst hazard within `radius` of a point right now, or null if the way looks clear. */
  hazardAt(x: number, z: number, radius: number, now: number): Hazard | null {
    this.flush();
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
    this.flush();
    out.length = 0;
    const r = Math.ceil(radius / CELL_SIZE);
    const cx = cellIndex(x);
    const cz = cellIndex(z);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cell = this.cells.get(keyOf(cx + dx, cz + dz));
        if (!cell) continue;
        const kind: Hazard | null = this.isObstacle(cell, now) ? 'obstacle' : this.isDrop(cell, now) ? 'drop' : null;
        if (kind) out.push({ x: (cx + dx + 0.5) * CELL_SIZE, z: (cz + dz + 0.5) * CELL_SIZE, y: cell.ground + this.drift, kind });
      }
    }
    return out;
  }

  private voteRebase(x: number, y: number, z: number, now: number) {
    const t = this.tuning;
    const time = Number.isFinite(now) ? now : performance.now() / 1000;
    const cell = this.cell(cellIndex(x), cellIndex(z));
    const rebase = cell.rebase;
    const stored = y - this.drift;
    if (time - rebase.at > t.rebaseWindow || Math.abs(stored - rebase.y) > t.rebaseAgree) {
      rebase.count = 0;
      rebase.y = stored;
    }
    rebase.count++;
    rebase.at = time;
    rebase.y += (stored - rebase.y) / rebase.count;
    if (rebase.count < t.rebaseVotes) return;
    const shift = rebase.y - cell.ground;
    const hadGround = cell.groundWeight >= t.trustedWeight;
    cell.ground = rebase.y;
    cell.groundWeight = 3;
    this.clearEvidence(cell);
    cell.floorHitAt = time;
    rebase.count = 0;
    this.rebased++;
    if (hadGround) this.driftByRebase(cell, shift, time);
  }

  /** A known cell re-based: are several moving together, so the whole world is? */
  private driftByRebase(cell: Cell, shift: number, time: number) {
    const t = this.tuning;
    const recent = this.recentRebases;
    while (recent.length && time - recent[0].at > t.driftWindow) recent.shift();
    recent.push({ cell, shift, at: time });
    const agreeing = recent.filter(r => Math.abs(r.shift - shift) <= t.driftAgree);
    if (agreeing.length < t.driftRebases) return;
    const mean = agreeing.reduce((sum, r) => sum + r.shift, 0) / agreeing.length;
    this.drift += mean;
    // Those cells were already moved to the new height; the shift now covers them.
    for (const r of agreeing) r.cell.ground -= mean;
    recent.length = 0;
  }

  private clearEvidence(cell: Cell) {
    cell.seenGround = cell.seenObstacle = cell.seenDrop = 0;
    cell.obstacleFrames = cell.dropFrames = 0;
    cell.obstacleNear = cell.dropNear = Infinity;
    cell.obstacleSpread = cell.dropSpread = 0;
    cell.obstacle = cell.drop = false;
    cell.topSet = false;
  }

  private isObstacle(cell: Cell, now: number) {
    return cell.obstacle && now - cell.obstacleAt < this.tuning.remember;
  }

  private isDrop(cell: Cell, now: number) {
    return cell.drop && now - cell.dropAt < this.tuning.remember;
  }

  private cell(ix: number, iz: number): Cell {
    const key = keyOf(ix, iz);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = {
        ix,
        iz,
        ground: 0,
        groundWeight: 0,
        seenGround: 0,
        seenObstacle: 0,
        seenDrop: 0,
        obstacleFrames: 0,
        dropFrames: 0,
        evidenceAt: -Infinity,
        obstacle: false,
        drop: false,
        obstacleAt: -Infinity,
        dropAt: -Infinity,
        floorHitAt: -Infinity,
        frameGround: 0,
        frameObstacle: 0,
        frameDrop: 0,
        frameRange: 0,
        obstacleNear: Infinity,
        obstacleSpread: 0,
        obstacleFrom: { x: NaN, z: NaN, range: 0 },
        dropNear: Infinity,
        dropSpread: 0,
        dropFrom: { x: NaN, z: NaN, range: 0 },
        pending: false,
        top: 0,
        topSet: false,
        rebase: { count: 0, at: -Infinity, y: 0 },
      };
      this.cells.set(key, cell);
    }
    return cell;
  }
}
