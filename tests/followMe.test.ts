import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Partner } from '../src/partner/partner';
import { bendToward, FollowMe, TravelHeading } from '../src/world/followMe';
import { demoRoute, Path, resample, type RoutePoint } from '../src/world/path';
import { SurfaceMap } from '../src/world/surfaceMap';

const deg = (rad: number) => (rad * 180) / Math.PI;
const angleBetween = (a: { x: number; z: number }, b: { x: number; z: number }) => deg(Math.acos(Math.min(1, a.x * b.x + a.z * b.z)));

/** Repeatable noise. */
function noise(seed = 7) {
  let state = seed;
  return () => ((state = (state * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
}

test('direction of travel is smoothed over a few metres, so swaying while walking does not swing it', () => {
  const travel = new TravelHeading();
  const wobble = noise();
  // Walking along +x at 1.4 m/s, 30 fps, swaying 5 cm side to side each step plus tracking jitter.
  let worst = 0;
  for (let i = 0; i <= 300; i++) {
    const t = i / 30;
    const x = 1.4 * t;
    const z = Math.sin(t * 2 * Math.PI * 0.9) * 0.05 + wobble() * 0.01;
    travel.update(x, z);
    if (x > 3) worst = Math.max(worst, angleBetween(travel.heading!, { x: 1, z: 0 }));
  }
  assert.ok(worst < 3, `heading swung up to ${worst.toFixed(1)}°`);
  assert.ok(Math.abs(travel.odometer - 14) < 0.7, `odometer ${travel.odometer.toFixed(2)} m for 14 m walked`);
});

test('no direction until the runner has actually gone somewhere', () => {
  const travel = new TravelHeading();
  for (let i = 0; i < 20; i++) travel.update(i * 0.05, 0);
  assert.equal(travel.heading, null);
});

test('standing still or turning on the spot keeps the direction, and adds no distance', () => {
  const travel = new TravelHeading();
  for (let i = 0; i <= 60; i++) travel.update(i * 0.05, 0);
  const before = { ...travel.heading! };
  const odometer = travel.odometer;
  const jitter = noise(3);
  // Ten seconds on the spot, the phone swinging round (a few cm of position wobble).
  for (let i = 0; i < 300; i++) travel.update(3 + jitter() * 0.04, jitter() * 0.04);
  assert.ok(angleBetween(travel.heading!, before) < 1, 'heading moved while standing still');
  assert.ok(travel.odometer - odometer < 0.3, `standing still added ${(travel.odometer - odometer).toFixed(2)} m`);
});

test('a corner turns the direction within a couple of metres', () => {
  const travel = new TravelHeading();
  for (let i = 0; i <= 100; i++) travel.update(i * 0.05, 0);
  for (let i = 1; i <= 50; i++) travel.update(5, i * 0.05);
  assert.ok(angleBetween(travel.heading!, { x: 0, z: 1 }) < 5, `after 2.5 m round the corner, still ${angleBetween(travel.heading!, { x: 0, z: 1 }).toFixed(0)}° off`);
});

test('a re-laid stretch leaves the anchor along its tangent and joins the runner line without kinks', () => {
  const anchor = { x: 0, z: 0 };
  const points = bendToward(anchor, { x: 0, z: -1 }, { x: 1.5, z: 1 }, { x: 0, z: -1 }, 3, 10);
  const all = [anchor, ...points];
  // Joins the runner's line (x = 1.5) and stays on it.
  assert.ok(Math.abs(points.at(-1)!.x - 1.5) < 1e-6);
  for (const p of points.filter(p => p.z < -3.01)) assert.ok(Math.abs(p.x - 1.5) < 1e-6, 'left the runner line after the join');
  // First step heads along the anchor's tangent; no sharp turn anywhere along it.
  const even = resample(all, 0.1);
  for (let i = 2; i < even.length; i++) {
    const a = { x: even[i - 1].x - even[i - 2].x, z: even[i - 1].z - even[i - 2].z };
    const b = { x: even[i].x - even[i - 1].x, z: even[i].z - even[i - 1].z };
    const turn = deg(Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z)));
    assert.ok(turn < 12, `turns ${turn.toFixed(1)}° in 10 cm at ${i}`);
  }
});

// ---------------------------------------------------------------- the whole loop

type Walk = { points: RoutePoint[]; pace?: number; stops?: { at: number; seconds: number; spin?: boolean }[] };

/**
 * A runner walks `walk` (with sway) while the app's own Path, Partner and FollowMe run as in
 * main.ts. The ground everywhere is known, so the buddy is never held back for unseen ground.
 */
function simulate(walk: Walk, startDirection: THREE.Vector3) {
  let clock = 0;
  const realNow = performance.now;
  performance.now = () => clock * 1000;
  try {
    const map = new SurfaceMap();
    const path = new Path();
    const partner = new Partner(path);
    const follow = new FollowMe();
    const track = resample(walk.points, 0.05);
    for (const p of resample(walk.points, 0.5)) map.seedGround(p.x, 0, p.z, 4);
    path.setRoute(demoRoute(new THREE.Vector3(track[0].x, 0, track[0].z), startDirection, 25), 0);
    partner.reset(0);
    follow.reset();
    const dt = 1 / 30;
    const pace = walk.pace ?? 1.4;
    const runner = new THREE.Vector3();
    const wobble = noise(11);
    const samples: { t: number; runner: RoutePoint; runnerS: number; buddyS: number; along: number }[] = [];
    const kept: string[] = [];
    let along = 0;
    let stopIndex = 0;
    let stopLeft = 0;
    let frame = 0;
    while (along < (track.length - 1) * 0.05) {
      clock += dt;
      frame++;
      const stop = walk.stops?.[stopIndex];
      if (stop && along >= stop.at && stopLeft === 0) stopLeft = stop.seconds;
      if (stopLeft > 0) {
        stopLeft = Math.max(0, stopLeft - dt);
        if (stopLeft === 0) stopIndex++;
      } else along += pace * dt;
      const p = track[Math.min(track.length - 1, Math.round(along / 0.05))];
      runner.set(p.x + Math.sin(clock * 5.6) * 0.04 + wobble() * 0.01, 1.4, p.z + Math.cos(clock * 5.6) * 0.02 + wobble() * 0.01);
      const runnerS = path.project(runner);
      // Everything behind both the runner and the buddy must never move.
      const behind = Math.min(runnerS, partner.s) - 0.1;
      const before: RoutePoint[] = [];
      for (let s = 0; s <= behind; s += 0.5) before.push({ ...path.centreAt(s, { x: 0, z: 0 }) });
      follow.update(clock, runner, runnerS, path, partner);
      before.forEach((b, k) => {
        const now = path.centreAt(k * 0.5, { x: 0, z: 0 });
        if (Math.hypot(now.x - b.x, now.z - b.z) > 1e-4) kept.push(`s ${k * 0.5} moved at ${clock.toFixed(1)} s`);
      });
      path.update(dt, clock, runnerS, map, clock, frame % 3 === 0);
      partner.update(dt, runnerS);
      samples.push({ t: clock, runner: { x: runner.x, z: runner.z }, runnerS, buddyS: partner.s, along });
    }
    return { path, partner, follow, track, samples, kept };
  } finally {
    performance.now = realNow;
  }
}

/** Distance from a point to the walked track (the runner's actual line). */
function offTrack(track: RoutePoint[], p: { x: number; z: number }, fromAlong = 0) {
  let best = Infinity;
  for (let i = Math.round(fromAlong / 0.05); i < track.length; i++) best = Math.min(best, Math.hypot(track[i].x - p.x, track[i].z - p.z));
  return best;
}

test('down a hallway a few degrees off where the camera faced, the path stays on the runner line', () => {
  // Started facing straight ahead (-z); actually walking 8° to the right of that for 30 m.
  const a = (8 * Math.PI) / 180;
  const walk = { points: [{ x: 0, z: 0 }, { x: Math.sin(a) * 30, z: -Math.cos(a) * 30 }] };
  const { path, samples, kept, track } = simulate(walk, new THREE.Vector3(0, 0, -1));
  let worst = 0;
  const p = new THREE.Vector3();
  for (const s of samples.filter(s => s.along > 5 && s.along < 22)) {
    // Ahead of the buddy, out to 6 m in front of the runner.
    for (let d = 2; d <= 6; d += 1) worst = Math.max(worst, offTrack(track, path.centreAt(s.runnerS + d, p), s.along));
  }
  assert.ok(worst < 0.5, `path ahead strayed ${worst.toFixed(2)} m from the hallway line`);
  assert.deepEqual(kept, []);
});

test('turning a corner bends the path onto the new street and the buddy stays ahead', () => {
  const walk = { points: [{ x: 0, z: 0 }, { x: 0, z: -10 }, { x: 15, z: -10 }] };
  const { path, partner, samples, track, kept, follow } = simulate(walk, new THREE.Vector3(0, 0, -1));
  const p = new THREE.Vector3();
  // Two seconds after the corner (about 3 m on), the path a few metres ahead is on the new street.
  const after = samples.filter(s => s.along > 13);
  for (const s of after) {
    // (Short of the end of the walk: past it, there's no street to compare with.)
    for (let d = 2; d <= 5 && s.along + d < 24.5; d++) {
      const off = offTrack(track, path.centreAt(s.runnerS + d, p), 10);
      assert.ok(off < 0.5, `${off.toFixed(2)} m off the new street at +${d} m, t ${s.t.toFixed(1)}`);
    }
  }
  const last = samples.at(-1)!;
  // The buddy is ahead of the runner along the new street.
  path.centreAt(partner.s, p);
  assert.ok(p.x - last.runner.x > 0.8, `buddy only ${(p.x - last.runner.x).toFixed(2)} m ahead`);
  assert.deepEqual(kept, []);
  assert.ok(follow.bends + follow.respawns >= 1);
});

test('standing still and spinning round does not swing the path', () => {
  const walk = { points: [{ x: 0, z: 0 }, { x: 0, z: -12 }], stops: [{ at: 5, seconds: 12 }] };
  const { follow, samples } = simulate(walk, new THREE.Vector3(0, 0, -1));
  // Nothing needed re-laying on a straight walk, stop included.
  assert.equal(follow.bends + follow.respawns, 0, `${follow.bends} bends, ${follow.respawns} respawns`);
  assert.ok(samples.length > 0);
});

test('walking back past the buddy brings it round ahead on the new way, not back along the old line', () => {
  const walk = { points: [{ x: 0, z: 0 }, { x: 0, z: -8 }, { x: 0.6, z: -8.3 }, { x: 0.9, z: -4 }, { x: 1, z: 6 }] };
  const { path, partner, samples, follow, kept } = simulate(walk, new THREE.Vector3(0, 0, -1));
  assert.ok(follow.respawns >= 1, 'buddy never caught up ahead');
  const last = samples.at(-1)!;
  const p = path.centreAt(partner.s, { x: 0, z: 0 });
  // Heading +z now: the buddy is ahead (larger z) of the runner, near their line.
  assert.ok(p.z - last.runner.z > 0.8, `buddy ${(p.z - last.runner.z).toFixed(2)} m ahead along the way back`);
  assert.ok(Math.abs(p.x - last.runner.x) < 0.6);
  assert.deepEqual(kept, []);
});

test('crossing the street sideways: the path shifts over to the far side', () => {
  const walk = { points: [{ x: 0, z: 0 }, { x: 0, z: -8 }, { x: 4, z: -13 }, { x: 4, z: -30 }] };
  const { path, samples, track } = simulate(walk, new THREE.Vector3(0, 0, -1));
  const p = new THREE.Vector3();
  for (const s of samples.filter(s => s.along > 18 && s.along < 26)) {
    for (let d = 2; d <= 5; d++) assert.ok(offTrack(track, path.centreAt(s.runnerS + d, p), 8) < 0.5, `+${d} m off at t ${s.t.toFixed(1)}`);
  }
});
