import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitLoop, LOOP_MAX_TRIES, LOOP_TOLERANCE, loopWaypoints, nextLoopStretch } from '../src/geo/routing';
import { distanceMetres, MRU } from '../src/geo/geo';

test('one try rescales in proportion to how far off it was', () => {
  // Asked for 1 km, got 1.6 km: shrink the triangle to 1/1.6 of its size.
  assert.equal(nextLoopStretch([{ stretch: 1, distance: 1600 }], 1000), 1 / 1.6);
});

test('two tries take the secant through both', () => {
  // 1.0 -> 1600 m, 0.6 -> 1200 m: 1000 m per unit of stretch, so 200 m less is 0.2 less.
  const next = nextLoopStretch(
    [
      { stretch: 1, distance: 1600 },
      { stretch: 0.6, distance: 1200 },
    ],
    1000,
  );
  assert.ok(Math.abs(next - 0.4) < 1e-9, `got ${next}`);
});

test('a secant that slopes the wrong way falls back to proportional', () => {
  // A bigger triangle came out shorter (a different bridge): don't trust that slope.
  const next = nextLoopStretch(
    [
      { stretch: 1, distance: 1500 },
      { stretch: 0.7, distance: 1600 },
    ],
    1000,
  );
  assert.ok(Math.abs(next - 0.7 / 1.6) < 1e-9, `got ${next}`);
});

test('one wild route cannot more than halve or double the loop', () => {
  assert.equal(nextLoopStretch([{ stretch: 1, distance: 10000 }], 1000), 0.5);
  assert.equal(nextLoopStretch([{ stretch: 1, distance: 100 }], 1000), 2);
});

test('fitLoop converges on streets that run long', async () => {
  // Streets 1.8x the triangle plus a fixed 150 m to reach the first one.
  const streets = (target: number) => async (stretch: number) => ({ distance: target * 0.8 * stretch * 1.8 + 150 });
  for (const km of [1, 2, 3, 5]) {
    const target = km * 1000;
    const { route, tries } = await fitLoop(target, streets(target));
    assert.ok(Math.abs(route.distance - target) / target <= LOOP_TOLERANCE, `${km} km came out ${route.distance}`);
    assert.ok(tries.length <= 3, `${km} km took ${tries.length} tries`);
  }
});

test('fitLoop stops at the first try when it is already close', async () => {
  let calls = 0;
  const { tries } = await fitLoop(2000, async () => ({ distance: 2100 + calls++ }));
  assert.equal(tries.length, 1);
});

test('fitLoop keeps the closest route when streets never line up', async () => {
  // Distance jumps in big steps (one route, then the long way round): never within 10%.
  const steps = async (stretch: number) => ({ distance: stretch < 0.7 ? 700 : 1400, stretch });
  const { route, tries } = await fitLoop(1000, steps);
  assert.ok(tries.length <= LOOP_MAX_TRIES);
  assert.ok([700, 1400].includes(route.distance));
  const errors = tries.map(t => Math.abs(t.distance - 1000));
  assert.equal(Math.abs(route.distance - 1000), Math.min(...errors));
});

test('fitLoop tries one size at a time and stops when aborted', async () => {
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
  assert.deepEqual(far[0], MRU);
  assert.deepEqual(far[3], MRU);
});
