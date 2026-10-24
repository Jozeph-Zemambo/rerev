import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteCallouts } from '../src/run/callouts';
import type { TurnStep } from '../src/geo/routing';

const at = { lat: 0, lon: 0 };
const step = (fromStart: number, modifier: string, street = '', type = 'turn'): TurnStep => ({ at, type, modifier, street, fromStart });

/** Run at 2.8 m/s, optionally resting for `rest` seconds at `restAt` metres; returns what was said. */
function run(steps: TurnStep[], distance: number, rest?: { at: number; seconds: number }) {
  const callouts = new RouteCallouts();
  callouts.reset(0, steps, distance);
  const said: string[] = [];
  let s = 0;
  let rested = 0;
  for (let t = 0; s < distance; t += 0.1) {
    const breaking = !!rest && s >= rest.at && rested < rest.seconds;
    if (breaking) rested += 0.1;
    else s = Math.min(distance, s + 0.28);
    const line = callouts.update(t, s, s, breaking);
    if (line) said.push(line.text);
  }
  return said;
}

test('turns are called ahead, and close turns in one breath', () => {
  const said = run([step(0, '', 'Start', 'depart'), step(120, 'left', 'Richard Rd'), step(135, 'slight right'), step(400, 'straight', 'Elbow Dr', 'new name'), step(600, 'sharp right', 'Lincoln Way')], 700);
  assert.deepEqual(said, ['Left onto Richard Rd, then bear right.', 'Sharp right onto Lincoln Way up ahead.']);
});

test('kilometre splits leave out time spent on a breather', () => {
  const said = run([], 2100, { at: 500, seconds: 60 });
  const split = said.find(text => text.startsWith('1 kilometre'));
  // 1000 m at 2.8 m/s is 5:57, whatever the minute of rest in the middle.
  assert.equal(split, '1 kilometre done! That one took 5:57.');
  assert.ok(said.includes("Halfway there! You're doing great."));
  assert.ok(said.includes('Last hundred metres. Finish strong!'));
});

test('the lap course calls each lap', () => {
  const callouts = new RouteCallouts();
  callouts.reset(0, [], 0, 13.5);
  const said: string[] = [];
  for (let s = 0; s <= 30; s += 0.5) {
    const line = callouts.update(s, s, s, false);
    if (line) said.push(line.text);
  }
  assert.deepEqual(said, ["That's lap 1!", 'Lap 2 done. Looking good!']);
});

test('short runs get no splits or halfway', () => {
  assert.deepEqual(run([], 300), []);
});
