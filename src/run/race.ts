/**
 * Race mode on a walked course: the phone is propped up at the start, the buddy runs the course
 * on its own at a set pace, and you race it for real while the phone films. The timing, laps and
 * countdown are pure here so they can be tested without a frame loop.
 */
import type { CourseKind } from '../world/course';

export type RacePace = { id: 'easy' | 'steady' | 'fast'; label: string; speed: number };

/** Paces in metres per second. Steady is a hallway-friendly jog. */
export const RACE_PACES: readonly RacePace[] = [
  { id: 'easy', label: 'Easy', speed: 1.8 },
  { id: 'steady', label: 'Steady', speed: 2.5 },
  { id: 'fast', label: 'Fast', speed: 3.3 },
];
export const DEFAULT_RACE_PACE: RacePace['id'] = 'steady';
export const RACE_LAP_CHOICES = [1, 2, 3, 5] as const;

/** Two there-and-backs of a hallway, or three times round a loop. */
export function defaultRaceLaps(kind: CourseKind) {
  return kind === 'loop' ? 3 : 2;
}

/** The buddy lines up this far along the course from the phone, so it isn't under the camera. */
export const RACE_START_LEAD = 2;

/** "On your marks" before the numbers, so there's time to put the phone down and line up. */
export const READY_TIME = 3;
/** Each of 3, 2, 1 shows this long. */
export const COUNT_STEP = 1;
/** "GO!" stays on screen this long after the start. */
export const GO_SHOWS = 0.8;

export type RaceBeat = 'ready' | 3 | 2 | 1 | 'go';
export type RacePhase = 'countdown' | 'racing' | 'finished';

const BEATS: readonly [number, RaceBeat][] = [
  [0, 'ready'],
  [READY_TIME, 3],
  [READY_TIME + COUNT_STEP, 2],
  [READY_TIME + 2 * COUNT_STEP, 1],
  [READY_TIME + 3 * COUNT_STEP, 'go'],
];

/** Countdown, then the race clock. Times are in seconds, from whatever clock `now` comes from. */
export class RaceClock {
  phase: RacePhase = 'countdown';
  private startedAt = 0;
  private finishedAt: number | null = null;
  private beat = -1;

  /** When the race itself starts (the "go"). */
  get goAt() {
    return this.startedAt + BEATS.at(-1)![0];
  }

  start(now: number) {
    this.phase = 'countdown';
    this.startedAt = now;
    this.finishedAt = null;
    this.beat = -1;
  }

  /**
   * The countdown beat that has just come due, if any. A slow frame that skips beats only
   * reports the latest one, so a late "3" is never said after "go".
   */
  update(now: number): RaceBeat | null {
    if (this.phase !== 'countdown') return null;
    let due = -1;
    for (let i = 0; i < BEATS.length; i++) if (now - this.startedAt >= BEATS[i][0]) due = i;
    if (due <= this.beat) return null;
    this.beat = due;
    const beat = BEATS[due][1];
    if (beat === 'go') this.phase = 'racing';
    return beat;
  }

  /** The big on-screen number: "3", "2", "1", "GO!" just after the start, else null. */
  display(now: number): string | null {
    const t = now - this.startedAt;
    if (this.phase === 'countdown') {
      if (t < READY_TIME) return null;
      return String(3 - Math.min(2, Math.floor((t - READY_TIME) / COUNT_STEP)));
    }
    if (this.phase === 'racing' && now - this.goAt < GO_SHOWS) return 'GO!';
    return null;
  }

  /** Race time: 0 during the countdown, frozen once finished. */
  elapsed(now: number) {
    if (this.phase === 'countdown') return 0;
    return Math.max(0, (this.finishedAt ?? now) - this.goAt);
  }

  finish(now: number) {
    if (this.phase === 'finished') return;
    // Stopped during the countdown: the race never started.
    this.finishedAt = this.phase === 'countdown' ? this.goAt : now;
    this.phase = 'finished';
  }
}

/** Which lap (1-based, at most `laps`) the buddy is on, `travelled` metres into the race. */
export function raceLap(travelled: number, lapLength: number, laps: number) {
  if (lapLength <= 0) return 1;
  return Math.max(1, Math.min(laps, Math.floor(travelled / lapLength) + 1));
}

/** 0:42.3 */
export function formatRaceTime(seconds: number) {
  const tenths = Math.floor(Math.max(0, seconds) * 10);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/**
 * Where the race starts and finishes along a path laid for `laps + 1` laps (the extra one so the
 * finish, `laps` laps on from a start a little ahead of the phone, is still on the path).
 * `phoneS` is the phone's distance along the path. The start stays well short of the first
 * turnaround on a short out-and-back.
 */
export function raceSpan(phoneS: number, lapLength: number, laps: number, firstTurn = Infinity) {
  const start = Math.max(0, Math.min(phoneS + RACE_START_LEAD, lapLength * 0.4, firstTurn - 0.5));
  return { start, finish: start + laps * lapLength };
}
