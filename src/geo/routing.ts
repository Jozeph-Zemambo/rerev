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

/**
 * How much of the target the waypoint triangle's own perimeter is, before any tuning. Street
 * routes around MRU came out about 1.25x the triangle (1-5 km loops, three bearings each).
 */
const LOOP_FIRST_GUESS = 0.65;

/**
 * Waypoints for a rough loop of about `km` from a start, heading off along `bearing` first.
 * `stretch` scales the triangle: `planLoop` tunes it until the street route comes out right.
 */
export function loopWaypoints(start: LatLon, km: number, bearing: number, stretch = 1): LatLon[] {
  const side = (km * 1000 * LOOP_FIRST_GUESS * stretch) / 3;
  return [start, destination(start, bearing, side), destination(start, bearing + 60, side), start];
}

/** A loop within this fraction of the target distance is close enough. */
export const LOOP_TOLERANCE = 0.1;
/** Route requests per loop at most: the first guess plus re-plans. */
export const LOOP_MAX_TRIES = 4;
/** When resizing can't hit the distance, turn the loop this much (degrees) to find other streets. */
const LOOP_TURNS = [0, 25, -25];
/** Resizing barely changed the route (below) or changed it far more than the resize (above). */
const LOOP_FLAT = 0.2;
const LOOP_JUMP = 1.8;

/** A loop's shape: its size relative to the first guess, and its turn off the chosen bearing. */
export type LoopShape = { stretch: number; turn: number };
export type LoopTry = LoopShape & { distance: number };

export const loopError = (distance: number, target: number) => Math.abs(distance - target) / target;
const closest = (tries: LoopTry[], target: number) =>
  tries.reduce((best, t) => (loopError(t.distance, target) < loopError(best.distance, target) ? t : best));
const clampStretch = (stretch: number, around: number) => Math.min(3, Math.max(0.15, Math.min(around * 2, Math.max(around * 0.5, stretch))));

/**
 * The next loop shape to try for a loop of `target` metres, or null when nothing is left to try.
 *
 * Street distance grows roughly in line with the triangle, plus a fixed bit to reach the first
 * street. So: rescale the closest try in proportion, then once there are two tries, follow the
 * line through them (between them, when they sit either side of the target). Streets also jump:
 * a slightly bigger triangle can snap onto a road across a creek, or several sizes can all snap
 * to the same streets. Then resizing is hopeless, so turn the loop a little to find other streets.
 */
export function nextLoopShape(tries: LoopTry[], target: number): LoopShape | null {
  const turn = tries[tries.length - 1].turn;
  const same = tries.filter(t => t.turn === turn);
  const best = closest(same, target);
  const proportional = (best.stretch * target) / best.distance;
  let stretch = proportional;
  let stuck = false;
  const under = same.filter(t => t.distance < target).sort((a, b) => b.stretch - a.stretch)[0];
  const over = same.filter(t => t.distance > target).sort((a, b) => a.stretch - b.stretch)[0];
  const bracketed = !!under && !!over;
  const [p, q] = bracketed ? [under, over] : [...same].sort((a, b) => loopError(a.distance, target) - loopError(b.distance, target));
  if (p && q && p.stretch !== q.stretch) {
    // How many percent the route changed per percent of resize: about 1 on a regular street grid.
    const elasticity = (q.distance - p.distance) / (q.distance + p.distance) / ((q.stretch - p.stretch) / (q.stretch + p.stretch));
    if (elasticity < LOOP_FLAT || elasticity > LOOP_JUMP) stuck = true;
    else {
      const secant = p.stretch + ((target - p.distance) * (q.stretch - p.stretch)) / (q.distance - p.distance);
      // Off the end of the line, go no more than twice as far as a plain rescale would.
      const room = 2 * Math.abs(proportional - best.stretch);
      stretch = bracketed ? secant : Math.min(best.stretch + room, Math.max(best.stretch - room, secant));
    }
  }
  stretch = clampStretch(stretch, best.stretch);
  if (!stuck && !same.some(t => Math.abs(t.stretch - stretch) < 0.03 * stretch)) return { stretch, turn };

  const nextTurn = LOOP_TURNS[LOOP_TURNS.indexOf(turn) + 1];
  if (nextTurn === undefined) return null;
  const overall = closest(tries, target);
  return { stretch: clampStretch((overall.stretch * target) / overall.distance, overall.stretch), turn: nextTurn };
}

/**
 * Tries loop shapes one after another (never in parallel) until a route lands within the
 * tolerance of `target` metres, and returns the closest one. `attempt` plans the route for a
 * shape; aborting its signal stops the search.
 */
export async function fitLoop<R extends { distance: number }>(
  target: number,
  attempt: (shape: LoopShape) => Promise<R>,
  maxTries = LOOP_MAX_TRIES,
): Promise<{ route: R; tries: LoopTry[] }> {
  const tries: LoopTry[] = [];
  let best: R | null = null;
  let shape: LoopShape | null = { stretch: 1, turn: 0 };
  while (shape && tries.length < maxTries) {
    let route: R;
    try {
      route = await attempt(shape);
    } catch (error) {
      // A shape with no route ends the search, but a loop found earlier still stands.
      if (!best || (error as Error).name === 'AbortError') throw error;
      break;
    }
    tries.push({ ...shape, distance: route.distance });
    if (!best || loopError(route.distance, target) < loopError(best.distance, target)) best = route;
    if (loopError(route.distance, target) <= LOOP_TOLERANCE) break;
    shape = nextLoopShape(tries, target);
  }
  return { route: best!, tries };
}

/** A loop of about `km` from `start`, sized to the streets, with its elevation profile. */
export async function planLoop(start: LatLon, km: number, bearing: number, signal?: AbortSignal): Promise<PlannedRoute & { tries: LoopTry[] }> {
  const { route, tries } = await fitLoop(km * 1000, ({ stretch, turn }) => walkingRoute(loopWaypoints(start, km, bearing + turn, stretch), signal));
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
