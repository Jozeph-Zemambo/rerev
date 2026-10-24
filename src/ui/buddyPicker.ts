import { BUDDY_COLORS, type BuddyColor } from '../partner/mascot';

const KEY = 'rerev.buddy';

/** The buddy picked last time (blue the first time, or if storage is off). */
export function savedBuddy(): BuddyColor {
  try {
    const saved = localStorage.getItem(KEY);
    if (BUDDY_COLORS.includes(saved as BuddyColor)) return saved as BuddyColor;
  } catch {
    // Storage blocked (private mode, settings): just use the default.
  }
  return 'blue';
}

/** Wire up the buddy chooser on the home screen; `onPick` gets each new choice. */
export function setupBuddyPicker(root: HTMLElement, current: BuddyColor, onPick: (color: BuddyColor) => void) {
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-buddy]')];
  const show = (color: BuddyColor) => {
    for (const b of buttons) {
      b.setAttribute('aria-checked', String(b.dataset.buddy === color));
      b.tabIndex = b.dataset.buddy === color ? 0 : -1;
    }
  };
  show(current);
  for (const button of buttons) {
    button.onclick = () => {
      const color = button.dataset.buddy as BuddyColor;
      // A little hop from the one you picked, even if it was already picked.
      button.classList.remove('picked');
      void button.offsetWidth;
      button.classList.add('picked');
      if (color === current) return;
      current = color;
      show(color);
      try {
        localStorage.setItem(KEY, color);
      } catch {
        // Not remembered, but still used for this visit.
      }
      onPick(color);
    };
  }
  // Arrow keys move between the two, like any radio group.
  root.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const at = buttons.findIndex(b => b.dataset.buddy === current);
    const next = buttons[(at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? buttons.length - 1 : 1)) % buttons.length];
    next.focus();
    next.click();
  });
}
