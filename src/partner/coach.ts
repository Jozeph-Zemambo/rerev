import { ENCOURAGEMENT, PUSH, type Spoken } from '../voice/lines';
import type { Partner } from './partner';

export type Zone = { low: number; high: number };
/** What the coach wants said: a line from the catalog, plus specifics for the bubble. */
export type CoachLine = Spoken;

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
/** After the runner chooses to set off again, don't call another breather for this long. */
const RESUME_GRACE = 30;
/** If heart rate disappears during an automatic breather (watch dropped), give up waiting after this. */
const NO_HEART_RESUME = 60;
/** Heart rate gone this long mid-run (after having had one): say so, once. */
const NO_HEART_WARN = 15;

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
  private pushIndex = 0;
  private hadHeart = false;
  private warnedNoHeart = false;
  private graceUntil = 0;
  private noHeartSince: number | null = null;

  /** The runner set off again by choice: restart the clocks and hold off on another breather. */
  resume(now: number) {
    this.autoBreak = false;
    this.recoveringSince = null;
    this.bandSince = now;
    this.wellAboveSince = null;
    this.graceUntil = now + RESUME_GRACE;
  }

  reset(now: number) {
    this.hadHeart = false;
    this.warnedNoHeart = false;
    this.graceUntil = 0;
    this.noHeartSince = null;
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
      this.noHeartSince ??= now;
      if (this.autoBreak && partner.breaking && now - this.noHeartSince >= NO_HEART_RESUME) {
        this.resume(now);
        partner.setBreak(false);
        return this.say(now, { id: 'coach_resume_no_heart' }, true);
      }
      if (this.hadHeart && !this.warnedNoHeart && !partner.breaking && now - this.noHeartSince >= NO_HEART_WARN) {
        this.warnedNoHeart = true;
        return this.say(now, { id: 'coach_heart_lost' });
      }
      return null;
    }
    this.noHeartSince = null;
    this.hadHeart = true;
    this.warnedNoHeart = false;
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
          return this.say(now, { id: 'coach_resume_recovered', bubble: `Heart rate's back down to ${Math.round(bpm)}. Ready? Let's go!` }, true);
        }
      } else {
        this.recoveringSince = null;
      }
      return null;
    }

    if (partner.breaking) {
      // A breather the runner chose: keep the clocks fresh so "let's go" doesn't trip an instant break.
      this.bandSince = now;
      this.wellAboveSince = null;
      return null;
    }

    if (bpm > this.zone.high + WELL_ABOVE) this.wellAboveSince ??= now;
    else this.wellAboveSince = null;
    const wellAboveFor = this.wellAboveSince === null ? 0 : now - this.wellAboveSince;

    if (this.band === 'above') {
      if (now >= this.graceUntil && (inBand >= BREAK_AFTER || wellAboveFor >= WELL_ABOVE_AFTER)) {
        this.autoBreak = true;
        this.recoveringSince = null;
        partner.setBreak(true);
        return this.say(now, { id: 'coach_breather_auto', bubble: `Heart at ${Math.round(bpm)}. Let's take a breather and jog on the spot.` }, true);
      }
      if (inBand >= EASE_AFTER && !this.eased) {
        this.eased = true;
        this.effort = 0.85;
        return this.say(now, { id: 'coach_ease_off', bubble: `Heart at ${Math.round(bpm)}, above your ${this.zone.low}–${this.zone.high} zone. Let's ease off a little.` }, true);
      }
      return null;
    }

    if (this.band === 'below') {
      if (inBand >= PUSH_AFTER && now - this.lastPush >= PUSH_COOLDOWN && partner.state === 'run') {
        this.lastPush = now;
        this.effort = Math.min(1.12, this.effort + 0.06);
        return this.say(now, { id: PUSH[this.pushIndex++ % PUSH.length] });
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
      return this.say(now, { id: ENCOURAGEMENT[this.encourageIndex++ % ENCOURAGEMENT.length] });
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
