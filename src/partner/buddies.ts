/**
 * Who the two buddies are. No imports, so tests and any module can read it.
 *
 * The colour is what's saved (localStorage `rerev.buddy`) and picks the model file; the name is
 * what people see.
 */
export type BuddyColor = 'blue' | 'pink';
export const BUDDY_COLORS: BuddyColor[] = ['blue', 'pink'];

export const BUDDY_NAMES: Record<BuddyColor, string> = { blue: 'Rev', pink: 'Vita' };

/** Vita speaks a little higher than Rev, with the same phone voice. */
export const BUDDY_PITCH: Record<BuddyColor, number> = { blue: 1.15, pink: 1.45 };
