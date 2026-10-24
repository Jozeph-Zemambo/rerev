import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buddyMotion, type Gait } from '../src/partner/buddyMotion';
import { BUILT_HEIGHT, PACE_DEFAULTS } from '../src/partner/buddyPace';

const H = 1.3;
const gait = (g: Partial<Gait>): Gait => ({ speed: 0, inPlace: false, grade: 0, ...g });
const clipOf = (g: Partial<Gait>, running = false) => {
  const m = buddyMotion(gait(g), running, H);
  return m.kind === 'pace' ? 'pace' : m.clip;
};

test('standing about before a run idles and waves', () => {
  const m = buddyMotion(gait({ idle: true }), false, H);
  assert.deepEqual(m.kind === 'loop' && [m.clip, m.flourish?.clip, m.flourish?.every], ['Idle', 'Wave', 4.5]);
});

test('running, stairs and looking ahead follow the speed', () => {
  for (const state of ['run', 'stairs', 'look'] as const) {
    assert.deepEqual(buddyMotion(gait({ state, speed: 1.6 }), false, H), { kind: 'pace', speed: 1.6 });
  }
});

test('too slow to run, or looking from a standstill, jogs on the spot', () => {
  assert.equal(clipOf({ state: 'run', speed: 0.1 }), 'JogInPlace');
  assert.equal(clipOf({ state: 'look', speed: 0.2, inPlace: true }), 'JogInPlace');
});

test('slowing down keeps running a little past the too-slow line, so it does not flicker', () => {
  // Just under the line: a buddy already running keeps going; one on the spot stays there.
  const justUnder = 0.79 * (H / BUILT_HEIGHT) * PACE_DEFAULTS.minLegSpeed * 0.95;
  assert.equal(clipOf({ state: 'run', speed: justUnder }, true), 'pace');
  assert.equal(clipOf({ state: 'run', speed: justUnder }, false), 'JogInPlace');
});

test('waiting for the runner jogs on the spot and beckons', () => {
  const m = buddyMotion(gait({ state: 'wait', inPlace: true }), true, H);
  assert.deepEqual(m.kind === 'loop' && [m.clip, m.flourish?.clip], ['JogInPlace', 'Beckon']);
});

test('breaks, blocked paths and U-turns jog on the spot; the finish waves', () => {
  for (const state of ['break', 'blocked', 'turn'] as const) assert.equal(clipOf({ state, inPlace: true }), 'JogInPlace');
  assert.equal(clipOf({ state: 'done', inPlace: true }), 'Wave');
});
