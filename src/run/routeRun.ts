import { apply, GeoAligner, type ArPoint } from '../geo/alignment';
import { bearingDeg, LocalFrame, type Enu, type LatLon } from '../geo/geo';
import type { PlannedRoute } from '../geo/routing';
import type { Fix } from '../geo/sensors';
import type { RoutePoint } from '../world/path';

/** Refit the map-to-AR transform every few GPS fixes rather than on each one. */
const FIXES_PER_REFIT = 3;
/** Fixes worse than this are too vague to help. */
const MAX_ACCURACY = 25;
/** Show the next turn once it is this close. */
const TURN_HORIZON = 150;
/**
 * Routes are planned from where you stand, so the route's first point is usually under your
 * feet. If the first fix lands within about twice its own accuracy of it, the path starts at
 * you; further off (say you started in a park and the route begins on the road), the fix wins.
 */
const SNAP_WITHIN_ACCURACIES = 2;
const SNAP_MIN = 8;
/**
 * Someone running the route is on it to within a metre or two across it, which beats GPS. Each
 * fix also records how far to the side of the route the runner is (never how far along: that
 * is GPS's job). It straightens out compass error within the first few metres.
 */
const ROUTE_MATCH_ACCURACY = 3;
/** Further than this from the route the runner has probably left it, so no snapping. */
const ROUTE_MATCH_RANGE = 8;

export type NextTurn = { modifier: string; street: string; metres: number };

/** A planned map route being run in AR: anchors it to the world and keeps it anchored. */
export class RouteRun {
  readonly route: PlannedRoute;
  readonly frame: LocalFrame;
  readonly aligner = new GeoAligner();
  private readonly enu: Enu[];
  private readonly lengths: number[];
  private fixes = 0;

  constructor(route: PlannedRoute) {
    this.route = route;
    this.frame = new LocalFrame(route.points[0]);
    this.enu = route.points.map(p => this.frame.toEnu(p));
    this.lengths = [0];
    for (let i = 1; i < this.enu.length; i++) {
      this.lengths.push(this.lengths[i - 1] + Math.hypot(this.enu[i].e - this.enu[i - 1].e, this.enu[i].n - this.enu[i - 1].n));
    }
  }

  /** Direction the route sets off in, radians clockwise from north (fallback when there is no compass). */
  startHeading(): number {
    const start = this.route.points[0];
    const ahead = this.route.points.find((p, i) => i > 0 && distanceApprox(start, p) > 12) ?? this.route.points[1] ?? start;
    return (bearingDeg(start, ahead) * Math.PI) / 180;
  }

  /** Anchor the route using one GPS fix plus the direction the camera faces. */
  begin(fix: LatLon & { accuracy: number }, ar: ArPoint, headingRad: number, arForwardBearing: number) {
    const at = this.frame.toEnu(fix);
    const nearStart = Math.hypot(at.e, at.n) <= Math.max(SNAP_MIN, SNAP_WITHIN_ACCURACIES * fix.accuracy);
    this.aligner.initialise(nearStart ? { e: 0, n: 0 } : at, ar, headingRad, arForwardBearing);
    this.fixes = 0;
  }

  get anchored() {
    return this.aligner.transform !== null;
  }

  /** The route in AR coordinates, ready for Path.setRoute. */
  arPoints(): RoutePoint[] {
    const t = this.aligner.transform!;
    return this.enu.map(p => apply(t, p));
  }

  /**
   * Feed a GPS fix with where AR tracking says the phone is, and how far along the route the
   * runner is matched to. Returns true when the route moved.
   */
  addFix(fix: Fix, ar: ArPoint, runnerS?: number): boolean {
    if (!this.anchored || fix.accuracy > MAX_ACCURACY) return false;
    this.aligner.addFix(this.frame.toEnu(fix), ar, fix.accuracy, fix.time);
    if (runnerS !== undefined) this.matchToRoute(runnerS, ar, fix.time);
    this.fixes++;
    return this.fixes % FIXES_PER_REFIT === 0 && this.aligner.refit();
  }

  private matchToRoute(runnerS: number, ar: ArPoint, time: number) {
    const { point, along } = this.routeAt(runnerS);
    const shown = apply(this.aligner.transform!, point);
    if (Math.hypot(shown.x - ar.x, shown.z - ar.z) > ROUTE_MATCH_RANGE) return;
    this.aligner.addRouteMatch(point, along, ar, ROUTE_MATCH_ACCURACY, time);
  }

  /** Map position `s` metres along the route, and the direction the route runs there. */
  private routeAt(s: number): { point: Enu; along: Enu } {
    const L = this.lengths;
    let i = 1;
    while (i < L.length - 1 && L[i] < s) i++;
    const t = Math.min(1, Math.max(0, (s - L[i - 1]) / (L[i] - L[i - 1] || 1)));
    const a = this.enu[i - 1];
    const b = this.enu[i] ?? a;
    return { point: { e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t }, along: { e: b.e - a.e, n: b.n - a.n } };
  }

  /** The next turn ahead of `runnerS` metres along the route, if it is coming up soon. */
  nextTurn(runnerS: number): NextTurn | null {
    const step = this.route.steps.find(s => s.type !== 'depart' && s.fromStart > runnerS + 3);
    if (!step) return null;
    const metres = step.fromStart - runnerS;
    if (metres > TURN_HORIZON) return null;
    if (step.type === 'arrive') return { modifier: 'straight', street: 'the finish', metres };
    return { modifier: step.modifier, street: step.street, metres };
  }
}

function distanceApprox(a: LatLon, b: LatLon) {
  const dLat = (b.lat - a.lat) * 111_320;
  const dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}
