import * as THREE from 'three';
import type { Path } from '../world/path';
import type { Gait } from './mascot';

export type PartnerState = 'run' | 'look' | 'wait' | 'break' | 'blocked' | 'done';

const START_LEAD = 1.5;
const MIN_PACE = 0.6;
const MAX_PACE = 4;
/** Stops this far short of a blocked stretch. */
const STOP_SHORT = 1.2;
/** Never runs closer than this to ground the camera has not seen yet. */
const SEEN_MARGIN = 0.5;

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
  targetLead = 2;
  maxLead = 4.5;

  private speed = 0;
  private onBreak = false;
  private readonly path: Path;

  constructor(path: Path) {
    this.path = path;
  }

  get gait(): Gait {
    return {
      speed: this.speed,
      inPlace: this.state !== 'run' && !(this.state === 'look' && this.speed > 0.3),
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

  update(dt: number, runnerS: number) {
    const end = this.path.length - 0.3;
    const blockedAt = this.path.status.blockedAtS;
    const seenLimit = this.path.status.seenUntilS - SEEN_MARGIN;
    const lead = this.s - runnerS;

    if (this.s >= end) this.state = 'done';
    else if (this.onBreak) this.state = 'break';
    else if (blockedAt !== null && blockedAt - this.s < STOP_SHORT) this.state = 'blocked';
    else if (this.state === 'wait' ? lead > this.targetLead : lead > this.maxLead) this.state = 'wait';
    else if (this.s >= seenLimit - 0.05) this.state = 'look';
    else this.state = 'run';

    // Uphill costs pace (about 3% per 1% of grade, capped), downhill gives a little back.
    const grade = this.path.ready ? this.path.gradeAt(this.s) : 0;
    const hill = THREE.MathUtils.clamp(1 - grade * 3, 0.6, 1.1);
    // If you catch up, it picks up the pace a little so it stays your partner, not your shadow.
    const moving = this.state === 'run' || this.state === 'look';
    const target = moving ? this.goalPace * hill * (lead < 1 ? 1.25 : 1) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 3);
    let next = this.s + this.speed * dt;
    if (blockedAt !== null) next = Math.min(next, Math.max(this.s, blockedAt - STOP_SHORT));
    next = Math.min(next, Math.max(this.s, seenLimit));
    this.s = Math.min(end, next);
  }
}
