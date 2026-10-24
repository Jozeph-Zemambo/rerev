import './style.css';
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { DepthSensor } from './ar/depthSensor';
import { GroundRays } from './ar/groundRays';
import { Hud } from './hud';
import { Mascot } from './partner/mascot';
import { Partner, type PartnerState } from './partner/partner';
import { PreviewWorld } from './sim/previewWorld';
import { HazardMarkers } from './world/hazardMarkers';
import { demoRoute, Path, type RoutePoint } from './world/path';
import { createShadow } from './world/shadow';
import { SurfaceMap } from './world/surfaceMap';

const DEMO_LENGTH = 20;
const PREVIEW_RUNNER_PACE = 1.3;
/** Depth, hazard planning and markers run at ~10 Hz; drawing runs every frame. */
const SENSOR_INTERVAL = 0.1;

const overlay = document.getElementById('overlay')!;
const hud = new Hud();

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 200);
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

const depthSensor = new DepthSensor();
const groundRays = new GroundRays();
let previewWorld: PreviewWorld | null = null;

let placed = false;
let previewRunnerS = 0;
let hitTestSource: XRHitTestSource | null = null;
let depthEnabled = false;
let sensorClock = 0;

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
      return 'Path complete. Nice work!';
  }
}

function startRoute(points: RoutePoint[], floorY: number, seeds: THREE.Vector3[]) {
  map.reset();
  for (const seed of seeds) map.seedGround(seed.x, floorY, seed.z, 1);
  path.setRoute(points, floorY);
  partner.reset();
  previewRunnerS = 0;
  mascot.root.visible = true;
  shadow.visible = true;
  reticle.visible = false;
  placed = true;
  hud.showControls(true);
  hud.breakButton.textContent = 'Take a break';
}

function clearRoute() {
  placed = false;
  mascot.root.visible = false;
  shadow.visible = false;
  markers.clear();
  hud.showControls(false);
  hud.say('Point at the floor. When the ring appears, tap to start a path.');
}

function startPreview() {
  previewWorld ??= new PreviewWorld();
  if (!previewWorld.group.parent) scene.add(previewWorld.group);
  scene.background = new THREE.Color(0x1d2b33);
  startRoute(previewWorld.route, 0, [new THREE.Vector3(0, 0, 0)]);
}

hud.breakButton.onclick = () => {
  partner.setBreak(!partner.breaking);
  hud.breakButton.textContent = partner.breaking ? "Let's go" : 'Take a break';
};
hud.slowerButton.onclick = () => partner.nudgePace(-0.3);
hud.fasterButton.onclick = () => partner.nudgePace(0.3);
hud.resetButton.onclick = () => (previewWorld ? startPreview() : clearRoute());

async function init() {
  const arSupported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
  if (!arSupported) {
    startPreview();
    return;
  }
  hud.say('Tap START AR, then point at the floor.');
  // depthSensing is not in three's ARButton typings yet, but ARButton passes it straight to WebXR.
  const sessionInit = {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'depth-sensing'],
    depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
    domOverlay: { root: overlay },
  };
  document.body.appendChild(ARButton.createButton(renderer, sessionInit as unknown as Parameters<typeof ARButton.createButton>[1]));
}

overlay.addEventListener('beforexrselect', event => event.preventDefault());

renderer.xr.addEventListener('sessionstart', async () => {
  const session = renderer.xr.getSession()!;
  depthEnabled = session.enabledFeatures?.includes('depth-sensing') ?? false;
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
  await groundRays.start(session);
  clearRoute();
  if (!depthEnabled) hud.say('Point at the floor and tap to start. (No depth camera on this phone, so obstacle detection is off.)');
});
renderer.xr.addEventListener('sessionend', () => {
  hitTestSource = null;
  groundRays.stop();
});

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (placed || !reticle.visible) return;
  const start = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const from = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
  const direction = new THREE.Vector3(start.x - from.x, 0, start.z - from.z).normalize();
  startRoute(demoRoute(start, direction, DEMO_LENGTH), start.y, [start, new THREE.Vector3(from.x, start.y, from.z)]);
});
scene.add(controller);

const clock = new THREE.Clock();
const point = new THREE.Vector3();
const tangent = new THREE.Vector3();
const runner = new THREE.Vector3();
const look = new THREE.Vector3();

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

  if (placed) {
    sensorClock += dt;
    const sensorTick = sensorClock >= SENSOR_INTERVAL;
    if (sensorTick) sensorClock = 0;

    let runnerS: number;
    if (previewWorld) {
      runnerS = advancePreviewRunner(dt);
      if (sensorTick) {
        previewWorld.sampleDepth(camera, map, now);
        previewWorld.sampleGround(camera, map);
      }
    } else {
      runner.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
      runnerS = path.project(runner);
      if (sensorTick && frame && referenceSpace && depthEnabled) depthSensor.sample(frame, referenceSpace, map, now);
    }

    path.update(dt, seconds, runnerS, map, now, sensorTick);
    partner.update(dt, runnerS);

    path.pointAt(partner.s, point);
    path.tangentAt(partner.s, tangent);
    mascot.root.position.copy(point);
    // Faces down the path while running or looking ahead; turns to face you otherwise.
    const facing = partner.state === 'run' || partner.state === 'look' ?Math.atan2(tangent.x, tangent.z) : Math.atan2(-tangent.x, -tangent.z);
    const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
    mascot.root.rotation.y += turn * Math.min(1, dt * 5);
    mascot.update(dt, seconds, partner.gait);
    shadow.position.set(point.x, point.y + 0.003, point.z);

    if (sensorTick) markers.update(map, previewWorld ? camera.position : runner, now);

    hud.update({ paceMetersPerSecond: partner.currentSpeed, leadMeters: Math.max(0, partner.s - runnerS) });
    hud.say(stateMessage(partner.state));
  }

  renderer.render(scene, camera);
});

/** The simulated runner jogs along the displayed path and stops behind the partner when it stops. */
function advancePreviewRunner(dt: number): number {
  const partnerStopped = partner.state === 'break' || partner.state === 'blocked' || partner.state === 'done';
  let limit = partnerStopped ? partner.s - 1.2 : path.length;
  if (path.status.blockedAtS !== null) limit = Math.min(limit, path.status.blockedAtS - 0.6);
  previewRunnerS = Math.min(limit, previewRunnerS + PREVIEW_RUNNER_PACE * dt);
  path.pointAt(previewRunnerS - 0.8, point);
  const eye = previewWorld!.groundHeight(point.x, point.z) + 1.5;
  camera.position.set(point.x, eye, point.z);
  path.pointAt(previewRunnerS + 3, look);
  camera.lookAt(look.x, look.y + 0.4, look.z);
  return previewRunnerS;
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

if (import.meta.env.DEV) {
  Object.assign(window, { rerev: { path, partner, map, camera, getRunnerS: () => previewRunnerS } });
}

void init();
