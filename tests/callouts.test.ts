import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteCallouts } from '../src/run/callouts';
import { bubbleText, kmLineId, lapLineId, lineById, type Spoken } from '../src/voice/lines';
import type { TurnStep } from '../src/geo/routing';
import * as THREE from 'three';
import { lapRoute, Path } from '../src/world/path';

const at = { lat: 0, lon: 0 };
const step = (fromStart: number, modifier: string, street = '', type = 'turn'): TurnStep => ({ at, type, modifier, street, fromStart });

/** Run at 2.8 m/s, optionally resting for `rest` seconds at `restAt` metres; returns what was said. */
function run(steps: TurnStep[], distance: number, rest?: { at: number; seconds: number }) {
  const callouts = new RouteCallouts();
  callouts.reset(0, steps, distance);
  const said: Spoken[] = [];
  let s = 0;
  let rested = 0;
  for (let t = 0; s < distance; t += 0.1) {
    const breaking = !!rest && s >= rest.at && rested < rest.seconds;
    if (breaking) rested += 0.1;
    else s = Math.min(distance, s + 0.28);
    const line = callouts.update(t, s, s, breaking);
    if (line) said.push(line);
  }
  return said;
}

test('turns are called ahead, and close turns in one breath', () => {
  const said = run([step(0, '', 'Start', 'depart'), step(120, 'left', 'Richard Rd'), step(135, 'slight right'), step(400, 'straight', 'Elbow Dr', 'new name'), step(600, 'sharp right', 'Lincoln Way')], 700);
  assert.deepEqual(said, [
    { id: 'turn_double', bubble: 'Left onto Richard Rd in 30 m, then bear right.' },
    { id: 'turn_sharp_right', bubble: 'Sharp right onto Lincoln Way in 30 m' },
  ]);
});

test('the voice says a generic turn line while the bubble names the street', () => {
  const [left] = run([step(100, 'left', 'Richard Rd')], 200);
  assert.equal(lineById(left.id).text, 'Left turn coming up!');
  assert.equal(bubbleText(left), 'Left onto Richard Rd in 30 m');
  const [uturn] = run([step(100, 'uturn')], 200);
  assert.equal(lineById(uturn.id).text, 'Turn around up here.');
});

test('kilometre splits leave out time spent on a breather', () => {
  const said = run([], 2100, { at: 500, seconds: 60 });
  const split = said.find(line => line.id === 'split_km_1');
  // 1000 m at 2.8 m/s is 5:57, whatever the minute of rest in the middle. The voice keeps it
  // short; the bubble has the time.
  assert.equal(lineById('split_km_1').text, 'One K done!');
  assert.equal(split?.bubble, '1 km done in 5:57');
  assert.ok(said.some(line => line.id === 'split_km_2'));
  assert.ok(said.some(line => line.id === 'route_halfway'));
  assert.ok(said.some(line => line.id === 'route_final_stretch'));
});

test('the lap course calls each lap', () => {
  const callouts = new RouteCallouts();
  callouts.reset(0, [], 0, 13.5);
  const said: Spoken[] = [];
  for (let s = 0; s <= 30; s += 0.5) {
    const line = callouts.update(s, s, s, false);
    if (line) said.push(line);
  }
  assert.deepEqual(said, [
    { id: 'lap_1', bubble: 'Lap 1 done!' },
    { id: 'lap_2', bubble: 'Lap 2 done!' },
  ]);
});

test('every lap of the 20-lap course is called, including the last', () => {
  const path = new Path();
  path.setRoute(lapRoute(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 20), 0);
  const callouts = new RouteCallouts();
  callouts.reset(0, [], 0, path.length / 20);
  const laps: string[] = [];
  // Progress can't go past the end of the path, just as on the phone.
  for (let s = 0; s <= path.length + 5; s += 0.25) {
    const line = callouts.update(s, Math.min(s, path.length), Math.min(s, path.length), false);
    if (line) laps.push(line.id);
  }
  assert.equal(laps.length, 20);
  assert.equal(laps.at(-1), 'lap_20');
});

test('splits and laps past the numbered lines use the generic ones', () => {
  assert.equal(kmLineId(10), 'split_km_10');
  assert.equal(kmLineId(11), 'split_km_more');
  assert.equal(lapLineId(20), 'lap_20');
  assert.equal(lapLineId(21), 'lap_more');
});

test('short runs get no splits or halfway', () => {
  assert.deepEqual(run([], 300), []);
});
