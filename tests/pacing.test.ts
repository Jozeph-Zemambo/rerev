import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Partner, type PartnerState } from '../src/partner/partner';
import { paceTarget, RunnerSpeed, type PaceInput } from '../src/partner/pacing';
import { demoRoute, Path } from '../src/world/path';

const DT = 1 / 60;

/** A long straight path whose ground is all seen (unless a test says otherwise). */
function straight(): Path {
  const path = new Path();
  path.setRoute(demoRoute(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), 300), 0);
  path.status.seenUntilS = path.length;
  return path;
}

type Sample = { t: number; runnerS: number; speed: number; lead: number; state: PartnerState; runnerSpeed: number };

/**
 * Run a buddy alongside a runner whose speed at time t is `speedAt(t)`, for `seconds`. The ground
 * is seen to `seen(runnerS)` (all of it by default).
 */
function run(partner: Partner, path: Path, seconds: number, speedAt: (t: number) => number, seen = (_s: number) => path.length) {
  const samples: Sample[] = [];
  let runnerS = 0;
  partner.reset(0);
  for (let t = 0; t < seconds; t += DT) {
    path.status.seenUntilS = seen(runnerS);
    partner.update(DT, runnerS);
    samples.push({ t, runnerS, speed: partner.currentSpeed, lead: partner.s - runnerS, state: partner.state, runnerSpeed: speedAt(t) });
    runnerS += speedAt(t) * DT;
  }
  return samples;
}

const switches = (samples: Sample[]) => samples.filter((s, i) => i > 0 && s.state !== samples[i - 1].state).length;
const between = (samples: Sample[], from: number, to: number) => samples.filter(s => s.t >= from && s.t < to);

test('a steady slow walker gets a buddy at their speed, about 2 m ahead, with no stop-start', () => {
  const path = straight();
  const partner = new Partner(path);
  const samples = run(partner, path, 40, () => 0.6);
  const settled = between(samples, 8, 40);
  for (const s of settled) {
    assert.equal(s.state, 'run', `${s.state} at ${s.t.toFixed(1)} s`);
    assert.ok(Math.abs(s.lead - 2) < 0.3, `lead ${s.lead.toFixed(2)} m at ${s.t.toFixed(1)} s`);
    assert.ok(Math.abs(s.speed - 0.6) < 0.15, `speed ${s.speed.toFixed(2)} at ${s.t.toFixed(1)} s`);
  }
  // Waits for them to set off, then runs: one switch, never back.
  assert.ok(switches(samples) <= 1, `${switches(samples)} state switches`);
});

test('when the runner stops, the buddy eases to a stop and waits; when they go, it sets off smoothly', () => {
  const path = straight();
  const partner = new Partner(path);
  const speedAt = (t: number) => (t >= 10 && t < 16 ? 0 : 1.2);
  const samples = run(partner, path, 26, speedAt);
  const stopped = between(samples, 11.6, 16);
  assert.ok(stopped.every(s => s.state === 'wait'), 'waits while they stand');
  // It doesn't run on: still about its usual lead once they've stopped.
  assert.ok(stopped.at(-1)!.lead < 3.2, `ran on to ${stopped.at(-1)!.lead.toFixed(2)} m ahead`);
  const resumed = between(samples, 16, 26).find(s => s.state === 'run');
  assert.ok(resumed && resumed.t < 16.6, `set off ${resumed ? (resumed.t - 16).toFixed(2) : 'never'} s after them`);
  // Smoothly: no jumps in speed, and the lead never collapses.
  for (let i = 1; i < samples.length; i++) {
    assert.ok(Math.abs(samples[i].speed - samples[i - 1].speed) < 0.1, `speed jumped at ${samples[i].t.toFixed(2)} s`);
  }
  assert.ok(between(samples, 16, 26).every(s => s.lead > 0.9), 'the runner never catches it');
  assert.ok(between(samples, 22, 26).every(s => Math.abs(s.lead - 2) < 0.35), 'and it settles back to 2 m');
  assert.equal(switches(samples), 3, 'wait → run → wait → run');
});

test('a runner speeding up from a walk to a run keeps the buddy just ahead, never waiting', () => {
  const path = straight();
  const partner = new Partner(path);
  const speedAt = (t: number) => (t < 5 ? 0.7 : Math.min(2.6, 0.7 + (t - 5) * 0.2));
  const samples = run(partner, path, 30, speedAt);
  for (const s of between(samples, 3, 30)) {
    assert.equal(s.state, 'run', `${s.state} at ${s.t.toFixed(1)} s`);
    assert.ok(s.lead > 1 && s.lead < 3, `lead ${s.lead.toFixed(2)} m at ${s.t.toFixed(1)} s`);
  }
  const end = samples.at(-1)!;
  assert.ok(Math.abs(end.speed - 2.6) < 0.15, `at ${end.speed.toFixed(2)} m/s by the end`);
});

test('on a map route a runner falling behind the goal pace brings it down to theirs, not to a stop', () => {
  const path = straight();
  const partner = new Partner(path);
  partner.pacing = 'goal';
  partner.goalPace = 2.8;
  const speedAt = (t: number) => (t < 10 ? 2.8 : 2.0);
  const samples = run(partner, path, 40, speedAt);
  const keepingUp = between(samples, 5, 10);
  assert.ok(keepingUp.every(s => Math.abs(s.speed - 2.8) < 0.1), 'holds the goal pace while they keep up');
  const behind = between(samples, 10, 40);
  for (const s of behind) {
    assert.equal(s.state, 'run', `${s.state} at ${s.t.toFixed(1)} s`);
    assert.ok(s.speed > 1.8, `slowed to ${s.speed.toFixed(2)} m/s at ${s.t.toFixed(1)} s`);
    assert.ok(s.lead < partner.maxLead, `lead ${s.lead.toFixed(2)} m at ${s.t.toFixed(1)} s`);
  }
  const end = samples.at(-1)!;
  assert.ok(Math.abs(end.speed - 2) < 0.1, `paces them at ${end.speed.toFixed(2)} m/s`);
  // Just ahead of its target lead: still pulling them on.
  assert.ok(end.lead > partner.targetLead && end.lead < partner.maxLead, `lead ${end.lead.toFixed(2)} m`);
});

test('on a map route it still waits for a runner who stops', () => {
  const path = straight();
  const partner = new Partner(path);
  partner.pacing = 'goal';
  partner.goalPace = 2.8;
  // Pulling up over a second.
  const samples = run(partner, path, 20, t => 2.8 * Math.min(1, Math.max(0, 11 - t)));
  assert.ok(between(samples, 12.5, 20).every(s => s.state === 'wait'));
  // From a run it can't stop dead either: it pulls up a little past its usual lead.
  assert.ok(samples.at(-1)!.lead < partner.maxLead + 0.5, `stopped ${samples.at(-1)!.lead.toFixed(2)} m ahead`);
});

test('unseen ground ahead does not hold it back; only a camera seeing nothing ahead for a while does', () => {
  const path = straight();
  const partner = new Partner(path);
  // Depth while walking: ground seen only a metre ahead of the runner.
  const short = run(partner, path, 20, () => 1, s => s + 1);
  assert.ok(between(short, 4, 20).every(s => s.state === 'run' && Math.abs(s.lead - 2) < 0.3));
  // Pointing at the sky: nothing seen ahead of the runner. Fine for a moment, then it holds back.
  const blind = run(partner, path, 10, () => 1, s => s + 0.1);
  assert.ok(between(blind, 0, 2.9).every(s => s.state !== 'look'), 'not straight away');
  assert.ok(between(blind, 4, 10).some(s => s.state === 'look'), 'asks to look ahead');
  assert.ok(between(blind, 5, 10).every(s => s.lead <= 0.1 + 1e-6), 'stays on the ground it has seen');
});

test('a block flickering on and off holds the buddy still rather than lurching', () => {
  const path = straight();
  const partner = new Partner(path);
  partner.reset(0);
  let runnerS = 0;
  for (let t = 0; t < 6; t += DT) {
    partner.update(DT, runnerS);
    runnerS += DT;
  }
  const at = partner.s;
  // Something right ahead, seen in some frames and not others.
  for (let t = 0; t < 3; t += DT) {
    path.status.blockedAtS = Math.floor(t * 4) % 2 === 0 ? at + 1 : null;
    partner.update(DT, runnerS);
    assert.equal(partner.state, 'blocked', `${partner.state} at ${t.toFixed(2)} s`);
  }
  assert.ok(partner.s - at < 0.05, `crept ${(partner.s - at).toFixed(2)} m`);
  path.status.blockedAtS = null;
  for (let t = 0; t < 1; t += DT) partner.update(DT, runnerS);
  assert.equal(partner.state, 'wait', 'clear, it goes back to waiting for the (stopped) runner');
});

// ---------------------------------------------------------------- the pure parts

const input = (p: Partial<PaceInput>): PaceInput => ({
  mode: 'match',
  runnerSpeed: 1,
  lead: 2,
  targetLead: 2,
  maxLead: 4.5,
  goalPace: 1.6,
  effort: 1,
  hill: 1,
  ...p,
});

test('matching goes the runner speed at the target lead, and drifts gently back to it', () => {
  assert.equal(paceTarget(input({})), 1);
  assert.ok(paceTarget(input({ lead: 1 })) > 1 && paceTarget(input({ lead: 1 })) < 1.6);
  assert.ok(paceTarget(input({ lead: 3 })) < 1 && paceTarget(input({ lead: 3 })) > 0.4);
  // However far off, the correction stays gentle.
  assert.ok(paceTarget(input({ lead: -5 })) <= 1.6 + 1e-9);
  assert.equal(paceTarget(input({ lead: 10, runnerSpeed: 0.5 })), 0);
  // No goal pace and no hill in it: the runner's speed already has both.
  assert.equal(paceTarget(input({ goalPace: 3, hill: 0.7 })), 1);
});

test('the coach eases the matched speed off, or pushes it on', () => {
  assert.ok(paceTarget(input({ effort: 0.85 })) < 1);
  assert.ok(paceTarget(input({ effort: 1.1 })) > 1);
});

test('a pacer holds the goal pace, slowed by hills and effort, and keeps ahead of a quicker runner', () => {
  const goal = input({ mode: 'goal', goalPace: 2.5, runnerSpeed: 1.8 });
  assert.equal(paceTarget(goal), 2.5);
  assert.ok(Math.abs(paceTarget({ ...goal, hill: 0.8 }) - 2) < 1e-9);
  assert.ok(Math.abs(paceTarget({ ...goal, effort: 0.9 }) - 2.25) < 1e-9);
  assert.ok(paceTarget({ ...goal, runnerSpeed: 3, lead: 1.8 }) > 3);
  // A little behind: still the goal pace. Far behind: about their speed, a little under.
  assert.equal(paceTarget({ ...goal, runnerSpeed: 1.5, lead: 2.4 }), 2.5);
  assert.ok(paceTarget({ ...goal, runnerSpeed: 1.5, lead: 4.5 }) < 1.5);
});

test('runner speed is smoothed, ignores re-laid path jumps, and sees a swaying phone as stopped', () => {
  const speed = new RunnerSpeed();
  speed.reset(0);
  let s = 0;
  for (let t = 0; t < 3; t += DT) speed.update(DT, (s += 0.8 * DT));
  assert.ok(Math.abs(speed.speed - 0.8) < 0.02 && !speed.stopped);
  // The path re-laid under them: their distance along it jumps 1.5 m in a frame.
  speed.update(DT, (s += 1.5));
  for (let t = 0; t < 0.5; t += DT) speed.update(DT, (s += 0.8 * DT));
  assert.ok(Math.abs(speed.speed - 0.8) < 0.02, `jump read as ${speed.speed.toFixed(2)} m/s`);
  // Standing, swaying the phone 5 cm back and forth.
  const base = s;
  for (let t = 0; t < 3; t += DT) speed.update(DT, base + 0.05 * Math.sin(t * 6));
  assert.ok(speed.stopped && speed.speed < 0.15);
});
