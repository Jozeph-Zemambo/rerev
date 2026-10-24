import './style.css';
import * as THREE from 'three';
import { DepthSensor } from './ar/depthSensor';
import { GroundRays } from './ar/groundRays';
import { api } from '../convex/_generated/api';
import { convex } from './convexClient';
import { apply, arBearing } from './geo/alignment';
import { Compass, Gps, type Fix } from './geo/sensors';
import { BluetoothHeartRate, type BluetoothState } from './heart/bluetoothHeartRate';
import { HeartRateFeed } from './heart/heartRateFeed';
import { formatPace, Hud } from './hud';
import { Coach } from './partner/coach';
import { Mascot } from './partner/mascot';
import { Partner, type PartnerState } from './partner/partner';
import { RouteCallouts } from './run/callouts';
import { RunRecorder } from './run/recorder';
import { RouteRun } from './run/routeRun';
import { PreviewWorld } from './sim/previewWorld';
import { Planner, type RunGoal } from './ui/planner';
import { SpeechBubble } from './ui/speechBubble';
import { showRecentRuns, SummaryScreen } from './ui/summary';
import { Diagnostics } from './ui/diagnostics';
import { LineVoice } from './ui/voice';
import { VoiceCommands } from './ui/voiceCommands';
import { PendingQuestion, routeTranscript } from './voice/conversation';
import type { Action, Decision, DecisionLineId } from './voice/decisions';
import { bubbleText, COIN_QUIPS, IDLE_BREAK, IDLE_WAIT, lineById, RUN_STARTS, type LineId, type Spoken } from './voice/lines';
import type { QueueOptions } from './voice/speechQueue';
import { formatDistance } from './ui/summary';
import { Sounds } from './ui/sounds';
import { Collectibles } from './world/collectibles';
import { HazardMarkers } from './world/hazardMarkers';
import { demoRoute, LAP, LAP_LENGTH, lapRoute, Path, type RoutePoint } from './world/path';
import { createShadow } from './world/shadow';
import { SurfaceMap } from './world/surfaceMap';

type RunMode = { kind: 'quick'; laps?: boolean } | { kind: 'route'; goal: RunGoal };

const QUICK_LENGTH = 20;
/** The lap course runs this many laps (about 270 m). */
const LAPS = 20;
const QUICK_PACE = 1.6;
/** Depth, hazard planning and markers run at ~10 Hz; drawing runs every frame. */
const SENSOR_INTERVAL = 0.1;
/** Don't announce detours more often than this. */
const DETOUR_CALL_GAP = 30;
/** Waiting (or on a breather) this long before the buddy chats, then at most this often. */
const IDLE_AFTER = 8;
const IDLE_GAP = 25;
/** Tracking lost this long before the buddy says so, then at most this often. */
const TRACKING_LOST_AFTER = 2;
const TRACKING_CALL_GAP = 30;
/** Outdoors, stepping off a kerb to cross the road is normal, not a hazard. */
const KERB = 0.2;
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

// Watch over Bluetooth: pair once from the home screen (Chrome needs a tap, and its chooser
// can't show over AR); after that it reconnects by itself.
const watch = new BluetoothHeartRate();
const watchButton = byId<HTMLButtonElement>('watch-connect');
const WATCH_LABEL: Record<BluetoothState, string> = {
  off: 'Connect your watch',
  connecting: 'Connecting to your watch…',
  connected: 'Watch connected',
  lost: 'Watch out of reach, retrying…',
};
watch.onReading = bpm => {
  heart.reportWatch(bpm);
  if (watch.state === 'connected') watchButton.lastElementChild!.textContent = `${watch.deviceName} · ${bpm} bpm`;
};
watch.onState = state => {
  watchButton.dataset.state = state;
  watchButton.lastElementChild!.textContent = WATCH_LABEL[state];
};
watchButton.hidden = !watch.supported;
watchButton.onclick = () => {
  if (watch.state === 'connected') return;
  watch.pair().catch((error: Error) => {
    // Closing the chooser isn't an error worth showing.
    if (error.name !== 'NotFoundError') alert(`Couldn't connect to the watch: ${error.message}`);
  });
};
void watch.resume();
const recorder = new RunRecorder(convex);
const summaryScreen = new SummaryScreen();
summaryScreen.onDone = () => {
  homeScreen.hidden = false;
};
showRecentRuns(convex);
const coach = new Coach();
const callouts = new RouteCallouts();
const sounds = new Sounds();
const voice = new LineVoice(() => sounds.audio);
const question = new PendingQuestion();
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
let quip = 0;
let starts = 0;
let idleLine = 0;
const depthSensor = new DepthSensor();
const groundRays = new GroundRays();
const diagnostics = new Diagnostics(byId('lead-stat'));
let depthPoints = 0;
let rayHits = 0;

let arSupported = false;
let mode: RunMode | null = null;
let routeRun: RouteRun | null = null;
let placed = false;
let hitTestSource: XRHitTestSource | null = null;
let depthEnabled = false;
let sensorClock = 0;
let runStartedAt = 0;
let messageHoldUntil = 0;
let lastPrune = 0;
let lastState: PartnerState | null = null;
let wasDetouring = false;
let lastDetourCall = -Infinity;
let stateSince = 0;
let lastIdleCall = -Infinity;
let trackingLostSince: number | null = null;
let lastTrackingCall = -Infinity;

/** Desktop preview state (no AR): a simulated world, runner, GPS and compass. */
const sim = {
  world: null as PreviewWorld | null,
  runnerS: 0,
  truthLine: null as THREE.Line | null,
  truthPoints: [] as RoutePoint[],
  truthLengths: [] as number[],
  fixClock: 0,
  seed: 48271 * 977,
};

// ---------------------------------------------------------------- screens

// Audio may only start from a tap; the first one anywhere unlocks it so voice clips can decode early.
addEventListener('pointerdown', unlockAudio, { once: true });
function unlockAudio() {
  sounds.unlock();
  voice.prepare();
}

byId('go-plan').onclick = () => {
  askForMicrophone();
  homeScreen.hidden = true;
  planner.open();
};
byId('go-indoor').onclick = () => {
  askForMicrophone();
  void startRun({ kind: 'quick' });
};
byId('go-laps').onclick = () => {
  askForMicrophone();
  void startRun({ kind: 'quick', laps: true });
};

/**
 * Ask for the microphone from a tap on a normal screen, so voice commands don't need a
 * permission prompt mid-AR (where Chrome may not show it). Not awaited: AR must start from
 * the same tap.
 */
function askForMicrophone() {
  if (!('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)) return;
  navigator.mediaDevices
    ?.getUserMedia({ audio: true })
    .then(stream => stream.getTracks().forEach(track => track.stop()))
    .catch(() => {});
}
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
commands.onHeard = transcript => {
  hud.say(`You said: "${transcript}"`);
  messageHoldUntil = performance.now() / 1000 + 3;
  hear(transcript);
};

/**
 * Clear commands and yes/no answers are handled on the phone, instantly. Anything softer or
 * unknown goes to Claude (via Convex) to pick an action and a line; without Convex or an API
 * key, soft phrases get a local guess and the rest "didn't catch that".
 */
function hear(transcript: string) {
  const route = routeTranscript(transcript, question.current(performance.now() / 1000));
  if (route.kind === 'answer') return respond(route.answer === 'yes' ? 'confirm_yes' : 'confirm_no');
  if (route.kind === 'intent') return respond(route.intent);
  if (convex) void askClaude(transcript, route.fallback);
  else if (route.fallback) respond(route.fallback.action, route.fallback.lineId);
  else respond('unknown');
}

async function askClaude(said: string, fallback: Decision | null) {
  bubble.show({ text: 'Hmm…', mood: 'info' }, performance.now() / 1000);
  const result = await convex!
    .action(api.buddy.interpret, {
      said,
      pending: question.current(performance.now() / 1000) ?? undefined,
      run: {
        state: partner.state,
        bpm: heart.bpm ?? undefined,
        zoneLow: coach.zone.low,
        zoneHigh: coach.zone.high,
        metres: Math.round(recorder.distanceSoFar),
        paceSecondsPerKm: recorder.pace > 0.3 ? Math.round(1000 / recorder.pace) : undefined,
        onBreak: partner.breaking,
      },
    })
    .catch(() => null);
  if (!placed) return;
  if (result) respond(result.action, result.lineId);
  else if (fallback) respond(fallback.action, fallback.lineId);
  else respond('unknown');
}

/** What the buddy does when you talk to it. `lineId` picks which of the action's lines to say. */
function respond(action: Action | 'unknown', lineId?: DecisionLineId) {
  const now = performance.now() / 1000;
  const pending = question.current(now);
  // Any real answer closes the question; small talk and "didn't catch that" leave it open.
  if (action !== 'none' && action !== 'unknown') question.clear();
  const line = (fallback: LineId): LineId => lineId ?? fallback;
  switch (action) {
    case 'none':
      return speak({ id: line('chat_ack') });
    case 'ask_break':
      if (partner.breaking) return speak({ id: 'idle_break_1' });
      question.ask('break', now);
      return speak({ id: line('confirm_ask_break') }, { interrupt: true });
    case 'confirm_yes':
      if (pending !== 'break') return speak({ id: 'chat_ack' });
      takeBreak();
      return speak({ id: 'confirm_yes_break' }, { interrupt: true });
    case 'confirm_no':
      return speak({ id: 'confirm_no' });
    case 'break':
      takeBreak();
      return speak({ id: line('cmd_break') }, { interrupt: true });
    case 'go':
      if (!partner.breaking) return speak({ id: 'cmd_go_already' });
      partner.setBreak(false);
      coach.resume(now);
      return speak({ id: line('cmd_go') }, { interrupt: true });
    case 'faster':
      partner.nudgePace(0.3);
      return speak({ id: line('cmd_faster') });
    case 'slower':
      partner.nudgePace(-0.3);
      return speak({ id: line('cmd_slower') });
    case 'status': {
      const bpm = heart.bpm;
      const parts = [`${formatDistance(recorder.distanceSoFar)} so far`];
      if (recorder.pace > 0.3) parts.push(`${formatPace(recorder.pace)}/km pace`);
      if (bpm) parts.push(`heart at ${Math.round(bpm)}`);
      return speak({ id: 'cmd_status', bubble: `${parts.join(', ')}. You're doing great!` });
    }
    case 'finish':
      speak({ id: 'cmd_finish' }, { interrupt: true });
      setTimeout(() => void finishRun(), 1500);
      return;
    case 'unknown':
      return speak({ id: 'cmd_unknown', bubble: 'Sorry, I didn\'t catch that. Try "take a break" or "let\'s go".' });
  }
}

function takeBreak() {
  partner.setBreak(true);
  coach.autoBreak = false;
}

/** The buddy says something: the line's voice, with the bubble showing its specifics. */
function speak(spoken: Spoken, options: QueueOptions = {}) {
  bubble.show({ text: bubbleText(spoken), mood: lineById(spoken.id).mood }, performance.now() / 1000);
  voice.say(spoken.id, options);
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
  unlockAudio();
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
  path.group.visible = false;
  markers.clear();
  collectibles.clear();
  heart.manual = null;
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
  voice.stop();
  question.clear();
  hud.showTurn(null);
  hud.showControls(false);
  hud.hrPanel.hidden = true;
  showRunUi(false);
  if (summary) {
    homeScreen.hidden = true;
    summaryScreen.show(summary, recorder.trace, coach.zone);
  }
}

// ---------------------------------------------------------------- runs

function layRoute(points: RoutePoint[], floorY: number, seeds: THREE.Vector3[], runnerS: number) {
  map.reset();
  map.walkableStep = routeRun ? KERB : 0;
  for (const seed of seeds) map.seedGround(seed.x, floorY, seed.z, 1);
  path.setRoute(points, floorY);
  path.group.visible = true;
  // On the lap course, only draw less than a lap ahead so laps don't stack up on each other.
  const lapCourse = mode?.kind === 'quick' && mode.laps;
  path.drawAhead = lapCourse ? LAP_LENGTH - 3 : 38;
  collectibles.layout(path.length, lapCourse ? LAP_LENGTH - 3 : undefined);
  hud.showScore(0, 0);
  partner.reset(runnerS);
  partner.effort = 1;
  partner.trustGroundAhead = !!routeRun;
  runStartedAt = performance.now() / 1000;
  coach.reset(runStartedAt);
  // The drawn oval cuts its bends slightly, so laps are measured on the path itself.
  callouts.reset(runStartedAt, routeRun?.route.steps, routeRun?.route.distance, lapCourse ? path.length / LAPS : 0);
  recorder.start(runStartedAt, {
    kind: mode?.kind ?? 'quick',
    goalPaceSecPerKm: 1000 / partner.goalPace,
    zone: coach.zone,
    routeDistance: routeRun?.route.distance,
  });
  lastState = null;
  wasDetouring = false;
  lastDetourCall = -Infinity;
  stateSince = runStartedAt;
  lastIdleCall = -Infinity;
  trackingLostSince = null;
  lastTrackingCall = -Infinity;
  question.clear();
  speak({ id: RUN_STARTS[starts++ % RUN_STARTS.length] }, { interrupt: true });
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
    // Away from the phone; if the tap was straight below it, the way the camera faces.
    const direction = new THREE.Vector3(start.x - from.x, 0, start.z - from.z);
    if (direction.lengthSq() < 0.01) direction.set(0, 0, -1).transformDirection(cameraMatrix).setY(0);
    direction.normalize();
    const points = mode?.kind === 'quick' && mode.laps ? lapRoute(start, direction, LAPS) : demoRoute(start, direction, QUICK_LENGTH);
    layRoute(points, start.y, seeds, 0);
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
  if (routeRun.addFix(fix, { x: at.x, z: at.z }, path.project(at))) relayRoute();
});

/** Re-lay the route after the anchor moved. It is a rigid move, so distances along it still hold. */
function relayRoute() {
  if (!routeRun) return;
  const floor = path.pointAt(partner.s, new THREE.Vector3()).y;
  path.setRoute(routeRun.arPoints(), floor, true);
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
  let session: XRSession | null = null;
  try {
    session = await navigator.xr!.requestSession('immersive-ar', init);
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  } catch (error) {
    // Back to where the run was started from (the planner keeps its own GPS watch).
    void session?.end().catch(() => {});
    mode = null;
    routeRun = null;
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
  sim.seed = 48271 * 977;
  if (!routeRun && mode?.kind === 'quick' && mode.laps) {
    // Lap course on a bare floor, with a bag dropped on the far straight to steer around.
    sim.world = new PreviewWorld(false, 30);
    sim.world.addBox(-2 * LAP.radius + 0.1, -1.6, 0.4, 0.35, 0.3);
    scene.add(sim.world.group);
    layRoute(lapRoute(new THREE.Vector3(), new THREE.Vector3(0, 0, -1), LAPS), 0, [new THREE.Vector3(0, 0, 0)], 0);
    return;
  }
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
    { ...routeRun.frame.toLatLon(noisy(enu[0])), accuracy: 5 },
    start,
    routeRun.startHeading() + SIM_COMPASS_ERROR,
    arBearing(ahead.x - start.x, ahead.z - start.z),
  );
  camera.position.set(start.x, 1.5, start.z);
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
      if (routeRun.addFix(fix, at, path.project(camera.position))) relayRoute();
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
    case 'stairs':
      return 'Stairs! Taking them nice and easy.';
    case 'look':
      return "Point your phone ahead so I can see where we're going.";
    case 'turn':
      return 'Turning round. Follow me back!';
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

/**
 * The buddy speaks up when its situation changes (something in the way, a drop, the finish),
 * when it loses sight of the ground, and now and then while it stands waiting.
 */
function announce(now: number, trackingLost: boolean) {
  if (partner.state !== lastState) {
    if (partner.state === 'blocked') {
      speak({ id: path.status.blockReason === 'drop' ? 'hazard_drop' : 'hazard_blocked' }, { interrupt: true });
    } else if (partner.state === 'done') {
      speak({ id: 'run_finish', bubble: `We made it! ${formatDistance(recorder.distanceSoFar)}. Great run.` }, { interrupt: true });
    } else if (partner.state === 'stairs' && lastState !== 'wait') {
      speak({ id: 'hazard_stairs' }, { interrupt: true });
    }
    lastState = partner.state;
    stateSince = now;
  }
  // Once is enough: on a lap course the same bag comes round every lap.
  if (path.status.detouring && !wasDetouring && now - lastDetourCall > DETOUR_CALL_GAP) {
    lastDetourCall = now;
    speak({ id: 'hazard_detour' });
  }
  wasDetouring = path.status.detouring;

  if (trackingLost) trackingLostSince ??= now;
  else trackingLostSince = null;
  if (trackingLostSince !== null && now - trackingLostSince >= TRACKING_LOST_AFTER && now - lastTrackingCall > TRACKING_CALL_GAP) {
    lastTrackingCall = now;
    speak({ id: 'run_tracking_lost' });
  }

  const waiting = partner.state === 'wait' || partner.state === 'break';
  if (waiting && !voice.busy && now - stateSince >= IDLE_AFTER && now - lastIdleCall >= IDLE_GAP) {
    lastIdleCall = now;
    // "Say let's go" only fits a breather the runner chose; the coach ends its own.
    const lines = partner.state === 'wait' ? IDLE_WAIT : IDLE_BREAK.filter(id => !coach.autoBreak || id !== 'idle_break_1');
    speak({ id: lines[idleLine++ % lines.length] });
  }
}

/** What the sensors are doing right now, for the on-phone diagnostics readout. */
function diagnosticRows(runnerS: number, trackingLost: boolean): [string, string][] {
  const fix = gps.latest;
  const heading = compass.heading;
  const onPath = path.pointAt(runnerS, new THREE.Vector3());
  const rows: [string, string][] = [
    ['tracking', sim.world ? 'preview' : trackingLost ? 'LOST' : 'ok'],
    ['depth', sim.world ? 'simulated' : depthEnabled ? `${depthPoints} pts` : 'not available'],
    ['rays', sim.world ? 'simulated' : `${rayHits}/${groundRays.rays} hit`],
    ['map', `${map.size} cells, step ${map.walkableStep.toFixed(2)} m`],
    ['buddy', `${partner.state}, ${(partner.s - runnerS).toFixed(1)} m ahead, seen to +${(path.status.seenUntilS - runnerS).toFixed(1)} m`],
  ];
  if (routeRun) {
    const pairs = routeRun.aligner.pairCounts();
    const fit = routeRun.aligner.stats;
    rows.push(
      ['gps', sim.world ? 'simulated, ±4 m noise' : fix ? `±${Math.round(fix.accuracy)} m, ${Math.max(0, Date.now() / 1000 - fix.time).toFixed(0)} s old` : (gps.error ?? 'waiting')],
      ['compass', sim.world ? 'simulated, 20° off' : heading === null ? 'stale / none' : `${Math.round((heading * 180) / Math.PI)}° true`],
      ['fit', `${pairs.gps} gps + ${pairs.route} route pairs, ${fit.refits} refits`],
      ['last fit', `moved ${fit.lastShift.toFixed(1)} m, turned ${fit.lastTurnDeg.toFixed(1)}°`],
      ['off path', `${Math.hypot(onPath.x - runner.x, onPath.z - runner.z).toFixed(1)} m at ${runnerS.toFixed(0)} m`],
    );
  }
  return rows;
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

  let trackingLost = false;
  if (frame && referenceSpace) {
    const viewer = frame.getViewerPose(referenceSpace);
    trackingLost = !viewer || viewer.emulatedPosition;
    if (hitTestSource && !placed) {
      // Only floor-like surfaces: facing up (not a wall) and well below the phone (not a table).
      const cameraY = viewer?.transform.position.y ?? 0;
      const pose = frame
        .getHitTestResults(hitTestSource)
        .map(hit => hit.getPose(referenceSpace))
        .find(p => p && p.transform.matrix[5] > 0.9 && cameraY - p.transform.position.y > 0.6);
      reticle.visible = !!pose;
      if (pose) reticle.matrix.fromArray(pose.transform.matrix);
    }
    if (placed) rayHits = groundRays.sample(frame, referenceSpace, map);
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
      if (sensorTick && frame && referenceSpace && depthEnabled) depthPoints = depthSensor.sample(frame, referenceSpace, map, now);
    }

    path.update(dt, seconds, runnerS, map, now, sensorTick);

    // Heart rate → coach → buddy behaviour and what it says.
    if (sim.world) heart.simulate(dt, partner.currentSpeed, partner.breaking, now - runStartedAt);
    const line = coach.update(now, heart.bpm, partner);
    if (line) speak(line, { interrupt: lineById(line.id).mood === 'care' });
    const callout = callouts.update(now, runnerS, recorder.distanceSoFar, partner.breaking);
    if (callout) speak(callout);
    partner.effort = coach.effort;
    partner.update(dt, runnerS);
    recorder.update(now, runnerS, heart.bpm, partner.breaking);
    announce(now, trackingLost);

    // Stars and coins: in AR the runner is the phone; in preview, the simulated runner on the path.
    const feet = sim.world ? path.pointAt(runnerS, new THREE.Vector3()) : runner;
    for (const kind of collectibles.update(dt, seconds, path, runnerS, feet)) {
      if (kind === 'star') {
        recorder.stars++;
        sounds.star();
      } else {
        recorder.coins++;
        sounds.coin();
        // The quip always pops up, but is only said out loud if the buddy isn't mid-sentence.
        speak({ id: COIN_QUIPS[quip++ % COIN_QUIPS.length] }, { ifIdle: true });
      }
      hud.showScore(recorder.stars, recorder.coins);
    }

    path.pointAt(partner.s, point);
    path.tangentAt(partner.s, tangent);
    mascot.root.position.copy(point);
    // Faces down the path while running or looking ahead; turns to face you otherwise.
    const facing = partner.state === 'run' || partner.state === 'look' || partner.state === 'stairs' ? Math.atan2(tangent.x, tangent.z) : Math.atan2(-tangent.x, -tangent.z);
    const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
    mascot.root.rotation.y += turn * Math.min(1, dt * 5);
    mascot.update(dt, seconds, partner.gait);
    shadow.position.set(point.x, point.y + 0.003, point.z);

    if (sensorTick) markers.update(map, runner, now);
    if (now - lastPrune > 5) {
      lastPrune = now;
      map.prune(runner.x, runner.z, 40);
    }
    hud.showTurn(routeRun ? routeRun.nextTurn(runnerS) : null);
    hud.update({
      heartRate: heart.bpm,
      heartSource: heart.source,
      zone: coach.zone,
      paceMetersPerSecond: recorder.pace,
      leadMeters: Math.max(0, partner.s - runnerS),
    });
    if (trackingLost) hud.say('Lost track of the ground. Hold the phone steady and point it at the floor ahead.');
    else if (now >= messageHoldUntil) hud.say(stateMessage(partner.state));
    const breakLabel = partner.breaking ? "Let's go" : 'Take a break';
    if (hud.breakButton.textContent !== breakLabel) hud.breakButton.textContent = breakLabel;
    bubble.update(point, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, now);
    if (diagnostics.due(now)) diagnostics.show(diagnosticRows(runnerS, trackingLost));
  }

  // Nothing 3D to show on the home, planner or summary screens.
  if (!renderer.domElement.hidden || renderer.xr.isPresenting) renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

if (import.meta.env.DEV) {
  Object.assign(window, { rerev: { path, partner, map, camera, sim, coach, heart, commands, recorder, voice, hear, getRouteRun: () => routeRun } });
}

void (async () => {
  arSupported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
})();
