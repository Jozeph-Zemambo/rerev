import * as THREE from 'three';
import type { Path } from '../world/path';
import type { Gait } from './mascot';

export type PartnerState = 'run' | 'stairs' | 'look' | 'turn' | 'wait' | 'break' | 'blocked' | 'done';

/** On stairs the buddy slows to a careful walk at this fraction of the goal pace. */
const STAIRS_PACE = 0.45;

const START_LEAD = 1.5;
const MIN_PACE = 0.6;
const MAX_PACE = 4;
/** Stops this far short of a blocked stretch. */
const STOP_SHORT = 1.2;
/** Never runs closer than this to ground the camera has not seen yet. */
const SEEN_MARGIN = 0.5;
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
 * Paces itself against the runner: stays a couple of metres ahead, jogs on the spot if it
 * gets too far in front, stops for breaks on request, and stops short of anything blocking
 * the path. Slows on uphills.
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
  /**
   * Outdoors on a planned route the ground just ahead of you is the pavement you're on, so the
   * buddy may keep its usual lead even before the camera has seen it. Indoors it stays strict.
   */
  trustGroundAhead = false;
  /**
   * Distances along the path where it doubles back on itself (out-and-back turnarounds),
   * ascending. Set before `reset`.
   */
  turnarounds: number[] = [];

  private speed = 0;
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
    };
  }

  get currentSpeed() {
    return this.speed;
  }

  reset(runnerS = 0) {
    this.s = runnerS + START_LEAD;
    this.state = 'run';
    this.speed = 0;
    this.onBreak = false;
    this.turnPause = 0;
    this.turnStarted = false;
    this.nextTurn = this.turnarounds.findIndex(t => t > this.s);
    if (this.nextTurn < 0) this.nextTurn = this.turnarounds.length;
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
    const seen = this.path.status.seenUntilS - SEEN_MARGIN;
    const seenLimit = this.trustGroundAhead ? Math.max(seen, runnerS + this.maxLead + 0.5) : seen;
    const lead = this.s - runnerS;

    if (this.s >= end) this.state = 'done';
    else if (this.onBreak) this.state = 'break';
    else if (blockedAt !== null && blockedAt - this.s < STOP_SHORT + 0.05) this.state = 'blocked';
    else if (turning) this.state = 'turn';
    else if (this.state === 'wait' ? lead > this.targetLead : lead > this.maxLead) this.state = 'wait';
    else if (this.path.onStairs(this.s + 0.3)) this.state = 'stairs';
    else if (this.s >= seenLimit - 0.05) this.state = 'look';
    else this.state = 'run';

    // Uphill costs pace (about 3% per 1% of grade, capped), downhill gives a little back.
    const grade = this.path.ready ? this.path.gradeAt(this.s) : 0;
    const hill = THREE.MathUtils.clamp(1 - grade * 3, 0.6, 1.1);
    // If you catch up, it picks up the pace a little so it stays your partner, not your shadow.
    const moving = this.state === 'run' || this.state === 'look';
    const target =
      this.state === 'stairs' ? this.goalPace * STAIRS_PACE : moving ? this.goalPace * this.effort * hill * (lead < 1 ? 1.25 : 1) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 3);
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
    next = Math.min(next, Math.max(this.s, seenLimit));
    this.s = Math.min(end, next);
  }
}
