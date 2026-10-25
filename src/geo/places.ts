import type { LatLon } from './geo';

/** OpenStreetMap's place search. Usage policy: at most 1 request a second, no search-as-you-type. */
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
/** Half the size of the box results are biased towards, degrees (about 11 km north-south). */
const NEAR_LAT = 0.1;
const NEAR_LON = 0.15;
const MIN_GAP_MS = 1100;

export type Place = { name: string; detail: string; at: LatLon };

type NominatimResult = { lat: string; lon: string; name?: string; display_name?: string };

/** The search URL for `query`, preferring (not limited to) places near `near`. */
export function placeSearchUrl(query: string, near: LatLon, limit = 5): string {
  const viewbox = [near.lon - NEAR_LON, near.lat + NEAR_LAT, near.lon + NEAR_LON, near.lat - NEAR_LAT].map(v => v.toFixed(2)).join(',');
  const params = new URLSearchParams({ format: 'jsonv2', q: query.trim(), viewbox, bounded: '0', limit: String(limit) });
  return `${NOMINATIM}?${params}`;
}

/** Short labels for search results: the place's name, then a little of its address. */
export function parsePlaces(results: NominatimResult[]): Place[] {
  const places: Place[] = [];
  for (const r of results) {
    const at = { lat: Number(r.lat), lon: Number(r.lon) };
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;
    const parts = (r.display_name ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const name = r.name?.trim() || parts[0] || 'Unnamed place';
    const rest = parts.filter((p, i) => !(i === 0 && p === name));
    // A house number reads better glued to its street: "4825 Mount Royal Gate SW".
    if (/^\d+[a-z]?$/i.test(rest[0] ?? '') && rest[1]) rest.splice(0, 2, `${rest[0]} ${rest[1]}`);
    const detail = rest
      .filter(p => !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(p)) // Canadian postal codes
      .slice(0, 3)
      .join(', ');
    places.push({ name, detail, at });
  }
  return places;
}

/**
 * Place search that keeps to Nominatim's policy: one request at a time, at least a second
 * apart, and the same query is answered from memory.
 */
export class PlaceSearch {
  private lastRequestAt = -Infinity;
  private readonly cache = new Map<string, Place[]>();
  private readonly now: () => number;
  private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly fetcher: typeof fetch;

  constructor(options: { now?: () => number; wait?: (ms: number, signal?: AbortSignal) => Promise<void>; fetcher?: typeof fetch } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wait = options.wait ?? sleep;
    this.fetcher = options.fetcher ?? ((...args) => fetch(...args));
  }

  async search(query: string, near: LatLon, signal?: AbortSignal): Promise<Place[]> {
    const url = placeSearchUrl(query, near);
    // The viewbox is rounded to about a kilometre, so GPS wobble still hits the cache.
    const cached = this.cache.get(url);
    if (cached) return cached;
    // Book the next free slot before waiting, so overlapping searches queue up behind each other.
    const now = this.now();
    const slot = Math.max(now, this.lastRequestAt + MIN_GAP_MS);
    this.lastRequestAt = slot;
    if (slot > now) await this.wait(slot - now, signal);
    signal?.throwIfAborted();
    const response = await this.fetcher(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    const places = parsePlaces((await response.json()) as NominatimResult[]);
    this.cache.set(url, places);
    return places;
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
