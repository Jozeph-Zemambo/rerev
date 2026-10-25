import * as THREE from 'three';
import type { Path } from '../world/path';
import type { Gait } from './buddyMotion';
import { paceTarget, RunnerSpeed, type PacingMode } from './pacing';

export type PartnerState = 'run' | 'stairs' | 'look' | 'turn' | 'wait' | 'break' | 'blocked' | 'done';

/** On stairs a pacer slows to a careful walk at this fraction of the goal pace. */
const STAIRS_PACE = 0.45;

const START_LEAD = 1.5;
const MIN_PACE = 0.6;
const MAX_PACE = 4;
/** Stops this far short of a blocked stretch. */
const STOP_SHORT = 1.2;
/**
 * Unseen ground doesn't hold the buddy back: phone depth while walking only marks floor a metre
 * or so ahead, and holding to it made the buddy stall and lurch every few seconds. Hazards still
 * stop or steer it once they're confirmed. Only when the camera has seen no ground ahead
 * of the runner (BLIND_AHEAD) for BLIND_AFTER seconds (pointing at the sky, or at their feet)
 * does it hold to what has been seen, SEEN_MARGIN short of the end of it, and ask to look ahead.
 */
const BLIND_AHEAD = 0.5;
const BLIND_AFTER = 3;
const SEEN_MARGIN = 0.5;
/**
 * A blocked path has to stay clear this long before it sets off again: right at a hazard, noisy
 * depth can flick the block on and off a few times a second, and it shouldn't lurch with it.
 */
const CLEAR_HOLD = 0.6;
/** Waits for a runner who's this far beyond maxLead behind, even if they're still moving. */
const FAR_BEHIND = 1.5;
/** How quickly its speed follows the target (per second): about a third of a second to settle. */
const SPEED_RATE = 3;

/**
 * Turning round at the end of an out-and-back: brake steadily over the last TURN_SLOW metres
 * down to TURN_SPEED, jog on the spot for at least TURN_PAUSE seconds while turning, then pick
 * up again. It waits there until you're within TURN_WAIT of the turn: lead is measured along
 * the path, so without that it would run straight back past a slower runner.
 */
const TURN_SLOW = 2;
const TURN_SPEED = 0.35;
const TURN_PAUSE = 0.4;
const TURN_WAIT = 1.5;

/**
 * Paces itself against the runner (see pacing.ts): stays a couple of metres ahead at their own
 * speed, or at the goal pace on a planned route, and jogs on the spot once they stop. Stops for
 * breaks on request, and short of anything blocking the path. Slows on uphills and stairs.
 */
export class Partner {
  s = START_LEAD;
  state: PartnerState = 'run';
  /** Goal pace in metres per second. 1.6 suits an indoor demo; a real jog is ~2.8. */
  goalPace = 1.6;
  /** Set by the coach from heart rate: below 1 eases off, above 1 pushes a little. */
  effort = 1;
  targetLead = 2;
  maxLead = 4.5;
  /** 'goal' paces a planned route at goalPace; 'match' (Quick start, courses) goes the runner's speed. */
  pacing: PacingMode = 'match';
  /** The runner's speed along the path, smoothed. */
  readonly runner = new RunnerSpeed();
  /**
   * Distances along the path where it doubles back on itself (out-and-back turnarounds),
   * ascending. Set before `reset`.
   */
  turnarounds: number[] = [];

  private speed = 0;
  /** How long the camera has seen no ground ahead of the runner. */
  private blindFor = 0;
  /** How long the path has been clear since it was last blocked. */
  private clearFor = 0;
  private onBreak = false;
  /** Index of the next turnaround still ahead, and how long is left of the pause at it. */
  private nextTurn = 0;
  private turnPause = 0;
  private turnStarted = false;
  private readonly path: Path;

  constructor(path: Path) {
    this.path = path;
  }

  get gait(): Gait {
    return {
      speed: this.speed,
      inPlace: this.state !== 'run' && this.state !== 'stairs' && !(this.state === 'look' && this.speed > 0.3),
      grade: this.path.ready ? this.path.gradeAt(this.s) : 0,
      state: this.state,
    };
  }

  get currentSpeed() {
    return this.speed;
  }

  reset(runnerS = 0) {
    this.s = runnerS + START_LEAD;
    this.state = 'run';
    this.speed = 0;
    this.blindFor = 0;
    this.clearFor = 0;
    this.runner.reset(runnerS);
    this.onBreak = false;
    this.turnPause = 0;
    this.turnStarted = false;
    this.nextTurn = this.turnarounds.findIndex(t => t > this.s);
    if (this.nextTurn < 0) this.nextTurn = this.turnarounds.length;
  }

  /**
   * Pick up again at `s` (follow-me: the runner went past, so it reappears ahead of them). Keeps
   * its speed, so it doesn't stand and restart.
   */
  skipTo(s: number) {
    this.s = s;
  }

  setBreak(onBreak: boolean) {
    this.onBreak = onBreak;
  }

  get breaking() {
    return this.onBreak;
  }

  nudgePace(delta: number) {
    this.goalPace = THREE.MathUtils.clamp(this.goalPace + delta, MIN_PACE, MAX_PACE);
  }

  /** Distance along the path of the turnaround coming up, or Infinity if there are none left. */
  get turnaroundAhead(): number {
    return this.turnarounds[this.nextTurn] ?? Infinity;
  }

  update(dt: number, runnerS: number) {
    const end = this.path.length - 0.3;
    const runner = this.runner;
    runner.update(dt, runnerS);
    const turnAt = this.turnaroundAhead;
    const atTurn = this.s >= turnAt - 0.001;
    if (atTurn && !this.turnStarted) {
      // Arrived at the turnaround: stop and turn round.
      this.turnStarted = true;
      this.turnPause = TURN_PAUSE;
      this.speed = 0;
    }
    const turning = atTurn && !this.onBreak;
    const blockedAt = this.path.status.blockedAtS;
    const seenUntil = this.path.status.seenUntilS;
    this.blindFor = seenUntil - runnerS < BLIND_AHEAD ? this.blindFor + dt : 0;
    const blind = this.blindFor >= BLIND_AFTER;
    const seenLimit = blind ? seenUntil - SEEN_MARGIN : Infinity;
    const lead = this.s - runnerS;
    // Waiting for a runner who's stopped carries on until they move again; for one far behind,
    // until they're back within maxLead.
    const waitFor = runner.stopped || lead > this.maxLead + (this.state === 'wait' ? 0 : FAR_BEHIND);

    const blockedHere = blockedAt !== null && blockedAt - this.s < STOP_SHORT + 0.05;
    this.clearFor = blockedHere ? 0 : this.clearFor + dt;
    const stillBlocked = this.state === 'blocked' && this.clearFor < CLEAR_HOLD;

    if (this.s >= end) this.state = 'done';
    else if (this.onBreak) this.state = 'break';
    else if (blockedHere || stillBlocked) this.state = 'blocked';
    else if (turning) this.state = 'turn';
    else if (waitFor) this.state = 'wait';
    else if (this.path.onStairs(this.s + 0.3)) this.state = 'stairs';
    else if (this.s >= seenLimit - 0.05) this.state = 'look';
    else this.state = 'run';

    // Uphill costs pace (about 3% per 1% of grade, capped), downhill gives a little back.
    const grade = this.path.ready ? this.path.gradeAt(this.s) : 0;
    const hill = THREE.MathUtils.clamp(1 - grade * 3, 0.6, 1.1);
    const moving = this.state === 'run' || this.state === 'look' || this.state === 'stairs';
    let target = moving
      ? paceTarget({
          mode: this.pacing,
          runnerSpeed: runner.pace,
          lead,
          targetLead: this.targetLead,
          maxLead: this.maxLead,
          goalPace: this.goalPace,
          effort: this.effort,
          hill,
        })
      : 0;
    // A pacer takes stairs carefully; matching, the runner's own speed on them already does.
    if (this.state === 'stairs' && this.pacing === 'goal') target = Math.min(target, this.goalPace * STAIRS_PACE);
    this.speed += (target - this.speed) * Math.min(1, dt * SPEED_RATE);
    if (this.state === 'turn') {
      this.speed = 0;
      this.turnPause -= dt;
      if (this.turnPause <= 0 && runnerS >= turnAt - TURN_WAIT) {
        this.nextTurn++;
        this.turnStarted = false;
      }
    } else if (turnAt < Infinity) {
      // Constant braking into the turn: v² = v_turn² + 2·a·d, reaching full pace TURN_SLOW out.
      const brake = (this.goalPace * this.goalPace - TURN_SPEED * TURN_SPEED) / (2 * TURN_SLOW);
      const cap = Math.sqrt(TURN_SPEED * TURN_SPEED + 2 * Math.max(0, brake) * Math.max(0, turnAt - this.s));
      this.speed = Math.min(this.speed, cap);
    }
    let next = this.s + this.speed * dt;
    // Never run past a turnaround without turning at it.
    if (this.nextTurn < this.turnarounds.length) next = Math.min(next, this.turnarounds[this.nextTurn]);
    if (blockedAt !== null) next = Math.min(next, Math.max(this.s, blockedAt - STOP_SHORT));
    if (this.state === 'blocked') next = this.s;
    next = Math.min(next, Math.max(this.s, seenLimit), end);
    // Held back by a limit, it goes no faster than the limit lets it (so the legs match).
    if (dt > 0 && next < this.s + this.speed * dt) this.speed = Math.max(0, (next - this.s) / dt);
    this.s = next;
  }
}
