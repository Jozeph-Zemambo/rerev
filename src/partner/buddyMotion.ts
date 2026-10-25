import { pacePlan, type BuddyClip } from './buddyPace';
import type { PartnerState } from './partner';
import type { BuddyColor } from './buddies';

export type Gait = {
  /** Forward speed in metres per second. */
  speed: number;
  /** Jogging on the spot (waiting for you, or on a break). */
  inPlace: boolean;
  /** Rise over run of the ground (positive = uphill). */
  grade: number;
  /** Standing about before a run: idles, and waves now and then. */
  idle?: boolean;
  /** Idling on the start line of a race: stands still, no waving. */
  ready?: boolean;
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
const READY: BuddyMotion = { kind: 'loop', clip: 'Idle' };
/** Waiting for you to catch up: jog on the spot, and beckon "come on!" now and then. */
const WAIT: BuddyMotion = { kind: 'loop', clip: 'JogInPlace', flourish: { clip: 'Beckon', repeats: 1, every: 6 } };
const JOG_IN_PLACE: BuddyMotion = { kind: 'loop', clip: 'JogInPlace' };
const DONE: BuddyMotion = { kind: 'loop', clip: 'Wave' };

/**
 * At the demo table, on the laptop screen and in AR alike: Rev stands idling; Vita waves (five
 * flaps, 3 s) with a breath of idle (1.5 s) between, so she's waving nearly all the time but
 * doesn't look stuck on a loop.
 */
export const BOOTH_MOTION: Record<BuddyColor, BuddyMotion> = {
  blue: { kind: 'loop', clip: 'Idle' },
  pink: { kind: 'loop', clip: 'Idle', flourish: { clip: 'Wave', repeats: 5, every: 4.5 } },
};

/**
 * Slowest leg speed (fraction of the jog clip's own) it jogs along at. Below the pacer's usual
 * minimum (PACE_DEFAULTS.minLegSpeed) the jog is a little slow-motion, but a buddy matching a
 * slow walker (~0.5 m/s) is still moving: jogging on the spot there would slide its feet along
 * the floor, and a walker's speed wobbling round the minimum would swap clips every second.
 */
export const MOVING_LEG_SPEED = 0.4;
/**
 * Once jogging, the legs keep going down to this fraction of MOVING_LEG_SPEED before switching
 * to jogging on the spot, so a speed hovering at the threshold doesn't flicker.
 */
export const SLOW_HYSTERESIS = 0.75;

/**
 * Which animation for a gait. `running` says whether the buddy is running along right now (for
 * hysteresis at the too-slow threshold); `height` is its height in metres.
 */
export function buddyMotion(gait: Gait, running: boolean, height: number): BuddyMotion {
  if (gait.idle) return gait.ready ? READY : IDLE;
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
  const minLegSpeed = MOVING_LEG_SPEED * (running ? SLOW_HYSTERESIS : 1);
  const plan = pacePlan(speed, height, null, { minLegSpeed });
  return plan.tooSlow ? JOG_IN_PLACE : { kind: 'pace', speed };
}
