import * as THREE from 'three';
import type { Path } from '../world/path';
import type { Gait } from './mascot';

export type PartnerState = 'run' | 'wait' | 'break' | 'done';

const START_LEAD = 1.5;
const MIN_PACE = 0.6;
const MAX_PACE = 4;

/**
 * Paces itself against the runner: stays a couple of metres ahead, jogs on the spot if it
 * gets too far in front, and stops for breaks on request.
 */
export class Partner {
  s = START_LEAD;
  state: PartnerState = 'run';
  /** Goal pace in metres per second. 1.6 suits an indoor demo; a real jog is ~2.8. */
  goalPace = 1.6;
  targetLead = 2;
  maxLead = 4.5;

  private speed = 0;
  private readonly path: Path;

  constructor(path: Path) {
    this.path = path;
  }

  get gait(): Gait {
    return { speed: this.speed, inPlace: this.state !== 'run' };
  }

  get currentSpeed() {
    return this.speed;
  }

  reset() {
    this.s = START_LEAD;
    this.state = 'run';
    this.speed = 0;
  }

  setBreak(onBreak: boolean) {
    if (this.state === 'done') return;
    this.state = onBreak ? 'break' : 'run';
  }

  nudgePace(delta: number) {
    this.goalPace = THREE.MathUtils.clamp(this.goalPace + delta, MIN_PACE, MAX_PACE);
  }

  update(dt: number, runnerS: number) {
    const end = this.path.length - 0.3;
    if (this.state === 'break' || this.state === 'done') {
      this.speed = 0;
      return;
    }
    if (this.s >= end) {
      this.state = 'done';
      this.speed = 0;
      return;
    }

    const lead = this.s - runnerS;
    if (this.state === 'wait' && lead <= this.targetLead) this.state = 'run';
    else if (this.state === 'run' && lead > this.maxLead) this.state = 'wait';

    // If you catch up, it picks up the pace a little so it stays your partner, not your shadow.
    const target = this.state === 'run' ? this.goalPace * (lead < 1 ? 1.25 : 1) : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 3);
    this.s = Math.min(end, this.s + this.speed * dt);
  }
}
