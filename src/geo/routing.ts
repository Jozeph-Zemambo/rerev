import { destination, distanceMetres, type LatLon } from './geo';

/** OpenStreetMap walking routes (FOSSGIS public OSRM server; browser requests allowed). */
const FOOT_ROUTER = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
/** Open-Meteo elevation (Copernicus 90 m terrain model), up to 100 points per request. */
const ELEVATION = 'https://api.open-meteo.com/v1/elevation';

export type TurnStep = {
  at: LatLon;
  /** e.g. "turn", "depart", "arrive", "end of road". */
  type: string;
  /** e.g. "left", "slight right", "straight". */
  modifier: string;
  street: string;
  /** Distance from the start of the route to this step, metres. */
  fromStart: number;
};

export type PlannedRoute = {
  points: LatLon[];
  distance: number;
  steps: TurnStep[];
  /** Ground elevation (m above sea level) at evenly spaced distances along the route. */
  elevation: { at: number; metres: number }[];
  climb: number;
};

type OsrmStep = { distance: number; name: string; maneuver: { type: string; modifier?: string; location: [number, number] } };
type OsrmResponse = {
  code: string;
  message?: string;
  routes?: { distance: number; geometry: { coordinates: [number, number][] }; legs: { steps: OsrmStep[] }[] }[];
};

/** A walking route through the given waypoints, with turn steps and an elevation profile. */
export async function planRoute(waypoints: LatLon[], signal?: AbortSignal): Promise<PlannedRoute> {
  return withElevation(await walkingRoute(waypoints, signal), signal);
}

export type WalkingRoute = Omit<PlannedRoute, 'elevation' | 'climb'>;

/** OSRM's walking route through the waypoints, without the elevation profile. */
export async function walkingRoute(waypoints: LatLon[], signal?: AbortSignal): Promise<WalkingRoute> {
  const coords = waypoints.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const response = await fetch(`${FOOT_ROUTER}/${coords}?overview=full&geometries=geojson&steps=true`, { signal });
  if (!response.ok) throw new Error(`Route service returned ${response.status}`);
  const data = (await response.json()) as OsrmResponse;
  const route = data.routes?.[0];
  if (data.code !== 'Ok' || !route) throw new Error(data.message ?? 'No walking route found here');

  const points = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
  let travelled = 0;
  const steps: TurnStep[] = [];
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      const [lon, lat] = step.maneuver.location;
      steps.push({ at: { lat, lon }, type: step.maneuver.type, modifier: step.maneuver.modifier ?? '', street: step.name, fromStart: travelled });
      travelled += step.distance;
    }
  }
  return { points, distance: route.distance, steps };
}

/** Adds the elevation profile and total climb (none if the elevation service is down). */
export async function withElevation(route: WalkingRoute, signal?: AbortSignal): Promise<PlannedRoute> {
  const elevation = await fetchElevationProfile(route.points, signal).catch(() => []);
  let climb = 0;
  for (let i = 1; i < elevation.length; i++) climb += Math.max(0, elevation[i].metres - elevation[i - 1].metres);
  return { ...route, elevation, climb };
}

/** How much of the target the waypoint triangle's own perimeter is, before any tuning. */
const LOOP_FIRST_GUESS = 0.8;

/**
 * Waypoints for a rough loop of about `km` from a start, heading off along `bearing` first.
 * `stretch` scales the triangle: `planLoop` tunes it until the street route comes out right.
 */
export function loopWaypoints(start: LatLon, km: number, bearing: number, stretch = 1): LatLon[] {
  // Streets add detours, so aim the triangle a little short of the target distance.
  const side = (km * 1000 * LOOP_FIRST_GUESS * stretch) / 3;
  return [start, destination(start, bearing, side), destination(start, bearing + 60, side), start];
}

/** A loop within this fraction of the target distance is close enough. */
export const LOOP_TOLERANCE = 0.1;
/** Route requests per loop at most: the first guess plus re-plans. */
export const LOOP_MAX_TRIES = 4;

export type LoopTry = { stretch: number; distance: number };

/**
 * The next triangle stretch to try for a loop of `target` metres. Street distance grows roughly
 * in proportion to the triangle, so: a secant through the last two tries when they slope the
 * right way, otherwise a proportional rescale of the last one. Steps are capped so one odd
 * route (a river, a dead end) can't throw the loop across town.
 */
export function nextLoopStretch(tries: LoopTry[], target: number): number {
  const last = tries[tries.length - 1];
  let next = (last.stretch * target) / last.distance;
  const prev = tries[tries.length - 2];
  if (prev && prev.stretch !== last.stretch) {
    const slope = (last.distance - prev.distance) / (last.stretch - prev.stretch);
    if (slope > 0 && Number.isFinite(slope)) next = last.stretch + (target - last.distance) / slope;
  }
  const capped = Math.min(last.stretch * 2, Math.max(last.stretch * 0.5, next));
  return Math.min(3, Math.max(0.15, capped));
}

export const loopError = (distance: number, target: number) => Math.abs(distance - target) / target;

/**
 * Tries loop sizes one after another (never in parallel) until a route lands within the
 * tolerance of `target` metres, and returns the closest one. `attempt` plans the route for a
 * stretch; aborting its signal stops the search.
 */
export async function fitLoop<R extends { distance: number }>(
  target: number,
  attempt: (stretch: number) => Promise<R>,
  maxTries = LOOP_MAX_TRIES,
): Promise<{ route: R; tries: LoopTry[] }> {
  const tries: LoopTry[] = [];
  let best: R | null = null;
  let stretch = 1;
  for (let i = 0; i < maxTries; i++) {
    const route = await attempt(stretch);
    tries.push({ stretch, distance: route.distance });
    if (!best || loopError(route.distance, target) < loopError(best.distance, target)) best = route;
    if (loopError(route.distance, target) <= LOOP_TOLERANCE) break;
    const next = nextLoopStretch(tries, target);
    // The same triangle again would give the same streets.
    if (tries.some(t => Math.abs(t.stretch - next) < 0.01 * next)) break;
    stretch = next;
  }
  return { route: best!, tries };
}

/** A loop of about `km` from `start`, sized to the streets, with its elevation profile. */
export async function planLoop(start: LatLon, km: number, bearing: number, signal?: AbortSignal): Promise<PlannedRoute & { tries: LoopTry[] }> {
  const { route, tries } = await fitLoop(km * 1000, stretch => walkingRoute(loopWaypoints(start, km, bearing, stretch), signal));
  return { ...(await withElevation(route, signal)), tries };
}

async function fetchElevationProfile(points: LatLon[], signal?: AbortSignal) {
  const samples = sampleAlong(points, 100);
  const lat = samples.map(s => s.p.lat.toFixed(5)).join(',');
  const lon = samples.map(s => s.p.lon.toFixed(5)).join(',');
  const response = await fetch(`${ELEVATION}?latitude=${lat}&longitude=${lon}`, { signal });
  if (!response.ok) throw new Error(`Elevation service returned ${response.status}`);
  const { elevation } = (await response.json()) as { elevation: number[] };
  return samples.map((s, i) => ({ at: s.at, metres: elevation[i] }));
}

/** Up to `count` points evenly spaced along a polyline, with their distance from the start. */
function sampleAlong(points: LatLon[], count: number) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distanceMetres(points[i - 1], points[i]));
  const total = cumulative.at(-1) ?? 0;
  const n = Math.max(2, Math.min(count, Math.ceil(total / 20) + 1));
  const out: { at: number; p: LatLon }[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const at = (total * k) / (n - 1);
    while (j < points.length - 1 && cumulative[j] < at) j++;
    const span = cumulative[j] - cumulative[j - 1] || 1;
    const t = Math.min(1, Math.max(0, (at - cumulative[j - 1]) / span));
    const a = points[j - 1];
    const b = points[j];
    out.push({ at, p: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t } });
  }
  return out;
}
