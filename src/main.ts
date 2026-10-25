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
import { savedBuddy, setupBuddyPicker } from './ui/buddyPicker';
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
import { FollowMe, type FollowEvent } from './world/followMe';
import { HazardMarkers } from './world/hazardMarkers';
import { buildCourse, CourseRecording, courseRun, MIN_COURSE, type Course } from './world/course';
import { CourseTrail } from './world/courseTrail';
import { demoRoute, Path, resample, type RoutePoint } from './world/path';
import { createShadow } from './world/shadow';
import { SurfaceMap } from './world/surfaceMap';

/** `course` is "Walk your course": record a walk in AR, then run it, as often as you like. */
type RunMode = { kind: 'quick' } | { kind: 'course' } | { kind: 'route'; goal: RunGoal };

const QUICK_LENGTH = 20;
const QUICK_PACE = 1.6;
/** Dashes are normally drawn this far ahead (Path's default). */
const DRAW_AHEAD = 38;
/**
 * Following the runner, the line ahead is a guess along their direction: show only this much of
 * it, so it doesn't reach into the house across the street before they've chosen a way.
 */
const FOLLOW_DRAW_AHEAD = 12;
/** When the buddy reappears ahead of a runner who passed it, it pops in over this long. */
const POP_TIME = 0.35;
/**
 * Following, a hallway corner looks blocked until the runner turns into it: the buddy only says
 * the way is blocked if it still is after this long.
 */
const FOLLOW_BLOCKED_WAIT = 2;
/** On an out-and-back, the way back is shown this far past the coming turnaround. */
const PAST_TURN = 3;
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
  lost: 'Watch lost: turn its beacon on, retrying…',
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
const mascot = new Mascot(savedBuddy());
setupBuddyPicker(byId('buddy-pick'), savedBuddy(), color => mascot.setColor(color));
mascot.root.visible = false;
scene.add(mascot.root);
const shadow = createShadow();
shadow.visible = false;
scene.add(shadow);
const partner = new Partner(path);
const collectibles = new Collectibles();
scene.add(collectibles.group);
/** Quick start follows the runner: they choose the way, the path ahead bends to match. */
const follow = new FollowMe();
let following = false;
/** Time since the buddy last reappeared ahead (POP_TIME or more once it's fully back). */
let popAge = POP_TIME;
/** When to say the way is blocked, if it still is then (following). */
let blockedCallAt: number | null = null;
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
  /** Walk your course: the simulated walk that gets recorded, and how far along it we are. */
  walkPoints: [] as RoutePoint[],
  walkLengths: [] as number[],
  walk: null as { s: number } | null,
  /** Follow-me preview: how far the walker has stepped aside to follow a detour. */
  side: { x: 0, z: 0 },
};

/** Walk your course: find the floor → ready to record → recording → running → summary → … */
type CoursePhase = 'find' | 'ready' | 'recording' | 'running' | 'summary';
const course = {
  phase: 'find' as CoursePhase,
  recording: new CourseRecording(),
  built: null as Course | null,
  /** Floor height under the course: the AR hit test's, when Record was tapped. */
  floorY: 0,
};
const trail = new CourseTrail();
scene.add(trail.mesh);
/** Where the buddy stands while it waits for a run (before one, while recording, on the summary). */
const idle = { at: new THREE.Vector3(), shown: false };
/** Height of the floor the reticle last found. */
let lastFloorY = 0;
const TURN_QUIPS = ['And back!', 'Round we go!', 'Turning!', 'U-turn!'];
let turnQuip = 0;

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
byId('go-course').onclick = () => {
  askForMicrophone();
  void startRun({ kind: 'course' });
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
  // The laptop preview's ?course=obstacles keeps the old fixed course, to check obstacles against.
  following = next.kind === 'quick' && !(!arSupported && obstacleCourse());
  // Sensor permissions must be requested from this tap.
  if (next.kind === 'route') {
    gps.start();
    void compass.start();
  }
  if (arSupported) await startAr();
  else startPreview();
}

async function finishRun() {
  // On a course, AR stays open between runs: the course only exists while it is.
  if (mode?.kind === 'course') {
    if (placed) finishCourseRun();
    return;
  }
  await leaveRun();
}

/** End the AR session (which ends the run), or the preview. */
async function leaveRun() {
  const session = renderer.xr.getSession();
  if (session) await session.end();
  else endRun();
}

/** Take down what a run put in the scene and on the HUD. */
function clearRunScene() {
  path.group.visible = false;
  markers.clear();
  collectibles.clear();
  heart.manual = null;
  bubble.hide();
  voice.stop();
  question.clear();
  hud.showTurn(null);
  hud.showControls(false);
  hud.hrPanel.hidden = true;
}

function endRun() {
  const summary = placed ? recorder.finish(performance.now() / 1000) : null;
  placed = false;
  mode = null;
  routeRun = null;
  resetCourse();
  reticle.visible = false;
  mascot.root.visible = false;
  shadow.visible = false;
  clearRunScene();
  if (sim.world) {
    scene.remove(sim.world.group);
    sim.world = null;
  }
  if (sim.truthLine) {
    scene.remove(sim.truthLine);
    sim.truthLine = null;
  }
  scene.background = null;
  showRunUi(false);
  if (summary) {
    homeScreen.hidden = true;
    summaryScreen.show(summary, recorder.trace, coach.zone);
  }
}

// ---------------------------------------------------------------- runs

/** `laps` > 0 for a course run: how many times round (or there and back) `points` goes. */
function layRoute(points: RoutePoint[], floorY: number, seeds: THREE.Vector3[], runnerS: number, laps = 0) {
  // A course keeps what the map learned while you walked it.
  if (mode?.kind !== 'course') map.reset();
  map.walkableStep = routeRun ? KERB : 0;
  for (const seed of seeds) map.seedGround(seed.x, floorY, seed.z, 1);
  path.setRoute(points, floorY);
  path.group.visible = true;
  // Laps are measured on the path itself (resampling trims a few centimetres).
  const lapLength = laps > 0 ? path.length / laps : 0;
  // On a loop, only draw less than a lap ahead so laps don't stack up on each other. (An
  // out-and-back is windowed to the next turnaround as you go.)
  path.drawAhead = lapLength > 0 && partner.turnarounds.length === 0 ? Math.max(3, lapLength - 1.5) : following ? FOLLOW_DRAW_AHEAD : DRAW_AHEAD;
  follow.reset();
  popAge = POP_TIME;
  blockedCallAt = null;
  mascot.root.scale.setScalar(1);
  collectibles.layout(path.length, Math.min(30, path.drawAhead));
  hud.showScore(0, 0);
  partner.reset(runnerS);
  partner.effort = 1;
  partner.pacing = routeRun ? 'goal' : 'match';
  runStartedAt = performance.now() / 1000;
  coach.reset(runStartedAt);
  callouts.reset(runStartedAt, routeRun?.route.steps, routeRun?.route.distance, lapLength);
  recorder.start(runStartedAt, {
    kind: mode?.kind === 'route' ? 'route' : 'quick',
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
  // A course run gets its own opener ("Loop's ready. Let's go!") instead.
  if (mode?.kind !== 'course') speak({ id: RUN_STARTS[starts++ % RUN_STARTS.length] }, { interrupt: true });
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
    // The way the camera faces. (Aiming from the phone to the tapped spot went sideways or even
    // back towards you when the tap was near your feet.)
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(cameraMatrix).setY(0);
    if (direction.lengthSq() < 0.01) direction.set(start.x - from.x, 0, start.z - from.z);
    direction.normalize();
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
  // The last session's ring is in a different world origin: wait for this one's.
  reticle.visible = false;
  showRunUi(true);
  hud.showControls(false);
  const where = routeRun
    ? 'Face the way your route starts, point at the ground and tap.'
    : mode?.kind === 'course'
      ? 'Point at the floor. When the ring appears, you can record your course.'
      : 'Point at the floor. When the ring appears, tap to start.';
  hud.say(depthEnabled ? where : `${where} (No depth camera on this phone, so obstacle detection is off.)`);
  messageHoldUntil = performance.now() / 1000 + (depthEnabled ? 0 : 5);
});
renderer.xr.addEventListener('sessionend', () => {
  hitTestSource = null;
  groundRays.stop();
  endRun();
});

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  // A course starts from its Record and Done buttons, not a tap on the floor.
  if (placed || !reticle.visible || mode?.kind === 'course') return;
  placeAt(new THREE.Vector3().setFromMatrixPosition(reticle.matrix), renderer.xr.getCamera().matrixWorld);
});
scene.add(controller);

// ---------------------------------------------------------------- walk your course

function setCoursePhase(phase: CoursePhase) {
  course.phase = phase;
  hud.showCoursePanel(phase === 'ready' || phase === 'recording' ? phase : null);
}

function resetCourse() {
  setCoursePhase('find');
  course.recording.clear();
  course.built = null;
  partner.turnarounds = [];
  trail.clear();
  idle.shown = false;
  sim.walk = null;
  summaryScreen.hide();
}

/** Where the phone is (in preview, the simulated walker's eyes). */
function viewerPosition(out: THREE.Vector3) {
  return sim.world ? out.copy(camera.position) : out.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
}

hud.recordButton.onclick = () => beginRecording();
hud.courseDoneButton.onclick = () => finishRecording();
hud.courseRedoButton.onclick = () => {
  if (course.phase !== 'recording') return;
  course.recording.clear();
  trail.clear();
  if (sim.world) previewCourseReady();
  setCoursePhase('ready');
};
byId('sum-again').onclick = () => {
  summaryScreen.hide();
  startCourseRun();
};
byId('sum-new').onclick = () => {
  summaryScreen.hide();
  course.built = null;
  if (sim.world) previewCourseReady();
  setCoursePhase(sim.world ? 'ready' : 'find');
};
byId('sum-exit').onclick = () => {
  summaryScreen.hide();
  void leaveRun();
};

function beginRecording() {
  if (course.phase !== 'ready') return;
  course.floorY = sim.world ? 0 : lastFloorY;
  course.recording.clear();
  trail.clear();
  // The map learns the floor afresh from this walk.
  map.reset();
  map.walkableStep = 0;
  const at = viewerPosition(new THREE.Vector3());
  map.seedGround(at.x, course.floorY, at.z, 1);
  recordAt(at);
  reticle.visible = false;
  setCoursePhase('recording');
  if (sim.world) sim.walk = { s: 0 };
}

function recordAt(at: THREE.Vector3) {
  if (!course.recording.add(at.x, at.z)) return;
  trail.add(at.x, course.floorY, at.z);
  // You walked here, so it's floor: the buddy can run it without waiting to see it again.
  map.seedGround(at.x, course.floorY, at.z, 0.4);
}

function finishRecording() {
  if (course.phase !== 'recording') return;
  const built = course.recording.length >= MIN_COURSE ? buildCourse(course.recording.points) : null;
  if (!built) {
    const walked = course.recording.length;
    hud.say(
      walked < MIN_COURSE
        ? `Walk a bit further: at least ${MIN_COURSE} m, then tap Done. (${walked.toFixed(1)} m so far.)`
        : 'That doubles straight back after only a couple of metres. Walk further out, then tap Done.',
    );
    messageHoldUntil = performance.now() / 1000 + 3;
    return;
  }
  course.built = built;
  sim.walk = null;
  startCourseRun();
}

/** Run the recorded course, starting from wherever you are on it. */
function startCourseRun() {
  const built = course.built;
  if (!built) return;
  const from = viewerPosition(new THREE.Vector3());
  const run = courseRun(built, { x: from.x, z: from.z });
  trail.clear();
  setCoursePhase('running');
  for (const p of resample(built.points, 0.5)) map.seedGround(p.x, course.floorY, p.z, 0.4);
  partner.turnarounds = run.turnarounds;
  layRoute(run.points, course.floorY, [], 0, run.laps);
  const runnerS = path.project(from);
  partner.reset(runnerS);
  sim.runnerS = runnerS;
  idle.shown = false;
  const metres = Math.round(built.length);
  speak(
    built.kind === 'loop'
      ? { id: 'course_ready_loop', bubble: `A ${metres} m loop. Let's go!` }
      : { id: 'course_ready_line', bubble: `${metres} m out and back. Let's go!` },
  );
}

/** Finish on a course: the summary goes over the camera view and AR stays open for another go. */
function finishCourseRun() {
  const summary = recorder.finish(performance.now() / 1000);
  placed = false;
  partner.turnarounds = [];
  path.pointAt(partner.s, idle.at);
  idle.shown = true;
  clearRunScene();
  setCoursePhase('summary');
  summaryScreen.show(summary, recorder.trace, coach.zone, hud.root);
}

function courseMessage(): string {
  switch (course.phase) {
    case 'find':
      return 'Point at the floor. When the ring appears, you can record your course.';
    case 'ready':
      return 'Tap Record, then walk your course. End near the start for a loop, or anywhere else to run it out and back.';
    case 'recording':
      return `● Recording: ${course.recording.length.toFixed(1)} m. Tap Done when you've walked it.`;
    default:
      return 'Nice run!';
  }
}

const viewerAt = new THREE.Vector3();
const reticleAt = new THREE.Vector3();

/**
 * Every frame before a run starts (and between runs on a course): record the course if that's
 * under way, and have the buddy stand on the floor facing you, waving, so it's there to see.
 */
function beforeRun(dt: number, seconds: number, now: number, sensorTick: boolean, trackingLost: boolean, frame?: XRFrame, referenceSpace?: XRReferenceSpace | null) {
  // On a phone, nothing to do until the AR session is up.
  if (!sim.world && !renderer.xr.isPresenting) return;
  if (mode?.kind === 'course') {
    if (course.phase === 'find' && reticle.visible) setCoursePhase('ready');
    if (course.phase === 'recording') {
      if (sim.walk) advanceSimWalk(dt);
      // A tracking glitch would record a jump straight across the room: wait for it to recover.
      if (trackingLost) {
        hud.say('Lost track of the floor. Hold the phone steady and point it at the floor ahead.');
        messageHoldUntil = now + 0.5;
      } else recordAt(viewerPosition(viewerAt));
      if (sensorTick) {
        if (sim.world) {
          sim.world.sampleDepth(camera, map, now);
          sim.world.sampleGround(camera, map, now);
        } else if (frame && referenceSpace && depthEnabled) depthPoints = depthSensor.sample(frame, referenceSpace, map, now);
      }
      if (sim.walk && sim.walk.s >= sim.walkLengths.at(-1)!) {
        finishRecording();
        if (placed) return;
      }
    }
    if (now >= messageHoldUntil) hud.say(courseMessage());
  }
  viewerPosition(viewerAt);
  // Stand a little beyond where you're pointing until there's a course to stand on; then stay put.
  const following = mode?.kind !== 'course' || course.phase === 'find' || course.phase === 'ready';
  if (following && reticle.visible) {
    reticleAt.setFromMatrixPosition(reticle.matrix);
    const away = new THREE.Vector3(reticleAt.x - viewerAt.x, 0, reticleAt.z - viewerAt.z);
    if (away.lengthSq() > 0.01) reticleAt.addScaledVector(away.normalize(), 0.6);
    if (idle.shown) idle.at.lerp(reticleAt, Math.min(1, dt * 3));
    else idle.at.copy(reticleAt);
    idle.shown = true;
  }
  mascot.root.visible = shadow.visible = idle.shown;
  if (!idle.shown) return;
  mascot.root.position.copy(idle.at);
  const facing = Math.atan2(viewerAt.x - idle.at.x, viewerAt.z - idle.at.z);
  const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
  mascot.root.rotation.y += turn * Math.min(1, dt * 4);
  mascot.update(dt, seconds, { speed: 0, inPlace: false, grade: 0, idle: true });
  shadow.position.set(idle.at.x, idle.at.y + 0.003, idle.at.z);
  bubble.update(idle.at, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, now);
}

// ---------------------------------------------------------------- desktop preview

function startPreview() {
  showRunUi(true);
  scene.background = new THREE.Color(0x1d2b33);
  sim.runnerS = 0;
  sim.fixClock = 0;
  sim.seed = 48271 * 977;
  if (mode?.kind === 'course') {
    // A room with a table: the simulated walk goes round it (?course=line walks a corridor
    // instead), and a bag is dropped on the course afterwards, to steer round when running it.
    const preview = previewCourse();
    sim.world = new PreviewWorld(false, 30);
    sim.world.addBox(preview.table.x, preview.table.z, preview.table.width, 0.75, preview.table.depth);
    sim.world.addBox(preview.bag.x, preview.bag.z, 0.4, 0.35, 0.3);
    scene.add(sim.world.group);
    previewCourseReady();
    setCoursePhase('ready');
    hud.showControls(false);
    return;
  }
  if (!routeRun && following) {
    // Follow-me: the simulated runner picks its own way (down an L-shaped hallway, across a
    // street, then back the way it came) and the path has to keep up.
    sim.world = new PreviewWorld(false, 80);
    scene.add(sim.world.group);
    const walk = sim.world.addFollowCourse();
    sim.walkPoints = resample(walk.points, 0.1).map((p, i) => ({
      x: p.x + Math.sin(i * 0.12) * 0.04 + gauss() * 0.01,
      z: p.z + Math.cos(i * 0.09) * 0.03 + gauss() * 0.01,
    }));
    sim.walkLengths = cumulativeLengths(sim.walkPoints);
    sim.walk = { s: 0 };
    sim.side = { x: 0, z: 0 };
    const start = new THREE.Vector3(walk.points[0].x, 0, walk.points[0].z);
    camera.position.set(start.x, 1.5, start.z);
    // Tapped while facing a little off down the hallway, as in the field.
    layRoute(demoRoute(start, walk.facing, QUICK_LENGTH), 0, [start], 0);
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

/** `?course=obstacles`: Quick start's preview runs the fixed obstacle course instead of following. */
function obstacleCourse() {
  return new URLSearchParams(location.search).get('course') === 'obstacles';
}

/**
 * Preview courses, as walked: round a table and back near the start (a loop), or along a
 * corridor and round a corner (an out-and-back, with ?course=line). Corners deliberately uneven.
 */
function previewCourse() {
  if (new URLSearchParams(location.search).get('course') === 'line') {
    return {
      walk: [
        { x: 0, z: 0 },
        { x: 0.2, z: -3.5 },
        { x: -0.1, z: -5.2 },
        { x: 1.3, z: -6.6 },
        { x: 3.6, z: -6.9 },
        { x: 5.6, z: -6.5 },
      ],
      table: { x: 2.6, z: -3.4, width: 1.2, depth: 1.6 },
      bag: { x: 0.12, z: -2.3 },
    };
  }
  return {
    walk: [
      { x: 0, z: 0 },
      { x: 1.5, z: -0.3 },
      { x: 1.8, z: -2.2 },
      { x: 1.4, z: -4.2 },
      { x: -0.2, z: -4.5 },
      { x: -1.6, z: -4.0 },
      { x: -1.7, z: -2.0 },
      { x: -1.2, z: -0.4 },
      { x: -0.5, z: 0.1 },
    ],
    table: { x: 0, z: -2.2, width: 1.4, depth: 1.8 },
    bag: { x: 0.6, z: -4.35 },
  };
}

/** Preview: stand at the start of the walk, with the buddy waiting a step ahead to one side. */
function previewCourseReady() {
  sim.seed = 48271 * 977;
  sim.walk = null;
  // A hand-held phone sways as you walk, and tracking jitters a little.
  sim.walkPoints = resample(previewCourse().walk, 0.1).map((p, i) => ({
    x: p.x + Math.sin(i * 0.45) * 0.03 + gauss() * 0.01,
    z: p.z + Math.cos(i * 0.31) * 0.03 + gauss() * 0.01,
  }));
  sim.walkLengths = cumulativeLengths(sim.walkPoints);
  const start = sim.walkPoints[0];
  const ahead = pointAlong(sim.walkPoints, sim.walkLengths, 3);
  camera.position.set(start.x, 1.5, start.z);
  camera.lookAt(ahead.x, 0.2, ahead.z);
  const along = new THREE.Vector3(ahead.x - start.x, 0, ahead.z - start.z).normalize();
  idle.at.set(start.x + along.x * 2.2 - along.z * 0.9, 0, start.z + along.z * 2.2 + along.x * 0.9);
  idle.shown = true;
}

/** Preview: walk the course at a stroll, looking ahead, while it records. */
function advanceSimWalk(dt: number) {
  const walk = sim.walk!;
  walk.s = Math.min(sim.walkLengths.at(-1)!, walk.s + 1.3 * dt);
  const at = pointAlong(sim.walkPoints, sim.walkLengths, walk.s);
  const look = pointAlong(sim.walkPoints, sim.walkLengths, walk.s + 2.5);
  camera.position.set(at.x, 1.5, at.z);
  if (Math.hypot(look.x - at.x, look.z - at.z) > 0.3) camera.lookAt(look.x, 0.2, look.z);
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
  return pointAlong(sim.truthPoints, sim.truthLengths, s);
}

/** The point `s` metres along a polyline whose cumulative lengths are `lengths`. */
function pointAlong(points: RoutePoint[], lengths: number[], s: number): RoutePoint {
  const L = lengths;
  const clamped = Math.min(Math.max(s, 0), L[L.length - 1]);
  let i = 1;
  while (i < L.length - 1 && L[i] < clamped) i++;
  const t = (clamped - L[i - 1]) / (L[i] - L[i - 1] || 1);
  const a = points[i - 1];
  const b = points[i];
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

/** Moves the simulated runner and returns its distance along the displayed path. */
function advanceSim(dt: number, now: number, sensorTick: boolean): number {
  const world = sim.world!;
  // The simulated runner also holds back while the buddy turns round at the end of an out-and-back.
  const stopped = partner.state === 'break' || partner.state === 'blocked' || partner.state === 'done' || partner.state === 'turn';
  const pace = (routeRun ? partner.goalPace : QUICK_PACE) * 0.85;

  if (following) {
    // Follow-me: walk our own way (the runner decides, so not even a blocked buddy stops us:
    // round a hallway corner, the line ahead runs into the wall until we turn), sidestepping with
    // the path when it bends round something. Only a breather stops us.
    const walk = sim.walk!;
    const from = path.project(camera.position);
    if (!partner.breaking) walk.s = Math.min(sim.walkLengths.at(-1)!, walk.s + pace * dt);
    const at = pointAlong(sim.walkPoints, sim.walkLengths, walk.s);
    const look = pointAlong(sim.walkPoints, sim.walkLengths, walk.s + 3);
    // People step aside smoothly (well under a metre a second), whatever the path does.
    const target = path.detourAt(from + 0.3, { x: 0, z: 0 });
    const side = sim.side;
    const dx = target.x - side.x;
    const dz = target.z - side.z;
    const step = Math.min(1, (0.8 * dt) / (Math.hypot(dx, dz) || 1));
    side.x += dx * step;
    side.z += dz * step;
    camera.position.set(at.x + side.x, world.groundHeight(at.x + side.x, at.z + side.z) + 1.5, at.z + side.z);
    if (Math.hypot(look.x - at.x, look.z - at.z) > 0.3) camera.lookAt(look.x + side.x, 0.4, look.z + side.z);
  } else if (!routeRun) {
    // Quick path: jog along the displayed (detoured) path, stopping behind the buddy when it stops.
    let limit = stopped ? partner.s - 1.2 : path.length;
    if (path.status.blockedAtS !== null) limit = Math.min(limit, path.status.blockedAtS - 0.6);
    // Stopping never walks it backwards (it may already be closer than that when the buddy stops).
    sim.runnerS = Math.max(sim.runnerS, Math.min(limit, sim.runnerS + pace * dt));
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
    world.sampleGround(camera, map, now);
  }
  return routeRun || following ? path.project(camera.position) : sim.runnerS;
}

/** The path ahead was re-laid to follow the runner. */
function onFollow(event: FollowEvent) {
  collectibles.extendTo(path.length);
  if (event.kind !== 'respawn') return;
  // Passed: the buddy pops back in ahead, already facing the new way.
  popAge = 0;
  path.tangentAt(partner.s, tangent);
  mascot.root.rotation.y = Math.atan2(tangent.x, tangent.z);
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
    blockedCallAt = null;
    if (partner.state === 'blocked') {
      if (following) blockedCallAt = now + FOLLOW_BLOCKED_WAIT;
      else speak({ id: path.status.blockReason === 'drop' ? 'hazard_drop' : 'hazard_blocked' }, { interrupt: true });
    } else if (partner.state === 'done') {
      speak({ id: 'run_finish', bubble: `We made it! ${formatDistance(recorder.distanceSoFar)}. Great run.` }, { interrupt: true });
    } else if (partner.state === 'stairs' && lastState !== 'wait') {
      speak({ id: 'hazard_stairs' }, { interrupt: true });
    } else if (partner.state === 'turn') {
      // Just the bubble: saying it out loud at every end of a short course gets old fast.
      bubble.show({ text: TURN_QUIPS[turnQuip++ % TURN_QUIPS.length], mood: 'info' }, performance.now() / 1000);
    }
    lastState = partner.state;
    stateSince = now;
  }
  if (blockedCallAt !== null && now >= blockedCallAt) {
    blockedCallAt = null;
    speak({ id: path.status.blockReason === 'drop' ? 'hazard_drop' : 'hazard_blocked' }, { interrupt: true });
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
  if (following) {
    const h = follow.travel.heading;
    rows.push(['follow', `${h ? `${Math.round((Math.atan2(h.x, -h.z) * 180) / Math.PI)}°` : 'no direction yet'}, ${follow.bends} bends, ${follow.respawns} catch-ups`]);
  }
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

  sensorClock += dt;
  const sensorTick = sensorClock >= SENSOR_INTERVAL;
  if (sensorTick) sensorClock = 0;

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
      if (pose) {
        reticle.matrix.fromArray(pose.transform.matrix);
        lastFloorY = pose.transform.position.y;
      }
      // Once a course is being recorded (or has been), the ring has done its job.
      reticle.visible = !!pose && !(mode?.kind === 'course' && course.phase !== 'find' && course.phase !== 'ready');
    }
    if (placed || course.phase === 'recording') rayHits = groundRays.sample(frame, referenceSpace, map, now);
  }

  if (!placed && mode) beforeRun(dt, seconds, now, sensorTick, trackingLost, frame, referenceSpace);

  if (placed && mode) {
    let runnerS: number;
    if (sim.world) {
      runnerS = advanceSim(dt, now, sensorTick);
      runner.copy(camera.position);
    } else {
      runner.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
      runnerS = path.project(runner);
      if (sensorTick && frame && referenceSpace && depthEnabled) depthPoints = depthSensor.sample(frame, referenceSpace, map, now);
    }

    // On an out-and-back, show the way back only once you're nearly at the turn.
    if (partner.turnarounds.length) {
      const nextTurn = partner.turnarounds.find(t => t > runnerS - 0.5) ?? path.length;
      path.drawAhead = Math.min(DRAW_AHEAD, nextTurn - runnerS + PAST_TURN);
      collectibles.showAhead = Math.min(30, path.drawAhead);
    }
    if (following) {
      const event = follow.update(now, runner, runnerS, path, partner);
      if (event) onFollow(event);
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
    // Following, the path's own distances bend and stretch with each re-lay: count what the runner covered.
    recorder.update(now, following ? follow.travel.odometer : runnerS, heart.bpm, partner.breaking);
    announce(now, trackingLost);

    // Stars and coins: in AR the runner is the phone; in preview, the simulated runner on the path.
    const feet = sim.world && !following ? path.pointAt(runnerS, new THREE.Vector3()) : runner;
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
    // At a turnaround, it turns to face the way back while it jogs on the spot.
    const turning = partner.state === 'turn';
    path.tangentAt(turning ? partner.s + 0.35 : partner.s, tangent);
    mascot.root.position.copy(point);
    // Faces down the path while running or looking ahead; turns to face you otherwise.
    const ahead = turning || partner.state === 'run' || partner.state === 'look' || partner.state === 'stairs';
    const facing = ahead ? Math.atan2(tangent.x, tangent.z) : Math.atan2(-tangent.x, -tangent.z);
    const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
    mascot.root.rotation.y += turn * Math.min(1, dt * 5);
    if (popAge < POP_TIME) {
      popAge += dt;
      // Grows back with a little overshoot.
      const t = Math.min(1, popAge / POP_TIME);
      mascot.root.scale.setScalar(1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);
    }
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
  Object.assign(window, { rerev: { path, partner, mascot, map, camera, sim, follow, coach, heart, commands, recorder, voice, hear, getRouteRun: () => routeRun } });
}

void (async () => {
  arSupported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
})();
