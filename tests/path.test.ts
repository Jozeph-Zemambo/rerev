import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Path } from '../src/world/path';
import { SurfaceMap } from '../src/world/surfaceMap';

type Box = { x0: number; x1: number; z0: number; z1: number; top: number | ((z: number) => number) };

/**
 * A hallway along -z from the origin, its floor known, with boxes in it confirmed as obstacles
 * the way the map confirms them: depth points on them, seen up close over several frames.
 */
function hallway(boxes: Box[]) {
  const map = new SurfaceMap();
  map.seedGround(0, 0, -4, 6);
  for (let frame = 0; frame < 6; frame++) {
    for (const box of boxes) {
      for (let x = box.x0 + 0.05; x < box.x1; x += 0.1) {
        for (let z = box.z0 + 0.05; z < box.z1; z += 0.1) {
          const top = typeof box.top === 'number' ? box.top : box.top(z);
          map.addDepthPoint(x, top, z, frame * 0.1, 1);
        }
      }
    }
  }
  const path = new Path();
  path.setRoute([{ x: 0, z: 0 }, { x: 0, z: -20 }], 0);
  // A second apart, so the line settles where it's planned to be.
  for (let k = 0; k < 3; k++) path.update(1, k, 0, map, 0.6, true);
  return path;
}

/** Closest the drawn line comes (between `from` and `to` along it) to a box's edge. */
function clearance(path: Path, box: Box, from: number, to: number) {
  let best = Infinity;
  const p = new THREE.Vector3();
  for (let s = from; s <= to; s += 0.05) {
    path.pointAt(s, p);
    const dx = Math.max(0, box.x0 - p.x, p.x - box.x1);
    const dz = Math.max(0, box.z0 - p.z, p.z - box.z1);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

// A 2.6 m hallway: walls 1.3 m either side of the line.
const LEFT_WALL: Box = { x0: -1.5, x1: -1.3, z0: -8, z1: 0, top: 1 };
const RIGHT_WALL: Box = { x0: 1.3, x1: 1.5, z0: -8, z1: 0, top: 1 };

test('the line takes the buddy round a bin by the wall, on the roomier side, body clear', () => {
  // A 50 cm bin against the right wall, reaching 0.2 m past the line.
  const bin: Box = { x0: -0.2, x1: 0.3, z0: -4.5, z1: -4, top: 0.9 };
  const path = hallway([LEFT_WALL, RIGHT_WALL, { ...bin, x1: 1.3 }]);
  assert.equal(path.status.blockedAtS, null);
  assert.ok(path.status.detouring);
  // Body (25 cm half-width) plus a margin clear of the bin, and of the wall it goes past.
  assert.ok(clearance(path, bin, 0.5, 8) >= 0.35, `came within ${clearance(path, bin, 0.5, 8).toFixed(2)} m of the bin`);
  assert.ok(clearance(path, LEFT_WALL, 0.5, 8) >= 0.25, `came within ${clearance(path, LEFT_WALL, 0.5, 8).toFixed(2)} m of the wall`);
  assert.ok(path.pointAt(4.25, new THREE.Vector3()).x < -0.5, 'it goes left, where the room is');
});

test('with no way past, the line stops short of the gap instead of squeezing through', () => {
  // Bins on both sides leave a 40 cm gap: narrower than the buddy.
  const left: Box = { x0: -1.3, x1: -0.2, z0: -4.5, z1: -4, top: 0.9 };
  const right: Box = { x0: 0.2, x1: 1.3, z0: -4.5, z1: -4, top: 0.9 };
  const path = hallway([LEFT_WALL, RIGHT_WALL, left, right]);
  assert.ok(path.status.blockedAtS !== null && path.status.blockedAtS < 4, `blocked at ${path.status.blockedAtS}`);
  assert.equal(path.status.blockReason, 'obstacle');
});

test('rising tops on something narrow are not stairs; across the way they are', () => {
  // Tops rising 17 cm every 30 cm from 4 m ahead, up to a 68 cm landing.
  const rise = (z: number) => 0.17 * Math.min(4, Math.max(1, Math.ceil((-4 - z) / 0.3 + 1e-6)));
  const chair = hallway([{ x0: -0.2, x1: 0.2, z0: -5.2, z1: -4, top: rise }]);
  assert.equal(chair.stairs.length, 0, 'a 40 cm wide thing is no staircase');
  const stairs = hallway([{ x0: -1, x1: 1, z0: -5.2, z1: -4, top: rise }]);
  assert.equal(stairs.stairs.length, 1, 'a 2 m wide one is');
});
