import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCourse, CourseRecording, courseRun, KEEP_RIGHT, polylineLength, type Course } from '../src/world/course';
import { Partner } from '../src/partner/partner';
import { Path, type RoutePoint } from '../src/world/path';

/** Deterministic noise in [-1, 1]. */
function noise(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
}

/** Walk through `corners` the way the recorder sees it: a sample every 25 cm, with phone sway. */
function walk(corners: RoutePoint[], sway = 0.04): RoutePoint[] {
  const rand = noise();
  const recording = new CourseRecording();
  for (let i = 1; i < corners.length; i++) {
    const a = corners[i - 1];
    const b = corners[i];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = 0; d < length; d += 0.05) {
      const t = d / length;
      recording.add(a.x + (b.x - a.x) * t + rand() * sway, a.z + (b.z - a.z) * t + rand() * sway);
    }
  }
  const last = corners.at(-1)!;
  recording.add(last.x + 0.3, last.z);
  return recording.points;
}

/** Shortest distance from a point to a polyline. */
function distanceTo(p: RoutePoint, line: RoutePoint[]) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t));
  }
  return best;
}

// A 3 m × 4 m walk round a table, stopping 0.6 m short of where it started.
const ROUND_TABLE = [
  { x: 0, z: 0 },
  { x: 1.5, z: 0 },
  { x: 1.5, z: -4 },
  { x: -1.5, z: -4 },
  { x: -1.5, z: 0 },
  { x: -0.6, z: 0 },
];
const TABLE_TRUTH = [...ROUND_TABLE.slice(0, 5), { x: 0, z: 0 }];

// Out along a corridor and round a corner: 9 m, ending well away from the start.
const CORRIDOR = [
  { x: 0, z: 0 },
  { x: 0, z: -6 },
  { x: 3, z: -6 },
];

test('recording samples every 25 cm of movement, ignoring sway in place', () => {
  const recording = new CourseRecording();
  const rand = noise(3);
  for (let i = 0; i < 200; i++) recording.add(rand() * 0.08, rand() * 0.08);
  assert.equal(recording.points.length, 1, 'standing still with the phone swaying records nothing');
  for (let z = 0; z >= -5; z -= 0.02) recording.add(0, z);
  assert.ok(Math.abs(recording.points.length - 21) <= 1, `about 20 samples over 5 m, got ${recording.points.length}`);
});

test('a walk that ends near its start is a loop, closed onto the start', () => {
  const course = buildCourse(walk(ROUND_TABLE))!;
  assert.equal(course.kind, 'loop');
  assert.deepEqual(course.points.at(-1), course.points[0]);
  // The real loop is 14 m. Walkers (and the 25 cm sampling) cut corners a little, and so does rounding.
  assert.ok(course.length > 12.9 && course.length < 14.1, `length ${course.length.toFixed(2)}`);
});

test('smoothing removes sway but keeps the corners', () => {
  const raw = walk(ROUND_TABLE, 0.06);
  const course = buildCourse(raw)!;
  assert.ok(course.points.length < raw.length, `simplified from ${raw.length} to ${course.points.length} points`);
  // Every point stays close to the true outline, except the start where the gap was closed.
  const worst = Math.max(...course.points.map(p => distanceTo(p, TABLE_TRUTH)));
  assert.ok(worst < 0.15, `strays ${worst.toFixed(2)} m from the walked outline`);
  // Each real corner is still there: cut no more than the walk itself cut it (sampling every
  // 25 cm rounds corners), plus the simplification tolerance.
  for (const corner of ROUND_TABLE.slice(1, 5)) {
    const near = distanceTo(corner, course.points);
    const walked = distanceTo(corner, raw);
    assert.ok(near < walked + 0.15, `corner ${corner.x},${corner.z} cut by ${near.toFixed(2)} m (walk cut it by ${walked.toFixed(2)})`);
  }
  // Along a straight side the heading barely wobbles.
  const side = course.points.filter(p => p.x > 1.3 && p.z < -0.6 && p.z > -3.4);
  for (const p of side) assert.ok(Math.abs(p.x - 1.5) < 0.08, `side wobbles to x = ${p.x.toFixed(2)}`);
});

test('a walk that ends away from its start is an out-and-back', () => {
  const course = buildCourse(walk(CORRIDOR))!;
  assert.equal(course.kind, 'line');
  assert.ok(Math.abs(course.length - 9.3) < 0.4, `length ${course.length.toFixed(2)}`);
});

test('walking out along a corridor and back to the start is an out-and-back, not a loop', () => {
  const there = [{ x: 0, z: 0 }, { x: 0, z: -6 }, { x: 0.3, z: -6 }, { x: 0.3, z: 0 }];
  const course = buildCourse(walk(there))!;
  assert.equal(course.kind, 'line');
  assert.ok(course.length > 5.5 && course.length < 6.8, `the way out only, got ${course.length.toFixed(2)} m`);
});

test('walking out along a corridor and only partway back is an out-and-back of the way out', () => {
  const partway = [{ x: 0, z: 0 }, { x: 0, z: -10 }, { x: 0.3, z: -10 }, { x: 0.3, z: -3 }];
  const course = buildCourse(walk(partway))!;
  assert.equal(course.kind, 'line');
  assert.ok(course.length > 9.4 && course.length < 10.8, `the way out only, got ${course.length.toFixed(2)} m`);
  // No hairpin left in it: every bend is gentle.
  for (let i = 1; i < course.points.length - 1; i++) {
    const [a, b, c] = [course.points[i - 1], course.points[i], course.points[i + 1]];
    const turn = Math.abs(Math.atan2((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x), (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z)));
    assert.ok(turn < Math.PI / 2, `bends ${((turn * 180) / Math.PI).toFixed(0)}° at ${b.x.toFixed(2)},${b.z.toFixed(2)}`);
  }
});

test('too short a walk is not a course', () => {
  assert.equal(buildCourse(walk([{ x: 0, z: 0 }, { x: 0, z: -3 }])), null);
});

test('an out-and-back run starts at the end of the recording, heading back along it', () => {
  const course = buildCourse(walk(CORRIDOR))!;
  const end = course.points.at(-1)!;
  const run = courseRun(course, end, 3);
  const first = run.points[0];
  assert.ok(Math.hypot(first.x - end.x, first.z - end.z) < KEEP_RIGHT + 0.01, 'starts where you stand');
  // Heading back: towards x = 0 along the second side of the corridor.
  const ahead = run.points[3];
  assert.ok(ahead.x < first.x - 0.3, `heads back along the course (x ${first.x.toFixed(2)} → ${ahead.x.toFixed(2)})`);
  // Turns at the far end (the recording's start), then back at this end, ... : 5 turns in 3 laps.
  assert.equal(run.turnarounds.length, 5);
  assert.ok(Math.abs(run.turnarounds[0] - course.length) < 0.5, `first turn at ${run.turnarounds[0].toFixed(2)} m`);
  assert.ok(Math.abs(run.lapLength - 2 * course.length) < 1, `lap ${run.lapLength.toFixed(2)} m`);
  // The two directions keep to their own right, so they never sit exactly on top of each other.
  const legs = new Path();
  legs.setRoute(run.points, 0);
  const out = legs.pointAt(2, new THREE.Vector3());
  let apart = Infinity;
  for (let s = run.turnarounds[0]; s < run.turnarounds[1]; s += 0.05) {
    const back = legs.pointAt(s, new THREE.Vector3());
    apart = Math.min(apart, Math.hypot(out.x - back.x, out.z - back.z));
  }
  assert.ok(Math.abs(apart - 2 * KEEP_RIGHT) < 0.05, `legs ${apart.toFixed(2)} m apart`);
});

test('a loop run starts at the point of the loop nearest you, going the walked way', () => {
  const course = buildCourse(walk(ROUND_TABLE))!;
  const run = courseRun(course, { x: 1.6, z: -2 }, 2);
  assert.ok(Math.hypot(run.points[0].x - 1.5, run.points[0].z + 2) < 0.2, 'starts on the near side');
  assert.ok(run.points[4].z < run.points[0].z, 'and carries on the way it was walked (towards -z)');
  assert.ok(Math.abs(polylineLength(run.points) - 2 * course.length) < 0.6);
  assert.deepEqual(run.turnarounds, []);
});

// ---------------------------------------------------------------- turnarounds

function straightOutAndBack(): { path: Path; turn: number } {
  const course: Course = { kind: 'line', points: [{ x: 0, z: 0 }, { x: 0, z: -10 }], length: 10 };
  const run = courseRun(course, { x: 0, z: 0 }, 2);
  const path = new Path();
  path.setRoute(run.points, 0);
  // Ground is known everywhere, so only the turnaround limits the buddy.
  path.status.seenUntilS = path.length;
  return { path, turn: run.turnarounds[0] };
}

test('the buddy brakes into a turnaround, turns on the spot, then picks up again', () => {
  const { path, turn } = straightOutAndBack();
  const partner = new Partner(path);
  partner.goalPace = 2.5;
  partner.turnarounds = [turn];
  partner.reset(0);
  const dt = 1 / 60;
  const speedAt = new Map<string, number>();
  let paused = 0;
  let runnerS = 0;
  let t = 0;
  for (; t < 20 && partner.s < turn + 4; t += dt) {
    partner.update(dt, runnerS);
    // A runner at 2.3 m/s, who can't overtake the buddy.
    runnerS = Math.max(runnerS, Math.min(runnerS + 2.3 * dt, partner.s - 0.5));
    path.status.seenUntilS = path.length;
    const d = turn - partner.s;
    if (partner.state === 'turn') paused += dt;
    for (const mark of [3, 1, 0.3]) if (d <= mark && !speedAt.has(`before ${mark}`)) speedAt.set(`before ${mark}`, partner.currentSpeed);
    if (d <= -2.5 && !speedAt.has('after 2.5')) speedAt.set('after 2.5', partner.currentSpeed);
  }
  assert.ok(speedAt.get('before 3')! > 2.3, `full pace 3 m out, got ${speedAt.get('before 3')!.toFixed(2)}`);
  assert.ok(speedAt.get('before 1')! < 1.9, `slowing 1 m out, got ${speedAt.get('before 1')!.toFixed(2)}`);
  assert.ok(speedAt.get('before 0.3')! < 1.1, `nearly stopped 0.3 m out, got ${speedAt.get('before 0.3')!.toFixed(2)}`);
  assert.ok(paused >= 0.3 && paused <= 0.6, `turns on the spot for ${paused.toFixed(2)} s`);
  assert.ok(speedAt.get('after 2.5')! > 1.8, `back up to pace after, got ${speedAt.get('after 2.5')!.toFixed(2)}`);
});

test('at a turnaround the buddy waits for a slower runner instead of running back past them', () => {
  const { path, turn } = straightOutAndBack();
  const partner = new Partner(path);
  partner.goalPace = 2.5;
  partner.turnarounds = [turn];
  partner.reset(0);
  const dt = 1 / 60;
  let runnerS = 0;
  let waited = 0;
  let leftWith: number | null = null;
  for (let t = 0; t < 30 && leftWith === null; t += dt) {
    const was = partner.state;
    partner.update(dt, runnerS);
    path.status.seenUntilS = path.length;
    if (partner.state === 'turn') waited += dt;
    if (was === 'turn' && partner.state !== 'turn') leftWith = runnerS;
    runnerS += 0.9 * dt;
  }
  assert.ok(leftWith !== null, 'it set off again');
  assert.ok(leftWith >= turn - 1.5, `set off with the runner ${(turn - leftWith).toFixed(2)} m short of the turn`);
  assert.ok(waited > 1, `waited ${waited.toFixed(2)} s for them`);
});

test('the buddy never overshoots a turnaround, even at a sprint', () => {
  const { path, turn } = straightOutAndBack();
  const partner = new Partner(path);
  partner.goalPace = 4;
  partner.turnarounds = [turn];
  partner.reset(turn - 2.5);
  let turned = false;
  let furthest = 0;
  for (let t = 0; t < 3; t += 1 / 30) {
    partner.update(1 / 30, partner.s - 2);
    if (partner.state === 'turn') turned = true;
    if (!turned) furthest = Math.max(furthest, partner.s);
  }
  assert.ok(turned, 'it turned');
  assert.ok(furthest <= turn + 1e-6, `ran to ${furthest.toFixed(3)} before turning at ${turn.toFixed(3)}`);
});

// ---------------------------------------------------------------- projection

test('progress carries on round an out-and-back turnaround', () => {
  const { path, turn } = straightOutAndBack();
  const at = new THREE.Vector3();
  const rand = noise(11);
  // Walk out, wobbling 25 cm either side; turn a little short of the end; walk back.
  let s = 0;
  const steps: number[] = [];
  for (let z = 0; z >= -9.6; z -= 0.1) steps.push(path.project(at.set(rand() * 0.25, 1.5, z)));
  for (let z = -9.6; z <= -2; z += 0.1) {
    s = path.project(at.set(rand() * 0.25, 1.5, z));
    steps.push(s);
  }
  assert.ok(s > turn + 5, `should be well into the way back (> ${(turn + 5).toFixed(1)}), got ${s.toFixed(1)}`);
  // It never jumps a whole leg at once.
  for (let i = 1; i < steps.length; i++) assert.ok(Math.abs(steps[i] - steps[i - 1]) < 2.5, `jumped ${steps[i - 1]} → ${steps[i]}`);
});
