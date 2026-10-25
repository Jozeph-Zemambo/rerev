import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { COLS, ROWS, TOP } from '../src/ar/depthSensor';
import { agreement, decodeDepth, encodeDepth, fetchAllRows, median, replaySession, type Row } from '../src/debug/replay';

/**
 * A synthetic field recording in the exact logged format: a phone 1.4 m above a flat floor at
 * y = 0, pitched 30° down, looking along -z at a box 30 cm tall whose front face is 2.8 m ahead
 * and which spans the whole corridor (so there is no way round it). Each depth reading is made by
 * casting the grid cell's ray through the same projection and pose and measuring how far along
 * the view's forward axis it hits, which is what the phone's depth API reports. The phone edges
 * forward slowly, so the box is 2.5-2.8 m away.
 */
const BOX = { x0: -2, x1: 2, y0: 0, y1: 0.3, z0: -3.2, z1: -2.8 };
const EYE = 1.4;

function syntheticCamera(z = 0) {
  const camera = new THREE.PerspectiveCamera(60, 0.75, 0.1, 100);
  camera.position.set(0, EYE, z);
  camera.rotation.set(-Math.PI / 6, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

/** Nearest hit of a world ray on the floor or the box (distance along the ray), or null. */
function cast(origin: THREE.Vector3, dir: THREE.Vector3, withBox = true): number | null {
  let best = dir.y < 0 ? -origin.y / dir.y : Infinity;
  if (withBox) {
    let near = -Infinity;
    let far = Infinity;
    for (const [o, d, lo, hi] of [
      [origin.x, dir.x, BOX.x0, BOX.x1],
      [origin.y, dir.y, BOX.y0, BOX.y1],
      [origin.z, dir.z, BOX.z0, BOX.z1],
    ]) {
      if (Math.abs(d) < 1e-12) {
        if (o < lo || o > hi) near = Infinity;
        continue;
      }
      const a = (lo - o) / d;
      const b = (hi - o) / d;
      near = Math.max(near, Math.min(a, b));
      far = Math.min(far, Math.max(a, b));
    }
    if (near <= far && near > 0) best = Math.min(best, near);
  }
  return Number.isFinite(best) ? best : null;
}

function depthGrid(camera: THREE.PerspectiveCamera): Uint16Array {
  const grid = new Uint16Array(COLS * ROWS);
  const inverse = camera.projectionMatrix.clone().invert();
  for (let row = 0; row < ROWS; row++) {
    const v = TOP + ((1 - TOP) * (row + 0.5)) / ROWS;
    for (let col = 0; col < COLS; col++) {
      const u = (col + 0.5) / COLS;
      const view = new THREE.Vector3(u * 2 - 1, 1 - v * 2, -1).applyMatrix4(inverse);
      const origin = camera.position.clone();
      const dir = view.clone().transformDirection(camera.matrixWorld);
      const along = cast(origin, dir);
      if (along === null) continue;
      // Forward distance: the hit's depth along the view's -z axis.
      const d = (along * -view.z) / view.length();
      if (d >= 0.25 && d <= 5) grid[row * COLS + col] = Math.round(d * 1000);
    }
  }
  return grid;
}

/** Floor hits from GroundRays' downward rays (the camera faces -z) that land on bare floor. */
function floorHits(camera: THREE.PerspectiveCamera): number[][] {
  const hits: number[][] = [];
  for (const [pitch, yaw] of [[20, 0], [30, 0], [45, 0], [30, -20], [30, 20]]) {
    const p = (pitch * Math.PI) / 180;
    const y = (yaw * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(y) * Math.cos(p), -Math.sin(p), -Math.cos(y) * Math.cos(p));
    const along = cast(camera.position, dir);
    const floor = cast(camera.position, dir, false);
    if (along === null || floor === null || along < floor - 1e-6) continue; // hit the box
    const hit = camera.position.clone().addScaledVector(dir, along);
    hits.push([hit.x, hit.y, hit.z].map(n => +n.toFixed(4)));
  }
  return hits;
}

function syntheticSession(): Row[] {
  const rows: Row[] = [];
  const points: [number, number][] = [];
  for (let s = 0; s <= 20; s += 0.25) points.push([0, -s]);
  rows.push({
    t: 1,
    kind: 'run start',
    data: {
      mode: 'quick',
      floorY: 0,
      phone: [0, EYE, 0],
      phoneAboveFloor: EYE,
      rebased: 0,
      walkableStep: 0,
      pathLength: points.length,
      points,
      seeds: [[0, 0], [0, 0]],
      laps: 0,
      turnarounds: [],
    },
  });
  let projectionSent = false;
  for (let t = 1.2; t <= 4.01; t += 0.2) {
    // Edging towards the box at 10 cm/s, so every frame's pose and grid differ.
    const camera = syntheticCamera(-(t - 1.2) * 0.1);
    const projection = Array.from(camera.projectionMatrix.elements).map(n => +n.toFixed(6));
    rows.push({
      t: +t.toFixed(2),
      kind: 'frame',
      data: {
        pose: Array.from(camera.matrixWorld.elements).map(n => +n.toFixed(5)),
        ...(projectionSent ? {} : { projection }),
        depth: encodeDepth(depthGrid(camera)),
        hits: [...floorHits(camera), ...floorHits(camera)],
      },
    });
    projectionSent = true;
    if (Math.round(t * 10) % 5 === 0) {
      rows.push({
        t: +(t + 0.01).toFixed(2),
        kind: 'tick',
        data: { state: 'blocked', runnerS: 0, buddyS: 1.5, path: { blockedAtS: 2.6, reason: 'obstacle' }, hazardCounts: { obstacle: 30, drop: 0 } },
      });
    }
  }
  rows.push({ t: 3, kind: 'mark', data: { n: 1, state: 'blocked', buddyS: 1.5, blockedAtS: 2.6, reason: 'obstacle' } });
  rows.push({ t: 4.2, kind: 'run end', data: { distance: 0 } });
  return rows;
}

test('depth grids decode as little-endian millimetres', () => {
  // 0x1234 = 4660 mm, then 1 mm, then 0 (no reading): bytes low first.
  const base64 = btoa(String.fromCharCode(0x34, 0x12, 0x01, 0x00, 0x00, 0x00));
  assert.deepEqual(Array.from(decodeDepth(base64)), [4660, 1, 0]);
  // What FieldLog uploads (the Uint16Array's own bytes, on a little-endian phone) decodes back.
  const grid = new Uint16Array([250, 1234, 5000, 0, 65535]);
  const bytes = new Uint8Array(grid.buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  assert.deepEqual(Array.from(decodeDepth(btoa(binary))), Array.from(grid));
  assert.equal(encodeDepth(grid), btoa(binary));
});

test('replay reconstructs floor and box heights from the recorded grid', () => {
  const rows = syntheticSession();
  const [run] = replaySession(rows, { keepCloud: () => true });
  assert.equal(run.kind, 'run');
  assert.ok(run.replayable);
  assert.equal(run.frames.length, 15);
  const cloud = run.frames.at(-1)!.cloud!;
  assert.ok(cloud.length > 500, `${cloud.length} points`);
  const floor = cloud.filter(p => p.z > BOX.z1 + 0.05 || p.z < BOX.z0 - 0.05).filter(p => p.verdict !== 'no ground');
  const top = cloud.filter(p => p.y > BOX.y1 - 0.01);
  // The points really are where the geometry says (the unprojection matches the generator).
  assert.ok(floor.every(p => Math.abs(p.y) < 0.01), 'floor points at y = 0');
  assert.ok(top.length > 20 && top.every(p => Math.abs(p.y - BOX.y1) < 0.01), 'box top at 30 cm');
  // And the map judges them against its ground: floor about 0 cm, the box about its height.
  assert.ok(Math.abs(median(floor.map(p => p.height))!) < 0.01);
  assert.ok(floor.filter(p => p.verdict === 'ground').length > 0.95 * floor.length);
  assert.ok(Math.abs(median(top.map(p => p.height))! - 0.3) < 0.02);
  assert.ok(top.every(p => p.verdict === 'obstacle'));
});

test('replay flags the box and blocks the path in front of it', () => {
  const [run] = replaySession(syntheticSession());
  const blocked = run.events.find(e => e.kind === 'blocked');
  assert.ok(blocked, run.events.map(e => e.text).join('\n'));
  assert.equal(blocked.data?.reason, 'obstacle');
  const s = blocked.data?.blockedAtS as number;
  // The face is at s 2.8; the corridor check reaches up to two 20 cm cells ahead of a sample.
  assert.ok(s >= 2.1 && s < 2.8, `blocked at ${s}`);
  assert.equal(run.frames.at(-1)!.state, 'blocked');
  assert.ok(run.events.some(e => e.kind === 'mark'));
  assert.ok(run.frames.every(f => !f.repeated && !f.stale && f.points > 500));
  const agree = agreement(run.ticks);
  assert.equal(agree.ticks, run.ticks.length);
  assert.equal(agree.state, 1);
});

test('overriding a threshold changes the verdict', () => {
  const [run] = replaySession(syntheticSession(), { tuning: { obstacleMin: 0.5 } });
  assert.ok(!run.events.some(e => e.kind === 'blocked'));
  assert.equal(run.frames.reduce((n, f) => n + f.bands.reduce((m, b) => m + b.obstacle, 0), 0), 0);
});

test('sessions without frames or route are reported, not replayed', () => {
  const rows: Row[] = [
    { t: 1, kind: 'run start', data: { mode: 'quick', floorY: -1.3, phone: [0, 0, 0], walkableStep: 0 } },
    { t: 1.5, kind: 'tick', data: { state: 'look' } },
    { t: 2, kind: 'tick', data: { state: 'run' } },
  ];
  const [run] = replaySession(rows);
  assert.equal(run.replayable, false);
  assert.equal(run.recordedTicks.length, 2);
  assert.equal(run.frames.length, 0);
});

test('paging refetches rows that share the last timestamp of a full page', () => {
  const all: Row[] = [1, 2, 3, 3, 3, 4, 5].map((t, i) => ({ t, kind: 'tick', data: { i } }));
  const page = (after: number | undefined, limit: number) => all.filter(r => r.t > (after ?? -1)).slice(0, limit);
  assert.deepEqual(fetchAllRows(page, 4).map(r => r.data.i), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(fetchAllRows(page, 5).map(r => r.data.i), [0, 1, 2, 3, 4, 5, 6]);
  // A whole page at one timestamp can't be paged past with `after`; say so rather than loop.
  assert.throws(() => fetchAllRows(page, 3), /More than 3 rows/);
});

test('a frame logged again unchanged is skipped; an unchanged grid on a moving phone is stale', () => {
  const rows = syntheticSession().filter(r => r.kind !== 'tick' && r.kind !== 'mark');
  const [first, second] = rows.filter(r => r.kind === 'frame');
  // The phone gave no depth: the app logged the 1.2 s frame again.
  const repeat: Row = { t: 1.3, kind: 'frame', data: { ...first.data, projection: undefined, hits: [] } };
  // The 1.4 s grid again, though the phone moved 5 cm.
  const pose = second.data.pose.map((n: number, i: number) => (i === 14 ? n - 0.05 : n));
  const stale: Row = { t: 1.5, kind: 'frame', data: { ...second.data, pose, hits: [] } };
  const [run] = replaySession([...rows, repeat, stale]);
  const at = (t: number) => run.frames.find(f => f.t === t)!;
  assert.ok(at(1.3).repeated && at(1.3).points === 0);
  assert.ok(!at(1.4).repeated && !at(1.4).stale);
  assert.ok(at(1.5).stale && at(1.5).points > 0);
});
