/**
 * Headless check of map-route alignment. A simulated runner sets off while the app only knows
 * where they are through a wrong compass and noisy GPS (±4 m), exactly like the preview sim.
 *
 * Two runners:
 *   pavement  stays on the real route (a street with edges)
 *   follow    follows the line the app draws (an open plaza or park)
 *
 * Reported, averaged over 40 runs each:
 *   route err  mean distance between the drawn route and the real one, over the whole route
 *              (where turns and the finish appear), averaged over the run, and at the end
 *   off path   mean distance from the runner to the drawn path at their position
 *   progress   mean error in how far along the route the app thinks the runner is
 *
 *   npm run bench:align            with route matching
 *   npm run bench:align -- --gps   GPS only, for comparison
 */
import * as THREE from 'three';
import { RouteRun } from '../src/run/routeRun';
import { Path } from '../src/world/path';
import { apply, arBearing } from '../src/geo/alignment';
import { LocalFrame, MRU, type Enu } from '../src/geo/geo';

const matching = !process.argv.includes('--gps');
const RUNS = 40;
const SPEED = 2.7;

const ROUTES: Record<string, Enu[]> = {
  straight: [{ e: 0, n: 0 }, { e: 0, n: 400 }],
  square: [{ e: 0, n: 0 }, { e: 0, n: 150 }, { e: 150, n: 150 }, { e: 150, n: 0 }],
  block: [{ e: 0, n: 0 }, { e: 0, n: 80 }, { e: 120, n: 80 }, { e: 120, n: 0 }, { e: 0, n: 0 }],
  // Out along a street and back on the other side, then on.
  outback: [{ e: 0, n: 0 }, { e: -2, n: -1.9 }, { e: -14, n: 10 }, { e: -16, n: 8 }, { e: -4, n: -4 }, { e: 20, n: -4 }, { e: 20, n: 60 }, { e: 60, n: 60 }],
};

type P = { x: number; z: number };
const lengths = (pts: P[]) => pts.reduce<number[]>((L, p, i) => (i ? [...L, L[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z)] : [0]), []);
function at(pts: P[], L: number[], s: number): P {
  let i = 1;
  while (i < L.length - 1 && L[i] < s) i++;
  const t = Math.min(1, Math.max(0, (s - L[i - 1]) / (L[i] - L[i - 1] || 1)));
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
}

function run(enu: Enu[], seed: number, follow: boolean, compassDeg: number) {
  let state = seed * 7919 + 104729;
  const rand = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand());
  const frame = new LocalFrame(MRU);
  const route = new RouteRun({ points: enu.map(p => frame.toLatLon(p)), distance: 0, steps: [], elevation: [], climb: 0 });
  const truthT = { theta: 0.6, tx: 3, tz: -2 };
  const truth = enu.map(p => apply(truthT, p));
  const L = lengths(truth);
  const total = L.at(-1)!;
  const toEnu = (p: P): Enu => {
    const c = Math.cos(truthT.theta);
    const s = Math.sin(truthT.theta);
    const x = p.x - truthT.tx;
    const z = p.z - truthT.tz;
    return { e: c * x - s * z, n: -(s * x + c * z) };
  };
  const noisy = (p: Enu) => ({ e: p.e + gauss() * 4, n: p.n + gauss() * 4 });

  const start = truth[0];
  const ahead = at(truth, L, 8);
  route.begin({ ...frame.toLatLon(noisy(enu[0])), accuracy: 5 }, start, route.startHeading() + (compassDeg * Math.PI) / 180, arBearing(ahead.x - start.x, ahead.z - start.z));
  const path = new Path();
  path.setRoute(route.arPoints(), 0);
  const routeError = () => {
    const drawn = route.arPoints();
    const LD = lengths(drawn);
    let err = 0;
    let k = 0;
    for (let s = 0; s <= total; s += 5, k++) {
      const a = at(drawn, LD, s);
      const b = at(truth, L, s);
      err += Math.hypot(a.x - b.x, a.z - b.z);
    }
    return err / k;
  };
  const pos = new THREE.Vector3(start.x, 1.5, start.z);
  let errSum = 0;
  let errCount = 0;
  let off = 0;
  let progress = 0;
  let n = 0;
  let trueS = 0;
  for (let t = 1; trueS < total - 3 && t < 2000; t++) {
    let me: P;
    if (follow) {
      const shown = path.pointAt(path.project(pos) + SPEED, new THREE.Vector3());
      me = { x: shown.x, z: shown.z };
      trueS += SPEED;
    } else {
      trueS += SPEED;
      me = at(truth, L, trueS);
    }
    pos.set(me.x, 1.5, me.z);
    const runnerS = path.project(pos);
    if (route.addFix({ ...frame.toLatLon(noisy(toEnu(me))), accuracy: 5, time: t }, me, matching ? runnerS : undefined)) path.setRoute(route.arPoints(), 0, true);
    const s = path.project(pos);
    const shown = path.pointAt(s, new THREE.Vector3());
    off += Math.hypot(shown.x - me.x, shown.z - me.z);
    if (!follow) progress += Math.abs(s - trueS);
    n++;
    if (t % 5 === 0) {
      errSum += routeError();
      errCount++;
    }
    if (follow && s > path.length - 3) break;
  }
  return { avgErr: errSum / Math.max(1, errCount), endErr: routeError(), off: off / n, progress: follow ? NaN : progress / n };
}

console.log(`route matching ${matching ? 'ON' : 'OFF (GPS only)'}; ${RUNS} runs each, compass error alternating ±\n`);
console.log('route     runner    compass  route err (avg / end)  off path  progress');
for (const [name, enu] of Object.entries(ROUTES)) {
  for (const follow of [false, true]) {
    for (const compass of [5, 20]) {
      const rs = Array.from({ length: RUNS }, (_, k) => run(enu, k + 1, follow, compass * (k % 2 ? 1 : -1)));
      const mean = (f: (r: (typeof rs)[0]) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      const progress = mean(r => r.progress);
      console.log(
        `${name.padEnd(9)} ${(follow ? 'follow' : 'pavement').padEnd(9)} ±${String(compass).padStart(2)}°    ${mean(r => r.avgErr).toFixed(1).padStart(5)} / ${mean(r => r.endErr).toFixed(1).padStart(4)} m       ${mean(r => r.off).toFixed(1).padStart(5)} m  ${Number.isNaN(progress) ? '    –' : `${progress.toFixed(1).padStart(5)} m`}`,
      );
    }
  }
}
