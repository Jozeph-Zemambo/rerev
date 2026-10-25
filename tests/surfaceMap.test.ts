import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceMap } from '../src/world/surfaceMap';

/**
 * Walk towards a step `kerb` metres up or down at z = -3 (pavement at y = 0 before it), with a
 * 40 cm box beyond it at z = -6, feeding the map the way the phone does: three ground rays and a
 * strip of depth points (10 cm apart, a few hundred a frame; the phone gives about 700), ten
 * times a second. Returns how often the step was flagged as a hazard.
 */
function walkTowardsStep(kerb: number, walkableStep: number) {
  const map = new SurfaceMap();
  map.walkableStep = walkableStep;
  map.seedGround(0, 0, 0, 1);
  const ground = (z: number) => (z < -3 ? kerb : 0);
  let flagged = 0;
  let now = 0;
  for (let frame = 0; frame < 40; frame++, now += 0.1) {
    const camera = -frame * 0.1;
    map.addFloorHits([1.4, 2.4, 3.8].map(ahead => ({ x: 0, y: ground(camera - ahead), z: camera - ahead })), now);
    const points = [];
    for (let d = 0.6; d <= 5; d += 0.1) {
      for (let x = -0.4; x <= 0.41; x += 0.1) {
        const z = camera - d;
        const onBox = z < -5.8 && z > -6.2 && Math.abs(x) < 0.3;
        points.push({ x, y: onBox ? kerb + 0.4 : ground(z), z, d });
      }
    }
    map.addDepthFrame(points, now, { x: 0, y: 1.4, z: camera });
    if (map.hazardAt(0, -3.4, 0.4, now)) flagged++;
  }
  return { flagged, box: map.hazardAt(0, -6, 0.3, now) };
}

test('indoors, a single step down is a hazard', () => {
  assert.ok(walkTowardsStep(-0.17, 0).flagged > 20);
});

test('outdoors, stepping off a kerb is not', () => {
  assert.equal(walkTowardsStep(-0.17, 0.2).flagged, 0);
  assert.equal(walkTowardsStep(0.18, 0.2).flagged, 0);
});

test('a box on the path is an obstacle either way', () => {
  assert.equal(walkTowardsStep(0, 0).box, 'obstacle');
  assert.equal(walkTowardsStep(-0.15, 0.2).box, 'obstacle');
});

test('an obstacle is forgotten once bare floor is seen there again', () => {
  // A bag 1 m ahead (two cells wide) for half a second, then picked up.
  const map = new SurfaceMap();
  map.seedGround(0, 0, -1, 2);
  const look = (y: number, now: number) => {
    for (const x of [0.05, 0.1, 0.25, 0.3]) map.addDepthPoint(x, y, -1, now, 1);
  };
  for (let i = 0; i < 5; i++) look(0.5, i * 0.1);
  assert.equal(map.hazardAt(0.1, -1, 0.1, 0.5), 'obstacle');
  for (let i = 0; i < 10; i++) look(0, 2 + i * 0.1);
  assert.equal(map.hazardAt(0.1, -1, 0.1, 3), null);
});

test('a ground height set too high corrects itself from the phone\'s floor detection', () => {
  // The run started with the floor 15 cm too high (say the tap hit the grass), on flat pavement.
  // The phone points down at the ground, so its floor detections land close, inside the bad area.
  const map = new SurfaceMap();
  map.seedGround(0, 0.15, 0, 1);
  map.seedGround(0, 0.15, -1, 1);
  let flagged = 0;
  let now = 0;
  for (let frame = 0; frame < 40; frame++, now += 0.1) {
    const camera = -frame * 0.1;
    for (const ahead of [0.5, 0.9, 1.3]) map.addGroundSample(0, 0, camera - ahead, 2, map.groundTolerance(0.1), now);
    for (let d = 0.6; d <= 5; d += 0.2) for (const x of [-0.4, 0, 0.4]) map.addDepthPoint(x, 0, camera - d, now, d);
    if (frame >= 20 && map.hazardAt(0, camera - 2, 0.6, now)) flagged++;
  }
  assert.ok(map.rebased > 0, 'the map should have moved its ground down');
  assert.equal(flagged, 0, 'flat pavement should not stay a "drop"');
});

/** Walk 4 m over flat ground (y = 0) where the phone's floor detection is right but depth isn't. */
function walkWithBiasedDepth(depthY: (range: number) => number) {
  const map = new SurfaceMap();
  map.seedGround(0, 0, 0, 1);
  let now = 0;
  let flagged = 0;
  for (let frame = 0; frame < 40; frame++, now += 0.1) {
    const camera = -frame * 0.1;
    for (const ahead of [0.5, 0.9, 1.3]) map.addGroundSample(0, 0, camera - ahead, 2, map.groundTolerance(0.1), now);
    const points = [];
    for (let d = 0.6; d <= 5; d += 0.2) for (const x of [-0.4, 0, 0.4]) points.push({ x, y: depthY(d), z: camera - d, d });
    map.addDepthFrame(points, now);
    if (frame >= 10 && map.hazardAt(0, camera - 1.5, 0.6, now) === 'drop') flagged++;
  }
  return { map, flagged };
}

test('depth readings that drift with distance never drag the ground down with them', () => {
  // Field test: the ground crept a metre below the street, one cell at a time.
  const { map } = walkWithBiasedDepth(range => -0.04 * range);
  for (const z of [-2, -4, -6]) {
    const ground = map.referenceGround(0, z);
    assert.ok(ground !== null && Math.abs(ground) < 0.02, `ground at z=${z} should stay at the floor, got ${ground}`);
  }
});

test('near depth sinking below a floor the phone says is flat is not a drop', () => {
  // Field test: near readings 15-40 cm below the floor while the floor detection agreed.
  const { map, flagged } = walkWithBiasedDepth(range => (range < 2 ? -0.3 : 0));
  assert.equal(flagged, 0);
  assert.ok(map.distrustedFrames > 0);
});

test('the floor detection can move the ground up a kerb, but a table top never becomes ground', () => {
  const map = new SurfaceMap();
  map.seedGround(0, 0, 0, 1);
  for (let i = 0; i < 6; i++) map.addGroundSample(0, 0.15, -0.6, 2, 0.1, i * 0.1); // a kerb top
  assert.ok(Math.abs((map.groundAt(0, -0.6) ?? 0) - 0.15) < 0.01, 'kerb top should become ground');
  for (let i = 0; i < 6; i++) map.addGroundSample(0.6, 0.75, 0, 2, 0.1, i * 0.1); // a table
  assert.ok(Math.abs(map.groundAt(0.6, 0) ?? 0) < 0.01, 'a table must not become ground');
});

test('known ground re-based by the same amount in several places moves the whole map', () => {
  // Field test: the phone's world crept up 12 cm through a second floor plane, cell by cell.
  const map = new SurfaceMap();
  map.seedGround(0, 0, 0, 2);
  let now = 0;
  for (const [x, z] of [[0, -1], [0.6, -1.2], [-0.6, -1.4]]) {
    for (let i = 0; i < 3; i++, now += 0.05) map.addFloorHits([{ x, y: 0.12, z }], now);
  }
  const far = map.groundAt(1.2, 1.2);
  assert.ok(far !== null && Math.abs(far - 0.12) < 0.01, `untouched ground should follow, got ${far}`);
  assert.ok(Math.abs((map.groundAt(0, -1) ?? 0) - 0.12) < 0.01, 're-based cells stay where the floor is');
});

/**
 * Field-measured depth error on a flat hallway floor while walking, by distance, as percentiles
 * (fraction of points, error in metres). Measured: 5%, 50% and 95% per distance band, and that
 * within 2.5 m 12% / 5% of floor points read 15 / 30 cm+ high and 17% / 6% that far low; the
 * 1.5-2.5 m band's inner knots come from those shares. The 0% and 100% ends are guesses.
 */
const DEPTH_ERROR: [upTo: number, knots: [number, number][]][] = [
  [1.5, [[0, -0.45], [0.05, -0.17], [0.5, 0], [0.95, 0.14], [1, 0.4]]],
  [2.5, [[0, -0.9], [0.05, -0.37], [0.11, -0.3], [0.28, -0.15], [0.5, 0.01], [0.805, 0.15], [0.905, 0.3], [0.95, 0.37], [1, 0.9]]],
  [3.5, [[0, -0.8], [0.05, -0.26], [0.5, 0.08], [0.95, 0.83], [1, 1.5]]],
  [Infinity, [[0, -0.9], [0.05, -0.38], [0.5, 0.07], [0.95, 0.82], [1, 1.5]]],
];

/** Small seeded generator, so the noisy tests are repeatable. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A height error drawn from DEPTH_ERROR (`u` uniform in 0-1), straight between the knots. */
function depthError(range: number, u: number) {
  const knots = DEPTH_ERROR.find(([upTo]) => range < upTo)![1];
  let i = 1;
  while (i < knots.length - 1 && u > knots[i][0]) i++;
  const [u0, e0] = knots[i - 1];
  const [u1, e1] = knots[i];
  return e0 + ((e1 - e0) * (u - u0)) / (u1 - u0);
}

/**
 * Walk 1.5 m/s along -z over a flat floor (y = 0) with depth as noisy as the field test,
 * optionally towards a 40 cm box `boxHeight` tall at z = -7. Each frame has about as many points
 * as the phone's (a 1.6 m wide strip, 0.6-5 m ahead), and five floor hits 1.2-2 m ahead that,
 * like the phone's plane hits, land on the floor even under the box. Returns when (if ever) the
 * box was confirmed, and how many times flat floor was flagged ahead.
 */
function noisyWalk(seed: number, boxHeight: number | null) {
  const map = new SurfaceMap();
  map.seedGround(0, 0, 0, 1);
  const rand = random(seed);
  const onBox = (x: number, z: number) => boxHeight !== null && Math.abs(x) <= 0.2 && z <= -6.8 && z >= -7.2;
  let confirmedAt: number | null = null;
  let falseAlarms = 0;
  for (let frame = 0; frame < 45; frame++) {
    const now = frame * 0.1;
    const camera = -1.5 * now;
    map.addFloorHits([1.2, 1.4, 1.6, 1.8, 2].map((ahead, i) => ({ x: (i - 2) * 0.15, y: 0, z: camera - ahead })), now);
    const points = [];
    for (let d = 0.6; d <= 5; d += 0.1) {
      for (let x = -0.8; x <= 0.8; x += 0.1) {
        const z = camera - d;
        const y = (onBox(x, z) ? boxHeight! : 0) + depthError(d, rand());
        points.push({ x, y, z, d });
      }
    }
    map.addDepthFrame(points, now, { x: 0, y: 1.4, z: camera });
    if (boxHeight !== null && confirmedAt === null && map.hazardAt(0, -7, 0.2, now) === 'obstacle') confirmedAt = now;
    // Flat floor in the corridor ahead (short of the box): nothing should show.
    for (let ahead = 0.5; ahead <= 4; ahead += 0.25) {
      const z = camera - ahead;
      if (boxHeight !== null && z < -6.2) continue;
      if (map.hazardAt(0, z, 0.3, now)) falseAlarms++;
    }
  }
  return { confirmedAt, falseAlarms };
}

test('under field-measured depth noise, a 35 cm box ahead is confirmed within about a second', () => {
  // The box (front face at z = -6.8) is 3 m away at t = 2.53 s and 1.5 m away at t = 3.53 s.
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { confirmedAt } = noisyWalk(seed, 0.35);
    assert.ok(confirmedAt !== null && confirmedAt <= 3.6, `seed ${seed}: confirmed at ${confirmedAt}`);
  }
});

test('under the same noise, flat floor ahead raises no hazards', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.equal(noisyWalk(seed, null).falseAlarms, 0, `seed ${seed}`);
    assert.equal(noisyWalk(seed, 0.35).falseAlarms, 0, `seed ${seed}, before the box`);
  }
});
