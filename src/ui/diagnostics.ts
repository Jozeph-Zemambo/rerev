import { FIELD_TEST } from '../debug/fieldLog';

const LONG_PRESS = 0.7;
const REDRAW_EVERY = 0.25;

/**
 * A small readout of what the sensors are doing, for testing on a real phone: is depth coming
 * in, how good is GPS, is the compass live, how well does the route fit. Open it with `?debug`
 * in the URL or a long press on the "Buddy" stat.
 */
export class Diagnostics {
  private readonly el = document.getElementById('diag')!;
  private visible = new URLSearchParams(location.search).has('debug') || FIELD_TEST;
  private lastDraw = 0;
  private frames = 0;
  private fpsFrom = 0;
  private fps = 0;

  constructor(trigger: HTMLElement) {
    let timer: number | undefined;
    const cancel = () => clearTimeout(timer);
    trigger.addEventListener('pointerdown', () => {
      cancel();
      timer = window.setTimeout(() => this.toggle(), LONG_PRESS * 1000);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) trigger.addEventListener(type, cancel);
    trigger.addEventListener('contextmenu', event => event.preventDefault());
    this.el.hidden = !this.visible;
  }

  toggle() {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
  }

  /** Count a frame; true when the readout should be redrawn (so callers only gather stats then). */
  due(now: number): boolean {
    this.frames++;
    if (now - this.fpsFrom >= 1) {
      this.fps = this.frames / (now - this.fpsFrom);
      this.frames = 0;
      this.fpsFrom = now;
    }
    if (!this.visible || now - this.lastDraw < REDRAW_EVERY) return false;
    this.lastDraw = now;
    return true;
  }

  show(rows: [label: string, value: string][]) {
    const lines = [['fps', this.fps.toFixed(0)], ...rows].map(([label, value]) => `${label.padEnd(8)} ${value}`);
    this.el.textContent = lines.join('\n');
  }
}
