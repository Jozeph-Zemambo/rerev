export type LatLon = { lat: number; lon: number };
/** East/north metres from a local origin. */
export type Enu = { e: number; n: number };

const EARTH_RADIUS = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Mount Royal University, used when GPS is not available yet. */
export const MRU: LatLon = { lat: 51.0115, lon: -114.1317 };

/**
 * Flat east/north metres around an origin. Accurate to centimetres over the few kilometres a
 * run covers, which is all ReReV needs.
 */
export class LocalFrame {
  readonly origin: LatLon;
  private readonly metresPerDegLat: number;
  private readonly metresPerDegLon: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    this.metresPerDegLat = toRad(1) * EARTH_RADIUS;
    this.metresPerDegLon = toRad(1) * EARTH_RADIUS * Math.cos(toRad(origin.lat));
  }

  toEnu(p: LatLon): Enu {
    return { e: (p.lon - this.origin.lon) * this.metresPerDegLon, n: (p.lat - this.origin.lat) * this.metresPerDegLat };
  }

  toLatLon(p: Enu): LatLon {
    return { lat: this.origin.lat + p.n / this.metresPerDegLat, lon: this.origin.lon + p.e / this.metresPerDegLon };
  }
}

export function distanceMetres(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `metres` away from `from` along `bearing` degrees. */
export function destination(from: LatLon, bearing: number, metres: number): LatLon {
  const d = metres / EARTH_RADIUS;
  const b = toRad(bearing);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 = lon1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: toDeg(lat2), lon: toDeg(lon2) };
}

export function pathLength(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceMetres(points[i - 1], points[i]);
  return total;
}
