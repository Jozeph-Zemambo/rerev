import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Coach } from '../src/partner/coach';
import { Partner } from '../src/partner/partner';
import { demoRoute, Path } from '../src/world/path';

function setup() {
  const path = new Path();
  path.setRoute(demoRoute(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 200), 0);
  const partner = new Partner(path);
  const coach = new Coach();
  coach.zone = { low: 120, high: 160 };
  coach.reset(0);
  return { coach, partner };
}

test('a heart rate well above the zone brings an automatic breather', () => {
  const { coach, partner } = setup();
  let said = null;
  for (let t = 0; t < 40 && !partner.breaking; t += 0.5) said = coach.update(t, 185, partner) ?? said;
  assert.ok(partner.breaking);
  assert.ok(coach.autoBreak);
  // The voice line is fixed; the bubble shows the actual heart rate.
  assert.equal(said?.id, 'coach_breather_auto');
  assert.match(said?.bubble ?? '', /Heart at 185/);
});

test('losing the heart rate mid-run is mentioned once', () => {
  const { coach, partner } = setup();
  const said: string[] = [];
  let t = 0;
  for (; t < 5; t += 0.5) coach.update(t, 140, partner);
  for (const end = t + 60; t < end; t += 0.5) {
    const line = coach.update(t, null, partner);
    if (line) said.push(line.id);
  }
  assert.deepEqual(said, ['coach_heart_lost']);
});

test('after "let\'s go" there is no instant second breather', () => {
  const { coach, partner } = setup();
  let t = 0;
  for (; t < 40 && !partner.breaking; t += 0.5) coach.update(t, 185, partner);
  partner.setBreak(false);
  coach.resume(t);
  for (const end = t + 25; t < end; t += 0.5) coach.update(t, 185, partner);
  assert.equal(partner.breaking, false);
});

test('an automatic breather ends on its own if the watch drops out', () => {
  const { coach, partner } = setup();
  let t = 0;
  for (; t < 40 && !partner.breaking; t += 0.5) coach.update(t, 185, partner);
  for (const end = t + 61; t < end; t += 0.5) coach.update(t, null, partner);
  assert.equal(partner.breaking, false);
});
