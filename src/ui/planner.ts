import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { MRU, type LatLon } from '../geo/geo';
import { loopWaypoints, planRoute, type PlannedRoute } from '../geo/routing';
import type { Gps } from '../geo/sensors';
import { formatSecondsPerKm } from '../hud';

export type RunGoal = {
  route: PlannedRoute;
  /** Goal pace in seconds per km. */
  paceSecondsPerKm: number;
  zone: { low: number; high: number };
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The trip planner: a map, a loop distance or a tap-to-go destination, the planned walking
 * route with its distance, time and climb, and the goal pace and heart-rate zone.
 */
export class Planner {
  onStart: (goal: RunGoal) => void = () => {};
  onBack: () => void = () => {};

  private readonly screen = byId('planner');
  private readonly status = byId('plan-status');
  private readonly startButton = byId<HTMLButtonElement>('start-run');
  private readonly paceInput = byId<HTMLInputElement>('pace');
  private map: L.Map | null = null;
  private routeLine: L.Polyline | null = null;
  private youMarker: L.Marker | null = null;
  private goalMarker: L.Marker | null = null;

  private mode: 'loop' | 'to' = 'loop';
  private loopKm = 2;
  private loopBearing = Math.random() * 360;
  private destination: LatLon | null = null;
  private start: LatLon = MRU;
  private haveFix = false;
  private zone = { low: 130, high: 160 };
  private route: PlannedRoute | null = null;
  private request: AbortController | null = null;
  private readonly gps: Gps;

  constructor(gps: Gps) {
    this.gps = gps;
    byId('planner-back').onclick = () => this.onBack();
    byId('mode-loop').onclick = () => this.setMode('loop');
    byId('mode-to').onclick = () => this.setMode('to');
    byId('loop-shuffle').onclick = () => {
      this.loopBearing = (this.loopBearing + 75 + Math.random() * 90) % 360;
      void this.replan();
    };
    for (const chip of byId('loop-options').querySelectorAll<HTMLButtonElement>('[data-km]')) {
      chip.onclick = () => {
        this.loopKm = Number(chip.dataset.km);
        pressOnly(chip);
        void this.replan();
      };
    }
    for (const chip of byId('zone-options').querySelectorAll<HTMLButtonElement>('[data-zone]')) {
      chip.onclick = () => {
        const [low, high] = chip.dataset.zone!.split('-').map(Number);
        this.zone = { low, high };
        pressOnly(chip);
      };
    }
    this.paceInput.oninput = () => this.renderStats();
    this.startButton.onclick = () => {
      if (this.route) this.onStart({ route: this.route, paceSecondsPerKm: Number(this.paceInput.value), zone: { ...this.zone } });
    };
    this.renderStats();
  }

  open() {
    this.screen.hidden = false;
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
      if (this.mode !== 'to') this.setMode('to');
      this.destination = { lat: event.latlng.lat, lon: event.latlng.lng };
      this.goalMarker ??= L.marker(event.latlng, { icon: pin('goal') }).addTo(this.map!);
      this.goalMarker.setLatLng(event.latlng);
      void this.replan();
    });
  }

  private useFix(fix: LatLon & { accuracy: number }) {
    if (this.haveFix && Math.abs(fix.lat - this.start.lat) + Math.abs(fix.lon - this.start.lon) < 0.0002) return;
    this.haveFix = true;
    this.start = { lat: fix.lat, lon: fix.lon };
    this.youMarker?.setLatLng([fix.lat, fix.lon]);
    this.map?.setView([fix.lat, fix.lon], 15);
    void this.replan();
  }

  private setMode(mode: 'loop' | 'to') {
    this.mode = mode;
    byId('mode-loop').setAttribute('aria-pressed', String(mode === 'loop'));
    byId('mode-to').setAttribute('aria-pressed', String(mode === 'to'));
    byId('loop-options').hidden = mode !== 'loop';
    byId('to-hint').hidden = mode !== 'to';
    this.goalMarker?.setOpacity(mode === 'to' ? 1 : 0);
    void this.replan();
  }

  private async replan() {
    const waypoints =
      this.mode === 'loop' ? loopWaypoints(this.start, this.loopKm, this.loopBearing) : this.destination ? [this.start, this.destination] : null;
    if (!waypoints) {
      this.route = null;
      this.routeLine?.remove();
      this.startButton.disabled = true;
      this.renderStats();
      this.say('Tap the map where you want to run to.');
      return;
    }
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.say('Finding a walking route…');
    this.startButton.disabled = true;
    try {
      const route = await planRoute(waypoints, request.signal);
      if (request.signal.aborted) return;
      this.route = route;
      this.drawRoute(route.points);
      this.say(this.haveFix ? 'Looks good? Face the way the route starts, then press Start.' : 'Planned from MRU. Turn on location to plan from where you are.');
      this.startButton.disabled = false;
    } catch (error) {
      if (request.signal.aborted) return;
      this.route = null;
      this.routeLine?.remove();
      this.say(`Couldn't plan that route: ${(error as Error).message}. Try another spot or distance.`, true);
    }
    this.renderStats();
  }

  private drawRoute(points: LatLon[]) {
    const latlngs = points.map(p => L.latLng(p.lat, p.lon));
    this.routeLine?.remove();
    this.routeLine = L.polyline(latlngs, { color: '#ff6f59', weight: 6, opacity: 0.9, lineCap: 'round' }).addTo(this.map!);
    this.map!.fitBounds(this.routeLine.getBounds(), { paddingTopLeft: [20, 70], paddingBottomRight: [20, Math.round(innerHeight * 0.6)] });
  }

  private renderStats() {
    const pace = Number(this.paceInput.value);
    byId('pace-out').textContent = `${formatSecondsPerKm(pace)} /km`;
    const km = this.route ? this.route.distance / 1000 : null;
    byId('plan-distance').textContent = km === null ? '–' : `${km.toFixed(km < 10 ? 2 : 1)} km`;
    byId('plan-time').textContent = km === null ? '–' : `${Math.round((km * pace) / 60)} min`;
    byId('plan-climb').textContent = this.route && this.route.elevation.length ? `${Math.round(this.route.climb)} m` : '–';
  }

  private say(text: string, error = false) {
    this.status.textContent = text;
    this.status.classList.toggle('error', error);
  }
}

function pressOnly(chip: HTMLButtonElement) {
  chip.parentElement?.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === chip)));
}

function pin(kind: 'you' | 'goal') {
  return L.divIcon({ className: '', html: `<div class="pin ${kind}"></div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
}
