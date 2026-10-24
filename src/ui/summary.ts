import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import { formatSecondsPerKm } from '../hud';
import type { RunSummary, TracePoint } from '../run/recorder';
import { drawHeartChart, timeInZone, type Zone } from './heartChart';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatDistance(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(2)} km` : `${Math.round(metres)} m`;
}

export function formatDuration(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The end-of-run card: a full screen after AR, or a sheet over the camera view inside AR. */
export class SummaryScreen {
  onDone: () => void = () => {};
  private readonly screen = byId('summary');
  private readonly home = this.screen.parentElement!;

  constructor() {
    byId('summary-done').onclick = () => {
      this.screen.hidden = true;
      this.onDone();
    };
  }

  /**
   * Pass `overlay` (the AR DOM overlay root) to show it inside AR, where only the overlay is
   * visible, with Run again / New course / Exit instead of Back home.
   */
  show(summary: RunSummary, trace: readonly TracePoint[] = [], zone?: Zone, overlay?: HTMLElement) {
    const set = (id: string, text: string) => (byId(id).textContent = text);
    set('summary-title', summary.distance < 30 ? 'Good warm-up!' : summary.breaks === 0 ? 'Nonstop. Nice!' : 'Nice run!');
    set('sum-distance', formatDistance(summary.distance));
    set('sum-time', formatDuration(summary.duration));
    set('sum-pace', summary.distance > 20 ? `${formatSecondsPerKm((summary.duration / summary.distance) * 1000)} /km` : '–');
    set('sum-avg-hr', summary.avgHr ? `${Math.round(summary.avgHr)}` : '–');
    set('sum-max-hr', summary.maxHr ? `${Math.round(summary.maxHr)}` : '–');
    set('sum-breaks', String(summary.breaks));
    set('sum-stars', String(summary.stars));
    set('sum-coins', String(summary.coins));
    const inZone = zone ? timeInZone(trace, zone) : null;
    byId('sum-zone').hidden = inZone === null;
    if (zone && inZone !== null) {
      set('sum-zone-pct', `${Math.round(inZone * 100)}%`);
      set('sum-zone-range', `(${zone.low}–${zone.high} bpm)`);
      drawHeartChart(byId('sum-chart'), trace, zone);
    }
    if (this.screen.parentElement !== (overlay ?? this.home)) (overlay ?? this.home).appendChild(this.screen);
    this.screen.classList.toggle('in-ar', !!overlay);
    byId('summary-done').hidden = !!overlay;
    byId('summary-course').hidden = !overlay;
    this.screen.hidden = false;
    this.screen.querySelector('.home-inner')!.scrollTop = 0;
  }

  hide() {
    this.screen.hidden = true;
  }
}

/** Recent runs on the home screen, live from Convex. */
export function showRecentRuns(client: ConvexClient | null) {
  if (!client) return;
  const box = byId('recent');
  const list = byId('recent-list');
  client.onUpdate(api.runs.recent, {}, runs => {
    box.hidden = runs.length === 0;
    list.replaceChildren(
      ...runs.slice(0, 4).map(run => {
        const li = document.createElement('li');
        const when = new Date(run.startedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        const what = document.createElement('strong');
        what.textContent = `${formatDistance(run.summary.distance)} · ${formatDuration(run.summary.duration)}`;
        const meta = document.createElement('span');
        meta.textContent = `${when} · ★ ${run.summary.stars}`;
        li.append(what, meta);
        return li;
      }),
    );
  });
}
