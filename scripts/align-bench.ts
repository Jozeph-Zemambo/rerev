/**
 * Headless check of map-route alignment: a simulated runner follows the real route while the app
 * only knows it through a wrong compass and noisy GPS. Reports how far the drawn route sits from
 * the runner, with and without matching the runner to the route.
 *
 *   npm run bench:align
 */
import * as THREE from 'three';
import { RouteRun } from '../src/run/routeRun';
import { Path } from '../src/world/path';
import { apply, arBearing } from '../src/geo/alignment';
import { LocalFrame, MRU, type Enu } from '../src/geo/geo';

const ROUTES: Record<string, Enu[]> = {
  // Start spur, then legs ~3 m apart running back alongside each other (out-and-back street).
  zigzag: [{ e: 0, n: 0 }, { e: -2, n: -1.9 }, { e: -14, n: 10 }, { e: -16, n: 8 }, { e: -4, n: -4 }, { e: 20, n: -4 }, { e: 20, n: 60 }, { e: 60, n: 60 }],
  block: [{ e: 0, n: 0 }, { e: 0, n: 80 }, { e: 120, n: 80 }, { e: 120, n: 0 }, { e: 0, n: 0 }],
  diagonal: [{ e: 0, n: 0 }, { e: 50, n: 50 }, { e: 50, n: 120 }, { e: -20, n: 160 }],
};

function lengths(pts: { x: number; z: number }[]) { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z)); return L; }
function at(pts: { x: number; z: number }[], L: number[], s: number) { let i = 1; while (i < L.length - 1 && L[i] < s) i++; const t = Math.min(1, Math.max(0, (s - L[i - 1]) / (L[i] - L[i - 1] || 1))); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t }; }

function run(enu: Enu[], seed: number, matching: boolean, compassErrDeg: number) {
  let sd = seed * 7919 + 104729;
  const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
  const frame = new LocalFrame(MRU);
  const route = { points: enu.map(p => frame.toLatLon(p)), distance: 0, steps: [], elevation: [], climb: 0 };
  const rr = new RouteRun(route as never);
  const truthT = { theta: 0.6, tx: 3, tz: -2 };
  const truth = enu.map(p => apply(truthT, p));
  const L = lengths(truth);
  const total = L.at(-1)!;
  route.distance = total;
  const start = truth[0];
  const ahead = at(truth, L, 8);
  const noisy = (p: Enu) => ({ e: p.e + gauss() * 4, n: p.n + gauss() * 4 });
  rr.begin(frame.toLatLon(noisy(enu[0])), start, rr.startHeading() + (compassErrDeg * Math.PI) / 180, arBearing(ahead.x - start.x, ahead.z - start.z));
  const path = new Path();
  path.setRoute(rr.arPoints(), 0);
  const pos = new THREE.Vector3();
  const offs: number[] = [];
  const marks: Record<number, number> = {};
  let maxOff = 0, wrongS = 0;
  for (let t = 1; t * 2.7 < total; t++) {
    const s = t * 2.7;
    const me = at(truth, L, s);
    pos.set(me.x, 1.5, me.z);
    const truthEnu = { e: 0, n: 0 };
    // invert truth transform for the GPS reading
    const c = Math.cos(truthT.theta), sn = Math.sin(truthT.theta);
    const x = me.x - truthT.tx, z = me.z - truthT.tz;
    const bx = c * x - sn * z, bz = sn * x + c * z;
    truthEnu.e = bx; truthEnu.n = -bz;
    const fix = { ...frame.toLatLon(noisy(truthEnu)), accuracy: 5, time: t };
    const runnerS = path.project(pos);
    if (rr.addFix(fix, me, matching ? runnerS : undefined)) path.setRoute(rr.arPoints(), 0, true);
    const ps = path.project(pos);
    const p = path.pointAt(ps, new THREE.Vector3());
    const off = Math.hypot(p.x - me.x, p.z - me.z);
    offs.push(off);
    maxOff = Math.max(maxOff, off);
    if (Math.abs(ps - s) > 12) wrongS++;
    for (const m of [10, 25, 50, 100]) if (marks[m] === undefined && s >= m) marks[m] = off;
  }
  const mean = offs.reduce((a, b) => a + b, 0) / offs.length;
  return { mean, maxOff, wrongS, marks };
}

for (const compass of [5, 20]) {
  for (const [name, enu] of Object.entries(ROUTES)) {
    for (const matching of [false, true]) {
      const rs = Array.from({ length: 40 }, (_, k) => run(enu, k + 1, matching, compass * (k % 2 ? 1 : -1)));
      const avg = (f: (x: (typeof rs)[0]) => number) => (rs.reduce((a, x) => a + f(x), 0) / rs.length).toFixed(1);
      console.log(`compass±${compass}° ${name.padEnd(8)} ${matching ? 'match ' : 'gps   '} mean off ${avg(x => x.mean)} m | max ${avg(x => x.maxOff)} | @10m ${avg(x => x.marks[10])} @25m ${avg(x => x.marks[25])} @50m ${avg(x => x.marks[50])} @100m ${avg(x => x.marks[100] ?? NaN)} | progress jumps ${rs.reduce((a, x) => a + x.wrongS, 0)}`);
    }
  }
}
