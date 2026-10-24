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
 * Routes are planned from where you stand, so at the start the route's first point is under
 * your feet. A first GPS fix this close to it is trusted less than that: the path starts at you.
 */
const SNAP_TO_START = 40;

export type NextTurn = { modifier: string; street: string; metres: number };

/** A planned map route being run in AR: anchors it to the world and keeps it anchored. */
export class RouteRun {
  readonly route: PlannedRoute;
  readonly frame: LocalFrame;
  readonly aligner = new GeoAligner();
  private readonly enu: Enu[];
  private fixes = 0;

  constructor(route: PlannedRoute) {
    this.route = route;
    this.frame = new LocalFrame(route.points[0]);
    this.enu = route.points.map(p => this.frame.toEnu(p));
  }

  /** Direction the route sets off in, radians clockwise from north (fallback when there is no compass). */
  startHeading(): number {
    const start = this.route.points[0];
    const ahead = this.route.points.find((p, i) => i > 0 && distanceApprox(start, p) > 12) ?? this.route.points[1] ?? start;
    return (bearingDeg(start, ahead) * Math.PI) / 180;
  }

  /** Anchor the route using one GPS fix plus the direction the camera faces. */
  begin(fix: LatLon, ar: ArPoint, headingRad: number, arForwardBearing: number) {
    const at = this.frame.toEnu(fix);
    const nearStart = Math.hypot(at.e, at.n) < SNAP_TO_START;
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

  /** Feed a GPS fix with where AR tracking says the phone is. Returns true when the route moved. */
  addFix(fix: Fix, ar: ArPoint): boolean {
    if (!this.anchored || fix.accuracy > MAX_ACCURACY) return false;
    this.aligner.addFix(this.frame.toEnu(fix), ar, fix.accuracy, fix.time);
    this.fixes++;
    return this.fixes % FIXES_PER_REFIT === 0 && this.aligner.refit();
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
