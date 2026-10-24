import { pacePlan, PACE_DEFAULTS, type BuddyClip } from './buddyPace';
import type { PartnerState } from './partner';

export type Gait = {
  /** Forward speed in metres per second. */
  speed: number;
  /** Jogging on the spot (waiting for you, or on a break). */
  inPlace: boolean;
  /** Rise over run of the ground (positive = uphill). */
  grade: number;
  /** Standing about before a run: idles, and waves now and then. */
  idle?: boolean;
  /** What the partner is doing, when it's on a run. */
  state?: PartnerState;
};

/** What the buddy's body should be doing. */
export type BuddyMotion =
  /** Run along at this speed: the pacer picks jog or run, leg speed and stride. */
  | { kind: 'pace'; speed: number }
  /** Loop `clip`; every `every` seconds play `flourish` `repeats` times, then go back to it. */
  | { kind: 'loop'; clip: BuddyClip; flourish?: { clip: BuddyClip; repeats: number; every: number } };

/** Standing about: a wave (three flaps, ~1.8 s) every 4.5 s. */
const IDLE: BuddyMotion = { kind: 'loop', clip: 'Idle', flourish: { clip: 'Wave', repeats: 3, every: 4.5 } };
/** Waiting for you to catch up: jog on the spot, and beckon "come on!" now and then. */
const WAIT: BuddyMotion = { kind: 'loop', clip: 'JogInPlace', flourish: { clip: 'Beckon', repeats: 1, every: 6 } };
const JOG_IN_PLACE: BuddyMotion = { kind: 'loop', clip: 'JogInPlace' };
const DONE: BuddyMotion = { kind: 'loop', clip: 'Wave' };

/**
 * Once running, the legs keep going down to this fraction of the slowest natural leg speed
 * before switching to jogging on the spot, so a speed hovering at the threshold doesn't flicker.
 */
const SLOW_HYSTERESIS = 0.85;

/**
 * Which animation for a gait. `running` says whether the buddy is running along right now (for
 * hysteresis at the too-slow threshold); `height` is its height in metres.
 */
export function buddyMotion(gait: Gait, running: boolean, height: number): BuddyMotion {
  if (gait.idle) return IDLE;
  switch (gait.state) {
    case 'wait':
      return WAIT;
    case 'done':
      return DONE;
    case 'break':
    case 'blocked':
    case 'turn':
      return JOG_IN_PLACE;
    default:
      // run, stairs, look, or a gait with no state: move with the speed unless it's on the spot.
      if (gait.inPlace) return JOG_IN_PLACE;
      return paceOrJog(gait.speed, running, height);
  }
}

function paceOrJog(speed: number, running: boolean, height: number): BuddyMotion {
  const minLegSpeed = PACE_DEFAULTS.minLegSpeed * (running ? SLOW_HYSTERESIS : 1);
  const plan = pacePlan(speed, height, null, { minLegSpeed });
  return plan.tooSlow ? JOG_IN_PLACE : { kind: 'pace', speed };
}
