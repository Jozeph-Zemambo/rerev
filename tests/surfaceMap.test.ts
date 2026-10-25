import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceMap } from '../src/world/surfaceMap';

/**
 * Walk towards a step `kerb` metres up or down at z = -3 (pavement at y = 0 before it), with a
 * 40 cm box beyond it at z = -6, feeding the map the way the phone does: three ground rays and a
 * strip of depth points, ten times a second. Returns how often the step was flagged as a hazard.
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
    for (const ahead of [1.4, 2.4, 3.8]) map.addGroundSample(0, ground(camera - ahead), camera - ahead, 2, map.groundTolerance(0.1), now);
    for (let d = 0.6; d <= 5; d += 0.2) {
      for (const x of [-0.4, 0, 0.4]) {
        const z = camera - d;
        const onBox = z < -5.8 && z > -6.2 && Math.abs(x) < 0.3;
        map.addDepthPoint(x, onBox ? kerb + 0.4 : ground(z), z, now, d);
      }
    }
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
  const map = new SurfaceMap();
  map.seedGround(0, 0, -1, 2);
  for (let i = 0; i < 4; i++) map.addDepthPoint(0, 0.5, -1, i * 0.1, 1);
  assert.equal(map.hazardAt(0, -1, 0.1, 0.4), 'obstacle');
  map.addDepthPoint(0, 0, -1, 2, 1);
  assert.equal(map.hazardAt(0, -1, 0.1, 2.7), null);
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
