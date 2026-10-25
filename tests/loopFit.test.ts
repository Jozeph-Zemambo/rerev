import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLoop, LOOP_MAX_TRIES, LOOP_TOLERANCE, loopWaypoints, nextLoopShape, type LoopShape } from '../src/geo/routing';
import { bearingDeg, distanceMetres, MRU } from '../src/geo/geo';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test('one try rescales in proportion to how far off it was', () => {
  // Asked for 1 km, got 1.6 km: shrink the triangle to 1/1.6 of its size.
  assert.deepEqual(nextLoopShape([{ stretch: 1, turn: 0, distance: 1600 }], 1000), { stretch: 1 / 1.6, turn: 0 });
});

test('two tries either side of the target interpolate between them', () => {
  // 0.5 -> 800 m, 0.75 -> 1200 m: 1000 m sits halfway.
  const next = nextLoopShape(
    [
      { stretch: 0.75, turn: 0, distance: 1200 },
      { stretch: 0.5, turn: 0, distance: 800 },
    ],
    1000,
  );
  assert.ok(next && close(next.stretch, 0.625) && next.turn === 0, JSON.stringify(next));
});

test('two tries on one side follow the line through them, fixed overhead and all', () => {
  // Streets = 600 m to reach + 1000 m per unit stretch. 1.0 -> 1600, 0.8 -> 1400: 1000 m needs 0.4,
  // but no further than twice the plain rescale (0.8 -> 0.571) would go: 0.8 - 2 * 0.229 = 0.343.
  const next = nextLoopShape(
    [
      { stretch: 1, turn: 0, distance: 1600 },
      { stretch: 0.8, turn: 0, distance: 1400 },
    ],
    1000,
  );
  assert.ok(next && close(next.stretch, 0.4), JSON.stringify(next));
});

test('when the streets jump across the target, the loop turns instead of resizing', () => {
  // A 7% resize took the route from 5.6 km to 3.4 km: a creek, not a slope.
  const next = nextLoopShape(
    [
      { stretch: 1, turn: 0, distance: 5750 },
      { stretch: 0.87, turn: 0, distance: 5560 },
      { stretch: 0.81, turn: 0, distance: 3400 },
    ],
    5000,
  );
  assert.equal(next?.turn, 25);
  // Restarts from the closest so far (0.87 -> 5560) in proportion.
  assert.ok(next && close(next.stretch, (0.87 * 5000) / 5560), JSON.stringify(next));
});

test('when resizing changes nothing, the loop turns', () => {
  const next = nextLoopShape(
    [
      { stretch: 1, turn: 0, distance: 1280 },
      { stretch: 0.78, turn: 0, distance: 1260 },
    ],
    1000,
  );
  assert.equal(next?.turn, 25);
});

test('after every turn has been tried there is nothing left', () => {
  const tries = [
    { stretch: 1, turn: -25, distance: 1280 },
    { stretch: 0.78, turn: -25, distance: 1260 },
  ];
  assert.equal(nextLoopShape(tries, 1000), null);
});

test('one wild route cannot more than halve or double the loop', () => {
  assert.equal(nextLoopShape([{ stretch: 1, turn: 0, distance: 10000 }], 1000)?.stretch, 0.5);
  assert.equal(nextLoopShape([{ stretch: 1, turn: 0, distance: 100 }], 1000)?.stretch, 2);
});

test('fitLoop converges on streets that run long', async () => {
  // Streets 1.25x the triangle plus 400 m to get out to the first street and back.
  for (const km of [1, 2, 3, 5]) {
    const target = km * 1000;
    const streets = async ({ stretch }: LoopShape) => ({ distance: target * 1.25 * stretch + 400 });
    const { route, tries } = await fitLoop(target, streets);
    assert.ok(Math.abs(route.distance - target) / target <= LOOP_TOLERANCE, `${km} km came out ${route.distance}`);
    assert.ok(tries.length <= 3, `${km} km took ${tries.length} tries`);
  }
});

test('fitLoop stops at the first try when it is already close', async () => {
  const { tries } = await fitLoop(2000, async () => ({ distance: 2100 }));
  assert.equal(tries.length, 1);
});

test('fitLoop keeps the closest route when streets never line up', async () => {
  // Distance jumps from 700 m to 1400 m: never within 10% of 1 km at any size or turn.
  const steps = async ({ stretch }: LoopShape) => ({ distance: stretch < 0.7 ? 700 : 1400 });
  const { route, tries } = await fitLoop(1000, steps);
  assert.ok(tries.length <= LOOP_MAX_TRIES);
  assert.equal(Math.abs(route.distance - 1000), Math.min(...tries.map(t => Math.abs(t.distance - 1000))));
});

test('fitLoop keeps an earlier loop when a later shape has no route', async () => {
  let calls = 0;
  const { route, tries } = await fitLoop(1000, async () => {
    if (calls++ > 0) throw new Error('No walking route found here');
    return { distance: 1500 };
  });
  assert.equal(route.distance, 1500);
  assert.equal(tries.length, 1);
});

test('fitLoop tries one shape at a time and stops when aborted', async () => {
  const controller = new AbortController();
  let inFlight = 0;
  let calls = 0;
  const attempt = async () => {
    inFlight++;
    assert.equal(inFlight, 1, 'requests overlap');
    await new Promise(resolve => setTimeout(resolve, 1));
    inFlight--;
    if (++calls === 2) controller.abort();
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { distance: 3000 };
  };
  await assert.rejects(fitLoop(1000, attempt), /Aborted/);
  assert.equal(calls, 2);
});

test('a bigger stretch moves the loop waypoints further out, bearing kept', () => {
  const near = loopWaypoints(MRU, 2, 45, 0.5);
  const far = loopWaypoints(MRU, 2, 45, 1);
  assert.ok(Math.abs(distanceMetres(MRU, far[1]) - 2 * distanceMetres(MRU, near[1])) < 1);
  assert.ok(Math.abs(bearingDeg(MRU, far[1]) - 45) < 0.1);
  assert.deepEqual(far[0], MRU);
  assert.deepEqual(far[3], MRU);
});
