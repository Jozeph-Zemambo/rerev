import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { apply, GeoAligner } from '../src/geo/alignment';
import { Path } from '../src/world/path';

const truth = { theta: 0.6, tx: 3, tz: -2 };

test('GPS fixes along an L-shaped track recover the true transform', () => {
  const aligner = new GeoAligner();
  // Start 15 degrees off with a 4 m shift, like a poor compass and first fix.
  aligner.initialise({ e: 0, n: 0 }, { x: 7, z: -2 }, 0, 0);
  aligner.transform = { theta: truth.theta + 0.26, tx: 7, tz: -2 };
  const track = [...Array(30).keys()].map(i => (i < 15 ? { e: 0, n: i * 3 } : { e: (i - 15) * 3, n: 42 }));
  for (let round = 0; round < 15; round++) {
    track.forEach((p, i) => aligner.addFix(p, apply(truth, p), 5, round * 30 + i));
    aligner.refit();
  }
  const t = aligner.transform!;
  assert.ok(Math.abs(t.theta - truth.theta) < 0.01, `theta ${t.theta}`);
  assert.ok(Math.hypot(t.tx - truth.tx, t.tz - truth.tz) < 0.3, `shift ${t.tx}, ${t.tz}`);
});

test('route matches fix the heading', () => {
  const aligner = new GeoAligner();
  aligner.initialise({ e: 0, n: 0 }, { x: 0, z: 0 }, 0, 0);
  aligner.transform = { theta: 0.2, tx: 0, tz: 0 }; // 11 degrees off, starting at the right spot
  // The runner goes straight north 30 m (AR: -z); each match says "on the route at n = d".
  for (let i = 1; i <= 12; i++) aligner.addRouteMatch({ e: 0, n: i * 2.5 }, { e: 0, n: 1 }, { x: 0, z: -i * 2.5 }, 3, i);
  for (let i = 0; i < 20; i++) aligner.refit();
  assert.ok(Math.abs(aligner.transform!.theta) < 0.02, `heading should settle near 0, got ${aligner.transform!.theta}`);
});

test('route matches never move the route along itself', () => {
  const aligner = new GeoAligner();
  aligner.initialise({ e: 0, n: 0 }, { x: 0, z: 0 }, 0, 0);
  // Matches that disagree only along the route (as a wrong progress estimate would): they
  // must not drag the route forwards or backwards. That is GPS's job.
  for (let i = 1; i <= 12; i++) aligner.addRouteMatch({ e: 0, n: i * 2.5 + 5 }, { e: 0, n: 1 }, { x: 0, z: -i * 2.5 }, 3, i);
  for (let i = 0; i < 20; i++) aligner.refit();
  const start = apply(aligner.transform!, { e: 0, n: 0 });
  assert.ok(Math.hypot(start.x, start.z) < 0.3, `start moved to ${start.x.toFixed(2)}, ${start.z.toFixed(2)}`);
});

test('progress follows direction of travel on an out-and-back street', () => {
  // Out 20 m north, back south 3 m to the side.
  const points = [{ x: 0, z: 0 }, { x: 0, z: -20 }, { x: 3, z: -20 }, { x: 3, z: 0 }];
  const path = new Path();
  path.setRoute(points, 0);
  const at = new THREE.Vector3();
  // Walk out, round the end, and back with a 1.6 m sideways error (closer to the outbound leg).
  for (let z = 0; z >= -20; z -= 0.5) path.project(at.set(0, 1.5, z));
  for (let x = 0; x <= 3; x += 0.5) path.project(at.set(x, 1.5, -20));
  let s = 0;
  for (let z = -20; z <= -6; z += 0.5) s = path.project(at.set(1.4, 1.5, z));
  assert.ok(s > 30, `should be on the way back (s > 30), got ${s.toFixed(1)}`);
});
