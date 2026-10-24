import type { Partner } from './partner';

export type Zone = { low: number; high: number };
export type CoachLine = { text: string; mood: 'cheer' | 'care' | 'info' };

/** Keeps zone edges from flickering when heart rate hovers right on them. */
const HYSTERESIS = 3;
/** Above the zone this long: ease off. Longer (or well above): take a breather. */
const EASE_AFTER = 12;
const BREAK_AFTER = 30;
const WELL_ABOVE = 12;
const WELL_ABOVE_AFTER = 8;
/** On a breather the buddy waits until heart rate is this far under the top of the zone for this long. */
const RECOVER_MARGIN = 8;
const RECOVER_AFTER = 8;
/** Below the zone this long while running: nudge the pace up. */
const PUSH_AFTER = 25;
const PUSH_COOLDOWN = 45;
const ENCOURAGE_EVERY = 75;
const MIN_GAP = 6;

const ENCOURAGEMENT = [
  'Nice rhythm. Right in the zone!',
  "You're cruising. Love it.",
  'Breathe easy, you are doing great.',
  'Steady and strong. Keep it up!',
  "This pace looks good on you.",
];

type Band = 'below' | 'in' | 'above';

/**
 * Turns heart rate into the buddy's behaviour. Plain rules decide what happens (safety
 * matters more than eloquence here); the coach just says it kindly.
 *
 *  - above the zone for a while → ease the pace, then take a breather (jog on the spot)
 *  - after an automatic breather, once heart rate settles → set off again
 *  - below the zone for a while → pick the pace up a little
 *  - in the zone → steady pace and the odd bit of encouragement
 */
export class Coach {
  zone: Zone = { low: 130, high: 160 };
  /** Multiplier the coach applies to the buddy's goal pace. */
  effort = 1;
  autoBreak = false;

  private band: Band = 'in';
  private bandSince = 0;
  private wellAboveSince: number | null = null;
  private recoveringSince: number | null = null;
  private lastSpoke = -Infinity;
  private lastPush = -Infinity;
  private lastEncourage = 0;
  private eased = false;
  private encourageIndex = 0;

  reset(now: number) {
    this.effort = 1;
    this.autoBreak = false;
    this.band = 'in';
    this.bandSince = now;
    this.wellAboveSince = null;
    this.recoveringSince = null;
    this.lastSpoke = -Infinity;
    this.lastPush = -Infinity;
    this.lastEncourage = now;
    this.eased = false;
  }

  update(now: number, bpm: number | null, partner: Partner): CoachLine | null {
    if (bpm === null) {
      this.effort += (1 - this.effort) * 0.02;
      return null;
    }
    this.updateBand(now, bpm);
    const inBand = now - this.bandSince;

    if (this.autoBreak) {
      if (!partner.breaking) {
        // The runner restarted on their own.
        this.autoBreak = false;
      } else if (bpm < this.zone.high - RECOVER_MARGIN) {
        this.recoveringSince ??= now;
        if (now - this.recoveringSince >= RECOVER_AFTER) {
          this.autoBreak = false;
          this.recoveringSince = null;
          this.eased = true;
          this.effort = 0.9;
          partner.setBreak(false);
          return this.say(now, { text: "Heart rate's back down. Ready? Let's go!", mood: 'cheer' }, true);
        }
      } else {
        this.recoveringSince = null;
      }
      return null;
    }

    if (partner.breaking) return null;

    if (bpm > this.zone.high + WELL_ABOVE) this.wellAboveSince ??= now;
    else this.wellAboveSince = null;
    const wellAboveFor = this.wellAboveSince === null ? 0 : now - this.wellAboveSince;

    if (this.band === 'above') {
      if (inBand >= BREAK_AFTER || wellAboveFor >= WELL_ABOVE_AFTER) {
        this.autoBreak = true;
        this.recoveringSince = null;
        partner.setBreak(true);
        return this.say(now, { text: "Your heart's working hard. Let's take a breather and jog on the spot.", mood: 'care' }, true);
      }
      if (inBand >= EASE_AFTER && !this.eased) {
        this.eased = true;
        this.effort = 0.85;
        return this.say(now, { text: "You're above your zone. Let's ease off a little.", mood: 'care' }, true);
      }
      return null;
    }

    if (this.band === 'below') {
      if (inBand >= PUSH_AFTER && now - this.lastPush >= PUSH_COOLDOWN && partner.state === 'run') {
        this.lastPush = now;
        this.effort = Math.min(1.12, this.effort + 0.06);
        return this.say(now, { text: "You've got more in you. Let's pick it up!", mood: 'cheer' });
      }
      return null;
    }

    // In the zone: drift back to the goal pace and cheer now and then.
    if (inBand > 20) {
      this.eased = false;
      this.effort += (1 - this.effort) * 0.01;
    }
    if (now - this.lastEncourage >= ENCOURAGE_EVERY && partner.state === 'run') {
      this.lastEncourage = now;
      const text = ENCOURAGEMENT[this.encourageIndex++ % ENCOURAGEMENT.length];
      return this.say(now, { text, mood: 'cheer' });
    }
    return null;
  }

  private updateBand(now: number, bpm: number) {
    let next: Band = this.band;
    if (bpm > this.zone.high + (this.band === 'above' ? -HYSTERESIS : HYSTERESIS)) next = 'above';
    else if (bpm < this.zone.low - (this.band === 'below' ? -HYSTERESIS : HYSTERESIS)) next = 'below';
    else next = 'in';
    if (next !== this.band) {
      this.band = next;
      this.bandSince = now;
    }
  }

  private say(now: number, line: CoachLine, important = false): CoachLine | null {
    if (!important && now - this.lastSpoke < MIN_GAP) return null;
    this.lastSpoke = now;
    return line;
  }
}
