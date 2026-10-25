/**
 * The booth's decisions, kept apart from three.js and the DOM so they can be tested: how big a
 * buddy stands on the surface it was put on, and when each buddy pipes up.
 */
import { BUDDY_COLORS, type BuddyColor } from '../partner/buddies';

/** A buddy on the floor is its normal running size, in metres. */
export const FLOOR_HEIGHT = 1.3;
/** On a table (or any raised surface) it's a figurine about this tall. */
export const FIGURINE_HEIGHT = 0.4;
/**
 * A surface at least this far above the floor is furniture, not floor. Tables are ~0.75 m,
 * coffee tables ~0.4 m; floors seen from one spot vary by a few centimetres, or ~0.2 m at a step.
 */
export const RAISED_ABOVE_FLOOR = 0.3;
/**
 * A surface at least this far below the phone can be the floor. Held at the chest, seated
 * (~1.1 m up) or standing (~1.4 m), the phone is 0.9 m+ over the floor but at most ~0.65 m over
 * a table top; 0.8 m sits between the two.
 */
export const FLOOR_BELOW_PHONE = 0.8;

/**
 * The lowest floor seen so far, after a horizontal surface at `surfaceY` was seen from a phone
 * at `phoneY`. Only surfaces well below the phone count, so a table seen on its own never
 * becomes "the floor" that the next table top is compared with.
 */
export function lowestFloor(floorY: number | null, surfaceY: number, phoneY: number): number | null {
  if (phoneY - surfaceY < FLOOR_BELOW_PHONE) return floorY;
  return floorY === null ? surfaceY : Math.min(floorY, surfaceY);
}

/**
 * How tall a buddy stands on a horizontal surface at `surfaceY`.
 *
 * Measured from the floor when one has been seen: that doesn't depend on how the phone is held,
 * and at a demo table the floor is usually in view. With no floor seen yet (only the table top),
 * measured from the phone instead: anything within FLOOR_BELOW_PHONE of it is a raised surface.
 */
export function standHeight(surfaceY: number, floorY: number | null, phoneY: number): number {
  const raised = floorY !== null ? surfaceY - floorY >= RAISED_ABOVE_FLOOR : phoneY - surfaceY < FLOOR_BELOW_PHONE;
  return raised ? FIGURINE_HEIGHT : FLOOR_HEIGHT;
}

/** Each buddy says something at most this often, in seconds... */
export const OWN_GAP = 24;
/** ...never within this long of the other one... */
export const PAIR_GAP = 6;
/** ...and only once it has been in view this long, so it talks when you turn to look at it. */
export const SEEN_FOR = 0.7;

/**
 * Who speaks next at the booth. Each buddy talks when you turn the phone to it, then at most
 * every OWN_GAP seconds while it stays in view, never talking over the other.
 */
export class BoothChatter {
  private readonly lastSaid: Record<BuddyColor, number> = { blue: -Infinity, pink: -Infinity };
  private readonly seenSince: Record<BuddyColor, number | null> = { blue: null, pink: null };
  private lastAny = -Infinity;

  /**
   * Call every frame with which buddies are on screen and whether the voice is busy; returns
   * the buddy that should speak now, if any.
   */
  update(now: number, inView: Record<BuddyColor, boolean>, busy: boolean): BuddyColor | null {
    for (const color of BUDDY_COLORS) {
      if (!inView[color]) this.seenSince[color] = null;
      else this.seenSince[color] ??= now;
    }
    if (busy || now - this.lastAny < PAIR_GAP) return null;
    // The one that's waited longest goes first.
    const ready = BUDDY_COLORS.filter(color => {
      const since = this.seenSince[color];
      return since !== null && now - since >= SEEN_FOR && now - this.lastSaid[color] >= OWN_GAP;
    }).sort((a, b) => this.lastSaid[a] - this.lastSaid[b]);
    const speaker = ready[0] ?? null;
    if (speaker) {
      this.lastSaid[speaker] = now;
      this.lastAny = now;
    }
    return speaker;
  }

  reset() {
    this.lastSaid.blue = this.lastSaid.pink = -Infinity;
    this.seenSince.blue = this.seenSince.pink = null;
    this.lastAny = -Infinity;
  }
}
