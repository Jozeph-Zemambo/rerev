import type { TracePoint } from '../run/recorder';
import { formatPace } from '../hud';

const W = 320;
const PLOT_H = 120;
const AXIS_H = 18;
const LEFT = 30;
const RIGHT = 8;
const TOP = 8;
const SVG = 'http://www.w3.org/2000/svg';

export type Zone = { low: number; high: number };

/** Share of heart-rate readings inside the zone, or null without any readings. */
export function timeInZone(trace: readonly TracePoint[], zone: Zone): number | null {
  const readings = trace.filter(p => p.hr !== null);
  if (readings.length === 0) return null;
  return readings.filter(p => p.hr! >= zone.low && p.hr! <= zone.high).length / readings.length;
}

/**
 * Heart rate over the run against the target zone, with breathers shaded. Touch or hover for
 * the reading at a moment. Draws into `host` (replacing what was there).
 */
export function drawHeartChart(host: HTMLElement, trace: readonly TracePoint[], zone: Zone) {
  host.replaceChildren();
  const points = trace.filter(p => p.hr !== null);
  if (points.length < 2) return;

  const duration = Math.max(trace.at(-1)!.t, 1);
  const hrs = points.map(p => p.hr!);
  const lo = Math.floor((Math.min(zone.low, ...hrs) - 8) / 10) * 10;
  const hi = Math.ceil((Math.max(zone.high, ...hrs) + 8) / 10) * 10;
  const x = (t: number) => LEFT + ((W - LEFT - RIGHT) * t) / duration;
  const y = (bpm: number) => TOP + ((PLOT_H - TOP) * (hi - bpm)) / (hi - lo);

  const svg = el('svg', { viewBox: `0 0 ${W} ${PLOT_H + AXIS_H}`, class: 'hr-chart-svg', role: 'img' });
  svg.setAttribute('aria-label', `Heart rate over the run. Zone ${zone.low} to ${zone.high} bpm.`);

  // Breathers: shaded spans behind everything.
  let from: number | null = null;
  for (const [i, p] of trace.entries()) {
    if (p.breaking && from === null) from = p.t;
    const ends = from !== null && (!p.breaking || i === trace.length - 1);
    if (ends) {
      svg.append(el('rect', { x: x(from!), y: TOP, width: Math.max(2, x(p.t) - x(from!)), height: PLOT_H - TOP, class: 'hr-break' }));
      from = null;
    }
  }

  // Zone band with its edges labelled on the axis.
  svg.append(el('rect', { x: LEFT, y: y(zone.high), width: W - LEFT - RIGHT, height: y(zone.low) - y(zone.high), class: 'hr-zone' }));
  for (const bpm of [zone.low, zone.high]) {
    svg.append(el('line', { x1: LEFT, x2: W - RIGHT, y1: y(bpm), y2: y(bpm), class: 'hr-grid' }));
    svg.append(text(LEFT - 5, y(bpm) + 3.5, String(bpm), 'hr-tick end'));
  }
  svg.append(el('line', { x1: LEFT, x2: W - RIGHT, y1: PLOT_H, y2: PLOT_H, class: 'hr-axis' }));
  svg.append(text(LEFT, PLOT_H + 13, '0:00', 'hr-tick'));
  svg.append(text(W - RIGHT, PLOT_H + 13, clock(duration), 'hr-tick end'));

  // The heart-rate line. Gaps in the readings (watch dropped out) break the line.
  let d = '';
  let prev: TracePoint | null = null;
  for (const p of trace) {
    if (p.hr === null) {
      prev = null;
      continue;
    }
    d += `${prev ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.hr).toFixed(1)}`;
    prev = p;
  }
  svg.append(el('path', { d, class: 'hr-line' }));

  // Touch/hover readout: a crosshair plus a small label.
  const cross = el('line', { y1: TOP, y2: PLOT_H, class: 'hr-cross', visibility: 'hidden' });
  const dot = el('circle', { r: 4.5, class: 'hr-dot', visibility: 'hidden' });
  svg.append(cross, dot);
  const tip = document.createElement('div');
  tip.className = 'hr-tip';
  tip.hidden = true;

  const inspect = (event: PointerEvent) => {
    const box = svg.getBoundingClientRect();
    const t = (((event.clientX - box.left) / box.width) * W - LEFT) / ((W - LEFT - RIGHT) / duration);
    let nearest = points[0];
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(nearest.t - t)) nearest = p;
    const px = x(nearest.t);
    cross.setAttribute('x1', String(px));
    cross.setAttribute('x2', String(px));
    dot.setAttribute('cx', String(px));
    dot.setAttribute('cy', String(y(nearest.hr!)));
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    const pace = formatPace(nearest.pace);
    tip.textContent = `${clock(nearest.t)} · ${Math.round(nearest.hr!)} bpm${nearest.breaking ? ' · breather' : pace === '--' ? '' : ` · ${pace} /km`}`;
    tip.hidden = false;
    // Keep the label inside the chart, whatever its width.
    const half = tip.offsetWidth / 2 / box.width;
    tip.style.left = `${Math.min(Math.max(px / W, half), 1 - half) * 100}%`;
  };
  const clear = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  svg.addEventListener('pointerdown', inspect);
  svg.addEventListener('pointermove', inspect);
  svg.addEventListener('pointerleave', clear);
  svg.addEventListener('pointerup', event => event.pointerType !== 'mouse' && clear());

  host.append(svg, tip);
}

function el(name: string, attrs: Record<string, string | number>) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function text(x: number, y: number, content: string, className: string) {
  const node = el('text', { x, y, class: className });
  node.textContent = content;
  return node;
}

function clock(seconds: number) {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
