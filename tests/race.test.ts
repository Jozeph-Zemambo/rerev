import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Partner, type PartnerState } from '../src/partner/partner';
import { paceTarget } from '../src/partner/pacing';
import { COUNT_STEP, formatRaceTime, RaceClock, raceLap, raceSpan, READY_TIME, RACE_START_LEAD, type RaceBeat } from '../src/run/race';
import { buildCourse, courseRun } from '../src/world/course';
import { demoRoute, Path } from '../src/world/path';

const DT = 1 / 60;
const GO = READY_TIME + 3 * COUNT_STEP;

test('the countdown goes ready, 3, 2, 1, go, once each, then the race clock runs', () => {
  const clock = new RaceClock();
  clock.start(100);
  const beats: [number, RaceBeat][] = [];
  const shown = new Set<string>();
  for (let t = 100; t < 100 + GO + 2; t += DT) {
    const beat = clock.update(t);
    if (beat !== null) beats.push([t - 100, beat]);
    const text = clock.display(t);
    if (text) shown.add(text);
  }
  assert.deepEqual(beats.map(b => b[1]), ['ready', 3, 2, 1, 'go']);
  assert.ok(Math.abs(beats[1][0] - READY_TIME) < 0.02);
  assert.ok(Math.abs(beats[4][0] - GO) < 0.02);
  assert.deepEqual([...shown], ['3', '2', '1', 'GO!']);
  assert.equal(clock.phase, 'racing');
  assert.equal(clock.elapsed(100 + GO - 1), 0, 'no race time before go');
  assert.ok(Math.abs(clock.elapsed(100 + GO + 12.5) - 12.5) < 1e-9);
  assert.equal(clock.display(100 + GO + 1.5), null, 'GO! clears');
});

test('a slow frame that skips beats never says a late number after go', () => {
  const clock = new RaceClock();
  clock.start(0);
  assert.equal(clock.update(0), 'ready');
  assert.equal(clock.update(READY_TIME + 0.2), 3);
  // A long hitch straight past 2 and 1.
  assert.equal(clock.update(GO + 0.1), 'go');
  assert.equal(clock.update(GO + 0.2), null);
});

test('the race time freezes at the finish, and stopping in the countdown is no time at all', () => {
  const clock = new RaceClock();
  clock.start(0);
  clock.update(GO);
  clock.finish(GO + 20);
  assert.equal(clock.phase, 'finished');
  assert.equal(clock.elapsed(GO + 99), 20);
  clock.finish(GO + 30);
  assert.equal(clock.elapsed(GO + 99), 20, 'finishing twice keeps the first time');

  const early = new RaceClock();
  early.start(0);
  early.update(1);
  early.finish(2);
  assert.equal(early.elapsed(50), 0);
});

test('laps count from 1 and stop at the last', () => {
  assert.equal(raceLap(0, 10, 2), 1);
  assert.equal(raceLap(9.99, 10, 2), 1);
  assert.equal(raceLap(10, 10, 2), 2);
  assert.equal(raceLap(25, 10, 2), 2);
  assert.equal(raceLap(5, 0, 2), 1);
});

test('race times read as minutes, seconds and tenths', () => {
  assert.equal(formatRaceTime(0), '0:00.0');
  assert.equal(formatRaceTime(42.37), '0:42.3');
  assert.equal(formatRaceTime(61.05), '1:01.0');
  assert.equal(formatRaceTime(599.99), '9:59.9');
});

test('the start line is a couple of metres from the phone and the finish laps on from it', () => {
  assert.deepEqual(raceSpan(0, 20, 2), { start: RACE_START_LEAD, finish: RACE_START_LEAD + 40 });
  // A tiny course: the start stays short of the first turnaround.
  const tiny = raceSpan(0, 4, 3, 2);
  assert.ok(tiny.start < 2 && tiny.start > 0);
  assert.equal(tiny.finish, tiny.start + 12);
});

test('free pacing holds the goal pace whatever the runner does', () => {
  const base = { mode: 'free' as const, lead: 30, targetLead: 2, maxLead: 4.5, goalPace: 2.5, effort: 1.2, hill: 1 };
  assert.equal(paceTarget({ ...base, runnerSpeed: 0 }), 2.5);
  assert.equal(paceTarget({ ...base, runnerSpeed: 3, lead: -5 }), 2.5);
  assert.ok(paceTarget({ ...base, runnerSpeed: 0, hill: 0.8 }) < 2.5);
});

/** A hallway walked out 8 m, raced there and back twice with the phone standing at the start. */
function hallwayRace(laps = 2) {
  const walk = Array.from({ length: 33 }, (_, i) => ({ x: 0, z: -i * 0.25 }));
  const course = buildCourse(walk)!;
  const run = courseRun(course, { x: 0, z: 0.3 }, laps + 1);
  const path = new Path();
  path.setRoute(run.points, 0);
  path.trustRoute = true;
  path.status.seenUntilS = path.length;
  const partner = new Partner(path);
  partner.turnarounds = run.turnarounds;
  const lapLength = path.length / run.laps;
  const span = raceSpan(0, lapLength, laps, run.turnarounds[0]);
  partner.pacing = 'free';
  partner.goalPace = 2.5;
  partner.finishAt = span.finish;
  partner.reset(0, span.start);
  return { partner, path, span, turnarounds: run.turnarounds, lapLength };
}

test('racing, the buddy runs the course on its own: turns, laps and finishes with the phone standing still', () => {
  const { partner, span, turnarounds, lapLength } = hallwayRace(2);
  assert.equal(partner.s, span.start);
  const states: PartnerState[] = [];
  let t = 0;
  let topSpeed = 0;
  for (; t < 60 && partner.state !== 'done'; t += DT) {
    partner.update(DT, 0);
    topSpeed = Math.max(topSpeed, partner.currentSpeed);
    if (states.at(-1) !== partner.state) states.push(partner.state);
  }
  assert.equal(partner.state, 'done', 'finished');
  assert.ok(Math.abs(partner.s - span.finish) < 0.01, `finished at ${partner.s.toFixed(2)}, line at ${span.finish.toFixed(2)}`);
  assert.ok(!states.includes('wait'), `never waits: ${states.join(' → ')}`);
  // Two there-and-backs: three turnarounds before the finish (out, back, out again… then back past the start).
  const turnsBeforeFinish = turnarounds.filter(x => x < span.finish).length;
  assert.equal(states.filter(s => s === 'turn').length, turnsBeforeFinish);
  assert.ok(Math.abs(topSpeed - 2.5) < 0.05, `top speed ${topSpeed.toFixed(2)}`);
  // 2 × ~16 m at 2.5 m/s, plus braking and turning: well under twenty seconds.
  const distance = 2 * lapLength;
  assert.ok(t > distance / 2.5 && t < distance / 2.5 + 8, `took ${t.toFixed(1)} s for ${distance.toFixed(1)} m`);
});

test('the buddy eases into the finish rather than stopping dead', () => {
  const { partner, span } = hallwayRace(1);
  let lastSpeed = 0;
  for (let t = 0; t < 60 && partner.state !== 'done'; t += DT) {
    if (span.finish - partner.s < 0.15 && !lastSpeed) lastSpeed = partner.currentSpeed;
    partner.update(DT, 0);
  }
  assert.ok(lastSpeed > 0.3 && lastSpeed < 1.5, `crossed the line at ${lastSpeed.toFixed(2)} m/s`);
});

test('let it run ahead: on a course run it does not wait for a runner who stops, and comes back on request', () => {
  const path = new Path();
  path.setRoute(demoRoute(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 200), 0);
  path.trustRoute = true;
  path.status.seenUntilS = path.length;
  const partner = new Partner(path);
  partner.pacing = 'free';
  partner.goalPace = 2;
  partner.reset(0);
  for (let t = 0; t < 10; t += DT) partner.update(DT, 0);
  assert.equal(partner.state, 'run');
  assert.ok(partner.s > 15, `ran on to ${partner.s.toFixed(1)} m`);
  partner.comeBackTo(2);
  assert.equal(partner.s, 2);
  partner.update(DT, 0);
  assert.equal(partner.state, 'run');
  assert.ok(partner.s > 2 && partner.s < 2.1);
});

test('coming back on an out-and-back picks up the turnaround still ahead of it', () => {
  const { partner, turnarounds } = hallwayRace(2);
  // Well into the race, then called back to just past the first turnaround.
  for (let t = 0; t < 12; t += DT) partner.update(DT, 0);
  partner.comeBackTo(turnarounds[0] + 1);
  partner.finishAt = Infinity;
  let turned = false;
  for (let t = 0; t < 20 && !turned; t += DT) {
    partner.update(DT, 0);
    if (partner.state === 'turn') turned = true;
  }
  assert.ok(turned);
  assert.ok(Math.abs(partner.s - turnarounds[1]) < 0.01, `turned at ${partner.s.toFixed(2)}, expected ${turnarounds[1].toFixed(2)}`);
});
