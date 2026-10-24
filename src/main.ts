import './style.css';
import * as THREE from 'three';
import { DepthSensor } from './ar/depthSensor';
import { GroundRays } from './ar/groundRays';
import { convex } from './convexClient';
import { apply, arBearing } from './geo/alignment';
import { Compass, Gps, type Fix } from './geo/sensors';
import { HeartRateFeed } from './heart/heartRateFeed';
import { formatPace, Hud } from './hud';
import { Coach, type CoachLine } from './partner/coach';
import { Mascot } from './partner/mascot';
import { Partner, type PartnerState } from './partner/partner';
import { RunRecorder } from './run/recorder';
import { RouteRun } from './run/routeRun';
import { PreviewWorld } from './sim/previewWorld';
import { Planner, type RunGoal } from './ui/planner';
import { SpeechBubble } from './ui/speechBubble';
import { showRecentRuns, SummaryScreen } from './ui/summary';
import { BrowserVoice } from './ui/voice';
import { VoiceCommands, type Intent } from './ui/voiceCommands';
import { formatDistance } from './ui/summary';
import { Sounds } from './ui/sounds';
import { Collectibles } from './world/collectibles';
import { HazardMarkers } from './world/hazardMarkers';
import { demoRoute, Path, type RoutePoint } from './world/path';
import { createShadow } from './world/shadow';
import { SurfaceMap } from './world/surfaceMap';

type RunMode = { kind: 'quick' } | { kind: 'route'; goal: RunGoal };

const QUICK_LENGTH = 20;
const QUICK_PACE = 1.6;
/** Depth, hazard planning and markers run at ~10 Hz; drawing runs every frame. */
const SENSOR_INTERVAL = 0.1;
/** Preview-only: how wrong the simulated compass is, and how noisy simulated GPS is. */
const SIM_COMPASS_ERROR = (20 * Math.PI) / 180;
const SIM_GPS_NOISE = 4;
const SIM_TRUTH = { theta: 0.6, tx: 0, tz: 0 };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const homeScreen = byId('home');
const hud = new Hud();
const gps = new Gps();
const compass = new Compass();
const planner = new Planner(gps);
const heart = new HeartRateFeed();
heart.connect(convex);
const recorder = new RunRecorder(convex);
const summaryScreen = new SummaryScreen();
summaryScreen.onDone = () => {
  homeScreen.hidden = false;
};
showRecentRuns(convex);
const coach = new Coach();
const voice = new BrowserVoice();
const bubble = new SpeechBubble(hud.root);
const DEFAULT_ZONE = { low: 130, high: 160 };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.domElement.hidden = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 400);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x8899aa, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 2);
scene.add(sun);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffb347 }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const map = new SurfaceMap();
const path = new Path();
scene.add(path.group);
const markers = new HazardMarkers();
scene.add(markers.mesh);
const mascot = new Mascot();
mascot.root.visible = false;
scene.add(mascot.root);
const shadow = createShadow();
shadow.visible = false;
scene.add(shadow);
const partner = new Partner(path);
const collectibles = new Collectibles();
scene.add(collectibles.group);
const sounds = new Sounds();
const COIN_QUIPS = ['Cha-ching!', 'Shiny!', 'Ooh, a coin!', 'Treasure!'];
let quip = 0;
const depthSensor = new DepthSensor();
const groundRays = new GroundRays();

let arSupported = false;
let mode: RunMode | null = null;
let routeRun: RouteRun | null = null;
let placed = false;
let hitTestSource: XRHitTestSource | null = null;
let depthEnabled = false;
let sensorClock = 0;
let runStartedAt = 0;
let messageHoldUntil = 0;
let lastState: PartnerState | null = null;
let wasDetouring = false;

/** Desktop preview state (no AR): a simulated world, runner, GPS and compass. */
const sim = {
  world: null as PreviewWorld | null,
  runnerS: 0,
  truthLine: null as THREE.Line | null,
  truthPoints: [] as RoutePoint[],
  truthLengths: [] as number[],
  fixClock: 0,
  seed: 11,
};

// ---------------------------------------------------------------- screens

byId('go-plan').onclick = () => {
  homeScreen.hidden = true;
  planner.open();
};
byId('go-indoor').onclick = () => void startRun({ kind: 'quick' });
planner.onBack = () => {
  planner.close();
  homeScreen.hidden = false;
};
planner.onStart = goal => void startRun({ kind: 'route', goal });

hud.breakButton.onclick = () => respond(partner.breaking ? 'go' : 'break');
hud.hrStat.onclick = () => {
  hud.hrPanel.hidden = !hud.hrPanel.hidden;
  if (!hud.hrPanel.hidden) heart.manual = Number(hud.hrManual.value);
};
hud.hrManual.oninput = () => {
  heart.manual = Number(hud.hrManual.value);
  hud.hrManualOut.textContent = hud.hrManual.value;
};
hud.hrAuto.onclick = () => {
  heart.manual = null;
  hud.hrPanel.hidden = true;
};

const commands = new VoiceCommands();
const talkButton = byId<HTMLButtonElement>('btn-talk');
talkButton.hidden = !commands.supported;
talkButton.onclick = () => commands.toggle();
commands.onState = (listening, error) => {
  talkButton.classList.toggle('listening', listening);
  talkButton.querySelector('span')!.textContent = listening ? 'Listening…' : 'Talk';
  if (error) hud.say(error);
};
commands.onHeard = (transcript, intent) => {
  hud.say(`You said: "${transcript}"`);
  messageHoldUntil = performance.now() / 1000 + 3;
  respond(intent);
};

/** What the buddy does when you talk to it. */
function respond(intent: Intent) {
  switch (intent) {
    case 'break':
      partner.setBreak(true);
      coach.autoBreak = false;
      return speak({ text: 'Sure, breather time. Jog on the spot with me.', mood: 'care' }, true);
    case 'go':
      if (!partner.breaking) return speak({ text: "I'm right here. Let's keep it up!", mood: 'cheer' });
      partner.setBreak(false);
      coach.autoBreak = false;
      return speak({ text: "Alright, let's go!", mood: 'cheer' }, true);
    case 'faster':
      partner.nudgePace(0.3);
      return speak({ text: 'Picking it up!', mood: 'cheer' });
    case 'slower':
      partner.nudgePace(-0.3);
      return speak({ text: 'Easing off. Nice and steady.', mood: 'care' });
    case 'status': {
      const bpm = heart.bpm;
      const parts = [`${formatDistance(recorder.distanceSoFar)} so far`];
      if (recorder.pace > 0.3) parts.push(`${formatPace(recorder.pace).replace(':', ' ')} pace`);
      if (bpm) parts.push(`heart at ${Math.round(bpm)}`);
      return speak({ text: `${parts.join(', ')}. You're doing great!`, mood: 'info' });
    }
    case 'finish':
      speak({ text: 'Great run! Wrapping up.', mood: 'cheer' }, true);
      setTimeout(() => void finishRun(), 1500);
      return;
    case 'unknown':
      return speak({ text: "Sorry, I didn't catch that. Try \"take a break\" or \"let's go\".", mood: 'info' });
  }
}

/** The buddy says something: speech bubble over its head plus the voice. */
function speak(line: CoachLine, interrupt = false) {
  bubble.show(line, performance.now() / 1000);
  voice.speak(line.text, interrupt);
}
hud.slowerButton.onclick = () => partner.nudgePace(-0.3);
hud.fasterButton.onclick = () => partner.nudgePace(0.3);
hud.finishButton.onclick = () => void finishRun();

function showRunUi(running: boolean) {
  document.body.classList.toggle('running', running);
  renderer.domElement.hidden = !running;
  hud.show(running);
  if (running) {
    homeScreen.hidden = true;
    planner.close();
  } else {
    homeScreen.hidden = false;
  }
}

async function startRun(next: RunMode) {
  mode = next;
  partner.goalPace = next.kind === 'route' ? 1000 / next.goal.paceSecondsPerKm : QUICK_PACE;
  coach.zone = next.kind === 'route' ? next.goal.zone : DEFAULT_ZONE;
  heart.resetSimulation();
  sounds.unlock();
  routeRun = next.kind === 'route' ? new RouteRun(next.goal.route) : null;
  // Sensor permissions must be requested from this tap.
  if (next.kind === 'route') {
    gps.start();
    void compass.start();
  }
  if (arSupported) await startAr();
  else startPreview();
}

async function finishRun() {
  const session = renderer.xr.getSession();
  if (session) await session.end();
  else endRun();
}

function endRun() {
  const summary = placed ? recorder.finish(performance.now() / 1000) : null;
  placed = false;
  mode = null;
  routeRun = null;
  mascot.root.visible = false;
  shadow.visible = false;
  markers.clear();
  collectibles.clear();
  if (sim.world) {
    scene.remove(sim.world.group);
    sim.world = null;
  }
  if (sim.truthLine) {
    scene.remove(sim.truthLine);
    sim.truthLine = null;
  }
  scene.background = null;
  bubble.hide();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  hud.showTurn(null);
  hud.showControls(false);
  hud.hrPanel.hidden = true;
  showRunUi(false);
  if (summary) {
    homeScreen.hidden = true;
    summaryScreen.show(summary);
  }
}

// ---------------------------------------------------------------- runs

function layRoute(points: RoutePoint[], floorY: number, seeds: THREE.Vector3[], runnerS: number) {
  map.reset();
  for (const seed of seeds) map.seedGround(seed.x, floorY, seed.z, 1);
  path.setRoute(points, floorY);
  collectibles.layout(path.length);
  hud.showScore(0, 0);
  partner.reset(runnerS);
  partner.effort = 1;
  runStartedAt = performance.now() / 1000;
  coach.reset(runStartedAt);
  recorder.start(runStartedAt, {
    kind: mode?.kind ?? 'quick',
    goalPaceSecPerKm: 1000 / partner.goalPace,
    zone: coach.zone,
    routeDistance: routeRun?.route.distance,
  });
  lastState = null;
  wasDetouring = false;
  mascot.root.visible = true;
  shadow.visible = true;
  reticle.visible = false;
  placed = true;
  hud.showControls(true);
  hud.breakButton.textContent = 'Take a break';
}

/** Tapped the floor in AR: lay the quick path, or anchor the map route to the world here. */
function placeAt(start: THREE.Vector3, cameraMatrix: THREE.Matrix4) {
  const from = new THREE.Vector3().setFromMatrixPosition(cameraMatrix);
  const seeds = [start, new THREE.Vector3(from.x, start.y, from.z)];
  if (!routeRun) {
    const direction = new THREE.Vector3(start.x - from.x, 0, start.z - from.z).normalize();
    layRoute(demoRoute(start, direction, QUICK_LENGTH), start.y, seeds, 0);
    return;
  }
  const fix = gps.latest;
  if (!fix || fix.accuracy > 30) {
    hud.say(`Waiting for a GPS fix${fix ? ` (±${Math.round(fix.accuracy)} m so far)` : ''}. Step outside if you can, then tap again.`);
    return;
  }
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(cameraMatrix);
  const heading = compass.heading ?? routeRun.startHeading();
  routeRun.begin(fix, { x: from.x, z: from.z }, heading, arBearing(forward.x, forward.z));
  layRoute(routeRun.arPoints(), start.y, seeds, 0);
  partner.reset(path.project(from));
}

/** A GPS fix arrived: refine where the route sits in the world. */
gps.onFix(fix => {
  if (!placed || !routeRun || sim.world) return;
  const pose = renderer.xr.getCamera().matrixWorld;
  const at = new THREE.Vector3().setFromMatrixPosition(pose);
  if (routeRun.addFix(fix, { x: at.x, z: at.z })) relayRoute();
});

/** Re-lay the route after the anchor moved. It is a rigid move, so distances along it still hold. */
function relayRoute() {
  if (!routeRun) return;
  const floor = path.pointAt(partner.s, new THREE.Vector3()).y;
  path.setRoute(routeRun.arPoints(), floor);
}

// ---------------------------------------------------------------- AR session

async function startAr() {
  // depthSensing is not in the WebXR typings yet but Chrome reads it.
  const init = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'depth-sensing'],
    depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
    domOverlay: { root: hud.root },
  } as XRSessionInit;
  try {
    const session = await navigator.xr!.requestSession('immersive-ar', init);
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  } catch (error) {
    alert(`Couldn't start AR: ${(error as Error).message}`);
  }
}

hud.root.addEventListener('beforexrselect', event => event.preventDefault());

renderer.xr.addEventListener('sessionstart', async () => {
  const session = renderer.xr.getSession()!;
  depthEnabled = session.enabledFeatures?.includes('depth-sensing') ?? false;
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
  await groundRays.start(session);
  placed = false;
  showRunUi(true);
  hud.showControls(false);
  const where = routeRun ? 'Face the way your route starts, point at the ground and tap.' : 'Point at the floor. When the ring appears, tap to start.';
  hud.say(depthEnabled ? where : `${where} (No depth camera on this phone, so obstacle detection is off.)`);
});
renderer.xr.addEventListener('sessionend', () => {
  hitTestSource = null;
  groundRays.stop();
  endRun();
});

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (placed || !reticle.visible) return;
  placeAt(new THREE.Vector3().setFromMatrixPosition(reticle.matrix), renderer.xr.getCamera().matrixWorld);
});
scene.add(controller);

// ---------------------------------------------------------------- desktop preview

function startPreview() {
  showRunUi(true);
  scene.background = new THREE.Color(0x1d2b33);
  sim.runnerS = 0;
  sim.fixClock = 0;
  if (!routeRun) {
    sim.world = new PreviewWorld(true);
    scene.add(sim.world.group);
    layRoute(sim.world.route, 0, [new THREE.Vector3(0, 0, 0)], 0);
    return;
  }
  // Map route: the "real" route sits at a hidden true transform; the app only learns it from
  // a deliberately wrong compass and noisy GPS, exactly like on a phone.
  const extent = routeRun.route.distance + 200;
  sim.world = new PreviewWorld(false, Math.ceil(extent / 100) * 200);
  scene.add(sim.world.group);
  const enu = routeRun.route.points.map(p => routeRun!.frame.toEnu(p));
  sim.truthPoints = enu.map(p => apply(SIM_TRUTH, p));
  sim.truthLengths = cumulativeLengths(sim.truthPoints);
  sim.truthLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(sim.truthPoints.map(p => new THREE.Vector3(p.x, 0.02, p.z))),
    new THREE.LineBasicMaterial({ color: 0x9fe1cb, transparent: true, opacity: 0.5 }),
  );
  scene.add(sim.truthLine);
  const start = sim.truthPoints[0];
  const ahead = pointOnTruth(8);
  routeRun.begin(
    routeRun.frame.toLatLon(noisy(enu[0])),
    start,
    routeRun.startHeading() + SIM_COMPASS_ERROR,
    arBearing(ahead.x - start.x, ahead.z - start.z),
  );
  layRoute(routeRun.arPoints(), 0, [new THREE.Vector3(start.x, 0, start.z)], 0);
}

function noisy(p: { e: number; n: number }) {
  return { e: p.e + gauss() * SIM_GPS_NOISE, n: p.n + gauss() * SIM_GPS_NOISE };
}

function gauss() {
  const r = () => (sim.seed = (sim.seed * 16807) % 2147483647) / 2147483647;
  return Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r());
}

function cumulativeLengths(points: RoutePoint[]) {
  const out = [0];
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  return out;
}

function pointOnTruth(s: number): RoutePoint {
  const L = sim.truthLengths;
  const clamped = Math.min(Math.max(s, 0), L[L.length - 1]);
  let i = 1;
  while (i < L.length - 1 && L[i] < clamped) i++;
  const t = (clamped - L[i - 1]) / (L[i] - L[i - 1] || 1);
  const a = sim.truthPoints[i - 1];
  const b = sim.truthPoints[i];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** Moves the simulated runner and returns its distance along the displayed path. */
function advanceSim(dt: number, now: number, sensorTick: boolean): number {
  const world = sim.world!;
  const stopped = partner.state === 'break' || partner.state === 'blocked' || partner.state === 'done';
  const pace = (routeRun ? partner.goalPace : QUICK_PACE) * 0.85;

  if (!routeRun) {
    // Quick path: jog along the displayed (detoured) path, stopping behind the buddy when it stops.
    let limit = stopped ? partner.s - 1.2 : path.length;
    if (path.status.blockedAtS !== null) limit = Math.min(limit, path.status.blockedAtS - 0.6);
    sim.runnerS = Math.min(limit, sim.runnerS + pace * dt);
    const at = path.pointAt(sim.runnerS - 0.8, new THREE.Vector3());
    camera.position.set(at.x, world.groundHeight(at.x, at.z) + 1.5, at.z);
    const look = path.pointAt(sim.runnerS + 3, new THREE.Vector3());
    camera.lookAt(look.x, look.y + 0.4, look.z);
  } else {
    // Map route: the runner follows the TRUE route; GPS reports it with noise once a second.
    const lead = partner.s - path.project(camera.position);
    if (!stopped || lead > 1.5) sim.runnerS = Math.min(sim.truthLengths.at(-1)!, sim.runnerS + pace * dt);
    const at = pointOnTruth(sim.runnerS);
    const look = pointOnTruth(sim.runnerS + 4);
    camera.position.set(at.x, 1.5, at.z);
    camera.lookAt(look.x, 0.4, look.z);
    sim.fixClock += dt;
    if (sim.fixClock >= 1) {
      sim.fixClock = 0;
      const enu = routeRun.frame.toEnu(routeRun.route.points[0]);
      const truthEnu = inverseTruth(at);
      const fix: Fix = { ...routeRun.frame.toLatLon(noisy({ e: truthEnu.e + enu.e, n: truthEnu.n + enu.n })), accuracy: 5, time: now };
      if (routeRun.addFix(fix, at)) relayRoute();
    }
  }

  if (sensorTick) {
    world.sampleDepth(camera, map, now);
    world.sampleGround(camera, map);
  }
  return routeRun ? path.project(camera.position) : sim.runnerS;
}

function inverseTruth(p: RoutePoint) {
  const c = Math.cos(SIM_TRUTH.theta);
  const s = Math.sin(SIM_TRUTH.theta);
  const x = p.x - SIM_TRUTH.tx;
  const z = p.z - SIM_TRUTH.tz;
  // Undo the rotation, then base(): x = e, z = -n.
  const bx = c * x - s * z;
  const bz = s * x + c * z;
  return { e: bx, n: -bz };
}

// ---------------------------------------------------------------- frame loop

function stateMessage(state: PartnerState): string {
  switch (state) {
    case 'run':
      return path.status.detouring ? "Something's on the path. Follow me around it!" : 'Running with you. Keep it steady!';
    case 'look':
      return "Point your phone ahead so I can see where we're going.";
    case 'wait':
      return "I'll wait up for you. Catch up when you're ready.";
    case 'break':
      return 'Taking a breather. Tap "Let\'s go" when you are ready.';
    case 'blocked':
      return path.status.blockReason === 'drop'
        ? "Careful, there's a drop ahead. Let's not go that way."
        : "Whoa, the way is blocked. I'll wait here.";
    case 'done':
      return 'Route complete. Nice work!';
  }
}

/** The buddy speaks up when its situation changes: something in the way, a drop, the finish. */
function announce() {
  if (partner.state !== lastState) {
    if (partner.state === 'blocked') {
      const drop = path.status.blockReason === 'drop';
      speak({ text: drop ? "Careful! There's a drop ahead." : "Whoa, something's blocking the way.", mood: 'care' }, true);
    } else if (partner.state === 'done') {
      speak({ text: 'We made it! Great run.', mood: 'cheer' }, true);
    }
    lastState = partner.state;
  }
  if (path.status.detouring && !wasDetouring) speak({ text: "Something's in the way. Follow me around it!", mood: 'info' });
  wasDetouring = path.status.detouring;
}

const clock = new THREE.Clock();
const point = new THREE.Vector3();
const tangent = new THREE.Vector3();
const runner = new THREE.Vector3();

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const seconds = time / 1000;
  const now = performance.now() / 1000;
  const referenceSpace = renderer.xr.getReferenceSpace();

  if (frame && referenceSpace) {
    if (hitTestSource && !placed) {
      const pose = frame.getHitTestResults(hitTestSource)[0]?.getPose(referenceSpace);
      reticle.visible = !!pose;
      if (pose) reticle.matrix.fromArray(pose.transform.matrix);
    }
    if (placed) groundRays.sample(frame, referenceSpace, map);
  }

  if (placed && mode) {
    sensorClock += dt;
    const sensorTick = sensorClock >= SENSOR_INTERVAL;
    if (sensorTick) sensorClock = 0;

    let runnerS: number;
    if (sim.world) {
      runnerS = advanceSim(dt, now, sensorTick);
      runner.copy(camera.position);
    } else {
      runner.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
      runnerS = path.project(runner);
      if (sensorTick && frame && referenceSpace && depthEnabled) depthSensor.sample(frame, referenceSpace, map, now);
    }

    path.update(dt, seconds, runnerS, map, now, sensorTick);

    // Heart rate → coach → buddy behaviour and what it says.
    if (sim.world) heart.simulate(dt, partner.currentSpeed, partner.breaking, now - runStartedAt);
    const line = coach.update(now, heart.bpm, partner);
    if (line) speak(line, line.mood === 'care');
    partner.effort = coach.effort;
    partner.update(dt, runnerS);
    recorder.update(now, runnerS, heart.bpm, partner.breaking);
    announce();

    // Stars and coins: in AR the runner is the phone; in preview, the simulated runner on the path.
    const feet = sim.world ? path.pointAt(runnerS, new THREE.Vector3()) : runner;
    for (const kind of collectibles.update(dt, seconds, path, runnerS, feet)) {
      if (kind === 'star') {
        recorder.stars++;
        sounds.star();
      } else {
        recorder.coins++;
        sounds.coin();
        bubble.show({ text: COIN_QUIPS[quip++ % COIN_QUIPS.length], mood: 'cheer' }, now);
      }
      hud.showScore(recorder.stars, recorder.coins);
    }

    path.pointAt(partner.s, point);
    path.tangentAt(partner.s, tangent);
    mascot.root.position.copy(point);
    // Faces down the path while running or looking ahead; turns to face you otherwise.
    const facing = partner.state === 'run' || partner.state === 'look' ? Math.atan2(tangent.x, tangent.z) : Math.atan2(-tangent.x, -tangent.z);
    const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
    mascot.root.rotation.y += turn * Math.min(1, dt * 5);
    mascot.update(dt, seconds, partner.gait);
    shadow.position.set(point.x, point.y + 0.003, point.z);

    if (sensorTick) markers.update(map, runner, now);
    hud.showTurn(routeRun ? routeRun.nextTurn(runnerS) : null);
    hud.update({
      heartRate: heart.bpm,
      heartSource: heart.source,
      zone: coach.zone,
      paceMetersPerSecond: recorder.pace,
      leadMeters: Math.max(0, partner.s - runnerS),
    });
    if (now >= messageHoldUntil) hud.say(stateMessage(partner.state));
    const breakLabel = partner.breaking ? "Let's go" : 'Take a break';
    if (hud.breakButton.textContent !== breakLabel) hud.breakButton.textContent = breakLabel;
    bubble.update(point, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, now);
  }

  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

if (import.meta.env.DEV) {
  Object.assign(window, { rerev: { path, partner, map, camera, sim, coach, heart, commands, recorder, getRouteRun: () => routeRun } });
}

void (async () => {
  arSupported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
})();
