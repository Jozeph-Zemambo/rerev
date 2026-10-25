import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { distanceMetres, MRU, type LatLon } from '../geo/geo';
import { PlaceSearch, type Place } from '../geo/places';
import { LOOP_TOLERANCE, loopError, planLoop, planRoute, type PlannedRoute } from '../geo/routing';
import type { Gps } from '../geo/sensors';
import { formatSecondsPerKm } from '../hud';
import { savedBuddy } from './buddyPicker';

export type RunGoal = {
  route: PlannedRoute;
  /** Goal pace in seconds per km. */
  paceSecondsPerKm: number;
  zone: { low: number; high: number };
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Wait this long after the last keystroke before searching (Nominatim: no search-as-you-type). */
const SEARCH_PAUSE_MS = 700;
const MIN_QUERY = 3;
/** Further than this is not a run. */
const MAX_TRIP_METRES = 25_000;

const BUDDY_NAMES = { blue: { name: 'Rev', they: 'he' }, pink: { name: 'Vita', they: 'she' } } as const;

/**
 * The trip planner, in two steps. First the route: a loop distance, or a place searched for or
 * tapped on the map, always from where you are. Then "Ready?": the route's distance, time and
 * climb, the goal pace and heart zone, and Start.
 */
export class Planner {
  onStart: (goal: RunGoal) => void = () => {};
  onBack: () => void = () => {};

  private readonly screen = byId('planner');
  private readonly status = byId('plan-status');
  private readonly summary = byId('plan-summary');
  private readonly nextButton = byId<HTMLButtonElement>('plan-next');
  private readonly startButton = byId<HTMLButtonElement>('start-run');
  private readonly paceInput = byId<HTMLInputElement>('pace');
  private readonly chooseSheet = byId('plan-choose');
  private readonly readySheet = byId('plan-ready');
  private readonly searchForm = byId<HTMLFormElement>('place-form');
  private readonly query = byId<HTMLInputElement>('place-query');
  private readonly clearButton = byId<HTMLButtonElement>('place-clear');
  private readonly panel = byId('place-panel');
  private readonly note = byId('place-note');
  private readonly results = byId<HTMLUListElement>('place-results');
  private map: L.Map | null = null;
  private routeLine: L.Polyline | null = null;
  private youMarker: L.Marker | null = null;
  private goalMarker: L.Marker | null = null;

  private step: 'choose' | 'ready' = 'choose';
  private mode: 'loop' | 'to' = 'loop';
  private loopKm = 2;
  private loopBearing = Math.random() * 360;
  private destination: { at: LatLon; name: string } | null = null;
  private start: LatLon = MRU;
  private haveFix = false;
  private zone = { low: 130, high: 160 };
  private route: PlannedRoute | null = null;
  private request: AbortController | null = null;
  private readonly gps: Gps;

  private readonly places = new PlaceSearch();
  private searchTimer = 0;
  private searchRequest: AbortController | null = null;
  private shownQuery = '';

  constructor(gps: Gps) {
    this.gps = gps;
    byId('planner-back').onclick = () => this.back();
    byId('mode-loop').onclick = () => this.setMode('loop');
    byId('mode-to').onclick = () => this.setMode('to');
    byId('loop-shuffle').onclick = () => {
      this.loopBearing = (this.loopBearing + 75 + Math.random() * 90) % 360;
      this.setMode('loop');
    };
    for (const chip of byId('loop-options').querySelectorAll<HTMLButtonElement>('[data-km]')) {
      chip.onclick = () => {
        this.loopKm = Number(chip.dataset.km);
        pressOnly(chip);
        this.setMode('loop');
      };
    }
    for (const chip of byId('zone-options').querySelectorAll<HTMLButtonElement>('[data-zone]')) {
      chip.onclick = () => {
        const [low, high] = chip.dataset.zone!.split('-').map(Number);
        this.zone = { low, high };
        pressOnly(chip);
        this.renderZone();
      };
    }
    this.paceInput.oninput = () => this.renderStats();
    this.nextButton.onclick = () => {
      if (this.route) this.showStep('ready');
    };
    this.startButton.onclick = () => {
      if (this.route) this.onStart({ route: this.route, paceSecondsPerKm: Number(this.paceInput.value), zone: { ...this.zone } });
    };
    this.wireSearch();
    this.renderStats();
    this.renderZone();
  }

  open() {
    this.screen.hidden = false;
    this.showStep('choose');
    this.renderZone();
    if (!this.map) this.createMap();
    this.map!.invalidateSize();
    this.gps.start();
    const fix = this.gps.latest;
    if (fix) this.useFix(fix);
    else {
      this.say('Finding where you are… (planning from Mount Royal University until GPS answers)');
      const stop = this.gps.onFix(f => {
        stop();
        this.useFix(f);
      });
      void this.replan();
    }
  }

  close() {
    this.screen.hidden = true;
    this.closePanel();
  }

  /** Back one step: the search suggestions, then "Ready?", then home. */
  private back() {
    if (!this.panel.hidden) this.closePanel();
    else if (this.step === 'ready') this.showStep('choose');
    else this.onBack();
  }

  private showStep(step: 'choose' | 'ready') {
    this.step = step;
    this.chooseSheet.hidden = step !== 'choose';
    this.readySheet.hidden = step !== 'ready';
    this.searchForm.hidden = step !== 'choose';
    if (step === 'ready') this.closePanel();
    this.byeKeyboard();
    this.renderStats();
    if (this.routeLine) this.fitRoute();
  }

  private createMap() {
    this.map = L.map('map', { zoomControl: false, attributionControl: true }).setView([this.start.lat, this.start.lon], 15);
    // OpenStreetMap's own tiles (CARTO's now need an API key). Warmed up in CSS to match the app.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.youMarker = L.marker([this.start.lat, this.start.lon], { icon: pin('you') }).addTo(this.map);
    this.map.on('click', event => {
      if (!this.panel.hidden) return this.closePanel();
      this.query.value = '';
      this.clearButton.hidden = true;
      this.setDestination({ lat: event.latlng.lat, lon: event.latlng.lng }, 'your pin');
    });
  }

  private useFix(fix: LatLon & { accuracy: number }) {
    if (this.haveFix && Math.abs(fix.lat - this.start.lat) + Math.abs(fix.lon - this.start.lon) < 0.0002) return;
    this.haveFix = true;
    this.start = { lat: fix.lat, lon: fix.lon };
    this.youMarker?.setLatLng([fix.lat, fix.lon]);
    if (!this.routeLine) this.map?.setView([fix.lat, fix.lon], 15);
    void this.replan();
  }

  private setMode(mode: 'loop' | 'to') {
    this.mode = mode;
    byId('mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
    byId('mode-to').setAttribute('aria-pressed', String(mode === 'to'));
    byId('loop-options').hidden = mode !== 'loop';
    this.goalMarker?.setOpacity(mode === 'to' ? 1 : 0);
    if (mode === 'to' && !this.destination) this.query.focus();
    void this.replan();
  }

  private setDestination(at: LatLon, name: string) {
    this.destination = { at, name };
    const latlng = L.latLng(at.lat, at.lon);
    this.goalMarker ??= L.marker(latlng, { icon: pin('goal') }).addTo(this.map!);
    this.goalMarker.setLatLng(latlng);
    if (this.step !== 'choose') this.showStep('choose');
    this.setMode('to');
  }

  private async replan() {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.route = null;
    this.nextButton.disabled = true;
    this.startButton.disabled = true;
    this.renderStats();

    const to = this.mode === 'to' ? this.destination : null;
    if (this.mode === 'to' && !to) {
      this.clearRoute();
      this.say('Search above, or tap the map where you want to run to.');
      return;
    }
    if (to && distanceMetres(this.start, to.at) > MAX_TRIP_METRES) {
      this.clearRoute();
      const km = Math.round(distanceMetres(this.start, to.at) / 1000);
      this.say(`That's ${km.toLocaleString()} km away, a bit far for a run. Try somewhere closer.`, true);
      return;
    }
    this.say(to ? `Finding a walking route to ${to.name}…` : `Finding a ${this.loopKm} km loop…`);
    try {
      const route = to ? await planRoute([this.start, to.at], request.signal) : await planLoop(this.start, this.loopKm, this.loopBearing, request.signal);
      if (request.signal.aborted) return;
      this.route = route;
      this.drawRoute(route.points);
      const offBy = to ? 0 : loopError(route.distance, this.loopKm * 1000);
      if (offBy > LOOP_TOLERANCE) this.say(`The streets here don't make a neat ${this.loopKm} km loop, so this is the closest. Shuffle (↻) to try another way.`);
      else this.say(this.haveFix ? 'Face the way the route starts when you set off.' : 'Planned from MRU for now: turn on location to start from where you are.');
      this.nextButton.disabled = false;
      this.startButton.disabled = false;
    } catch (error) {
      if (request.signal.aborted) return;
      this.clearRoute();
      const offline = !navigator.onLine;
      this.say(offline ? "You're offline, so there's no route to plan. Reconnect and try again." : `Couldn't plan that route: ${(error as Error).message}. Try another spot or distance.`, true);
    }
    this.renderStats();
  }

  private clearRoute() {
    this.route = null;
    this.routeLine?.remove();
    this.routeLine = null;
    this.renderStats();
  }

  private drawRoute(points: LatLon[]) {
    const latlngs = points.map(p => L.latLng(p.lat, p.lon));
    this.routeLine?.remove();
    this.routeLine = L.polyline(latlngs, { color: '#ff6f59', weight: 6, opacity: 0.9, lineCap: 'round' }).addTo(this.map!);
    this.fitRoute();
  }

  /** Frame the route in the bit of map the top bar and the sheet leave showing. */
  private fitRoute() {
    if (!this.map || !this.routeLine) return;
    const sheet = this.step === 'ready' ? this.readySheet : this.chooseSheet;
    const top = byId('planner').querySelector<HTMLElement>('.planner-top')!;
    // A zoom still animating from the last fit would swallow this one.
    this.map.stop();
    this.map.fitBounds(this.routeLine.getBounds(), {
      paddingTopLeft: [24, top.offsetTop + top.offsetHeight + 16],
      paddingBottomRight: [24, sheet.offsetHeight + 24],
      maxZoom: 17,
    });
  }

  private renderStats() {
    const pace = Number(this.paceInput.value);
    byId('pace-out').textContent = `${formatSecondsPerKm(pace)} /km`;
    const route = this.route;
    const km = route ? route.distance / 1000 : null;
    const distance = km === null ? '–' : `${km.toFixed(km < 10 ? 2 : 1)} km`;
    const minutes = km === null ? '–' : `${Math.max(1, Math.round((km * pace) / 60))} min`;
    const climb = route && route.elevation.length ? `${Math.round(route.climb)} m` : '–';
    byId('plan-distance').textContent = distance;
    byId('plan-time').textContent = minutes;
    byId('plan-climb').textContent = climb;

    this.summary.hidden = !route;
    if (route) {
      const what = this.mode === 'to' && this.destination ? `to ${this.destination.name}` : 'loop';
      const extra = [`about ${minutes}`, climb === '–' ? '' : `${climb} climb`].filter(Boolean).join(' · ');
      this.summary.replaceChildren(el('b', distance), ` ${what}`, el('span', extra));
    }
    const from = this.haveFix ? 'where you are' : 'Mount Royal University';
    byId('ready-route').textContent =
      this.mode === 'to' && this.destination ? `From ${from} to ${this.destination.name}` : `A ${this.loopKm} km loop from ${from}`;
  }

  private renderZone() {
    const buddy = BUDDY_NAMES[savedBuddy()] ?? BUDDY_NAMES.blue;
    const { low, high } = this.zone;
    byId('zone-explain').textContent = `${buddy.name} keeps you at ${low}–${high} bpm: if your heart goes above it, ${buddy.they}'ll suggest a breather.`;
    this.startButton.textContent = `Start with ${buddy.name}`;
  }

  private say(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }

  // ---------------------------------------------------------------- place search

  private wireSearch() {
    this.query.addEventListener('input', () => {
      const q = this.query.value.trim();
      this.clearButton.hidden = !this.query.value;
      clearTimeout(this.searchTimer);
      if (q.length < MIN_QUERY) {
        this.searchRequest?.abort();
        this.shownQuery = '';
        this.closePanel();
        return;
      }
      // Search after a pause in typing, never per keystroke.
      this.searchTimer = window.setTimeout(() => void this.search(q), SEARCH_PAUSE_MS);
    });
    this.searchForm.addEventListener('submit', event => {
      event.preventDefault();
      clearTimeout(this.searchTimer);
      const q = this.query.value.trim();
      if (q.length >= 2) void this.search(q);
    });
    this.query.addEventListener('focus', () => {
      if (this.shownQuery && this.shownQuery === this.query.value.trim()) this.panel.hidden = false;
    });
    this.query.addEventListener('keydown', event => {
      if (event.key === 'Escape') this.closePanel();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.results.querySelector('button')?.focus();
      }
    });
    this.results.addEventListener('keydown', event => {
      const buttons = [...this.results.querySelectorAll('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = at + (event.key === 'ArrowDown' ? 1 : -1);
        (next < 0 ? this.query : buttons[Math.min(next, buttons.length - 1)]).focus();
      }
      if (event.key === 'Escape') {
        this.closePanel();
        this.query.focus();
      }
    });
    this.clearButton.onclick = () => {
      this.query.value = '';
      this.clearButton.hidden = true;
      this.shownQuery = '';
      this.searchRequest?.abort();
      this.closePanel();
      this.query.focus();
    };
  }

  private async search(q: string) {
    if (q === this.shownQuery && this.results.childElementCount) {
      this.panel.hidden = false;
      return;
    }
    this.searchRequest?.abort();
    const request = new AbortController();
    this.searchRequest = request;
    this.panel.hidden = false;
    this.results.replaceChildren();
    if (!navigator.onLine) return this.showNote("You're offline. Tap the map to pick a spot instead.", true);
    this.showNote('Searching…');
    try {
      const places = await this.places.search(q, this.start, request.signal);
      if (request.signal.aborted) return;
      this.shownQuery = q;
      if (!places.length) return this.showNote(`Nothing called “${q}” near here. Try another name, or tap the map.`);
      this.showNote('');
      this.results.replaceChildren(...places.map(place => this.resultItem(place)));
    } catch {
      if (request.signal.aborted) return;
      this.showNote(navigator.onLine ? "Search isn't answering right now. Tap the map to pick a spot instead." : "You're offline. Tap the map to pick a spot instead.", true);
    }
  }

  private resultItem(place: Place) {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const away = distanceMetres(this.start, place.at);
    const text = el('span', '');
    text.className = 'place-text';
    text.append(el('b', place.name), el('small', place.detail));
    const distance = el('span', away < 1000 ? `${Math.round(away / 10) * 10} m` : `${(away / 1000).toFixed(away < 10_000 ? 1 : 0)} km`);
    distance.className = 'place-away';
    button.append(text, distance);
    button.onclick = () => {
      this.query.value = place.name;
      this.clearButton.hidden = false;
      // Picked: focusing the box again shouldn't reopen an empty list.
      this.shownQuery = '';
      this.results.replaceChildren();
      this.closePanel();
      this.byeKeyboard();
      this.setDestination(place.at, place.name);
    };
    const item = document.createElement('li');
    item.append(button);
    return item;
  }

  private showNote(text: string, error = false) {
    this.note.textContent = text;
    this.note.hidden = !text;
    this.note.classList.toggle('error', error);
  }

  private closePanel() {
    this.panel.hidden = true;
  }

  /** Drop focus from the search box so the phone keyboard gets out of the way. */
  private byeKeyboard() {
    if (document.activeElement instanceof HTMLElement && this.screen.contains(document.activeElement)) document.activeElement.blur();
  }
}

function el(tag: string, text: string) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function pressOnly(chip: HTMLButtonElement) {
  chip.parentElement?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === chip)));
}

function pin(kind: 'you' | 'goal') {
  return L.divIcon({ className: '', html: `<div class="pin ${kind}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
