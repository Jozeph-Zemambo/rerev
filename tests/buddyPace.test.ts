import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BuddyPacer, BUILT_HEIGHT, GAITS, PACE_DEFAULTS, pacePlan } from '../src/partner/buddyPace';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

// At the built height the jog→run switch is at 0.79 × 1.15 = 0.9085 m/s, ±5% hysteresis.
const SWITCH = GAITS.Run_Jogging.speed * PACE_DEFAULTS.maxLegSpeed;

test('jogs below the switch speed and runs above it', () => {
  assert.equal(pacePlan(0.8).clip, 'Run_Jogging');
  assert.equal(pacePlan(SWITCH * 1.04).clip, 'Run_Jogging');
  assert.equal(pacePlan(SWITCH * 1.06).clip, 'Run_JogForward');
  assert.equal(pacePlan(2).clip, 'Run_JogForward');
});

test('the switch has hysteresis, so a speed at the boundary does not flicker', () => {
  // Already running: stays on the run down to 5% under the switch.
  assert.equal(pacePlan(SWITCH * 0.97, BUILT_HEIGHT, 'Run_JogForward').clip, 'Run_JogForward');
  assert.equal(pacePlan(SWITCH * 0.94, BUILT_HEIGHT, 'Run_JogForward').clip, 'Run_Jogging');
  // Jogging: needs 5% over the switch to change up.
  assert.equal(pacePlan(SWITCH * 1.03, BUILT_HEIGHT, 'Run_Jogging').clip, 'Run_Jogging');
});

test('the jog only plays faster or slower, never with a longer stride', () => {
  const plan = pacePlan(0.5);
  assert.equal(plan.stride, 1);
  close(plan.legSpeed, 0.5 / 0.79);
  close(plan.stepsPerSecond, 2.34 * plan.legSpeed);
});

test('the run speeds its legs up first, then lengthens its stride, then scurries', () => {
  const run = GAITS.Run_JogForward.speed;
  // Up to 1.15× leg speed: stride stays as built.
  const quick = pacePlan(run * 1.1);
  assert.equal(quick.stride, 1);
  close(quick.legSpeed, 1.1);
  // Then the stride grows, legs held at the most natural-looking speed.
  const longer = pacePlan(run * 1.5);
  close(longer.legSpeed, 1.15);
  close(longer.stride, 1.5 / 1.15);
  // Past the longest stride, only the legs go faster.
  const scurry = pacePlan(run * 3);
  close(scurry.stride, PACE_DEFAULTS.maxStride);
  close(scurry.legSpeed, 3 / PACE_DEFAULTS.maxStride);
  // Whatever the split, legs × stride covers the ground.
  close(longer.legSpeed * longer.stride * run, run * 1.5);
});

test('a taller buddy covers more ground per step, so its legs go slower', () => {
  const small = pacePlan(1.6, BUILT_HEIGHT);
  const tall = pacePlan(1.6, 1.3);
  assert.ok(tall.legSpeed * tall.stride < small.legSpeed * small.stride);
  close(tall.legSpeed * tall.stride * GAITS[tall.clip].speed * (1.3 / BUILT_HEIGHT), 1.6);
  // Its switch speed scales with it too.
  assert.equal(pacePlan(SWITCH * 1.1, 1.3).clip, 'Run_Jogging');
});

test('nearly stopped is too slow to show as a slow-motion jog', () => {
  assert.equal(pacePlan(0).tooSlow, true);
  assert.equal(pacePlan(0.79 * 0.55).tooSlow, true);
  assert.equal(pacePlan(0.79 * 0.65).tooSlow, false);
  assert.equal(pacePlan(1.6).tooSlow, false);
});

test('a flourish hands back to the loop without the body sagging to its bind pose', () => {
  const model = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'Hips';
  model.add(bone);
  const clip = (name: string, length: number) =>
    new THREE.AnimationClip(name, length, [new THREE.NumberKeyframeTrack('Hips.position[x]', [0, length], [1, 1])]);
  const pacer = new BuddyPacer(model, [clip('Idle', 2), clip('Wave', 0.6)]);
  pacer.play('Idle');
  pacer.playThen('Wave', 2, 'Idle');
  // Through the wave, its end and the crossfade back, the clips' weights always add up to all of it.
  let least = Infinity;
  for (let frame = 0; frame < 150; frame++) {
    pacer.update(1 / 60);
    const total = Object.values(pacer.actions).reduce((sum, action) => sum + action.getEffectiveWeight(), 0);
    least = Math.min(least, total);
  }
  assert.equal(pacer.current, 'Idle');
  close(least, 1, 1e-6);
});
