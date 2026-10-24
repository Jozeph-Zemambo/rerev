import './style.css';
import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { Hud } from './hud';
import { Mascot } from './partner/mascot';
import { Partner, type PartnerState } from './partner/partner';
import { Path } from './world/path';
import { createShadow } from './world/shadow';

const PATH_LENGTH = 20;
const PREVIEW_RUNNER_PACE = 1.3;

const overlay = document.getElementById('overlay')!;
const hud = new Hud();

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 100);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 3, 2);
scene.add(sun);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x45c08f }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const path = new Path();
scene.add(path.group);
const mascot = new Mascot();
mascot.root.visible = false;
scene.add(mascot.root);
const shadow = createShadow();
shadow.visible = false;
scene.add(shadow);
const partner = new Partner(path);

let placed = false;
let preview = false;
let previewRunnerS = 0;
let floorY = 0;
let hitTestSource: XRHitTestSource | null = null;

const STATE_MESSAGES: Record<PartnerState, string> = {
  run: 'Running with you. Keep it steady!',
  wait: "I'll wait up for you. Catch up when you're ready.",
  break: 'Taking a breather. Tap "Let\'s go" when you are ready.',
  done: 'Path complete. Nice work!',
};

function placePath(start: THREE.Vector3, from: THREE.Vector3) {
  floorY = start.y;
  const direction = new THREE.Vector3(start.x - from.x, 0, start.z - from.z).normalize();
  path.build(start, direction, PATH_LENGTH);
  partner.reset();
  previewRunnerS = 0;
  mascot.root.visible = true;
  shadow.visible = true;
  reticle.visible = false;
  placed = true;
  hud.showControls(true);
}

function clearPath() {
  placed = false;
  mascot.root.visible = false;
  shadow.visible = false;
  path.group.clear();
  hud.showControls(false);
  hud.say('Point at the floor. When the green ring appears, tap to start a path.');
}

hud.breakButton.onclick = () => {
  const onBreak = partner.state !== 'break';
  partner.setBreak(onBreak);
  hud.breakButton.textContent = onBreak ? "Let's go" : 'Take a break';
};
hud.slowerButton.onclick = () => partner.nudgePace(-0.3);
hud.fasterButton.onclick = () => partner.nudgePace(0.3);
hud.resetButton.onclick = () => {
  if (preview) placePath(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0));
  else clearPath();
};

async function init() {
  const arSupported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
  if (!arSupported) {
    preview = true;
    scene.background = new THREE.Color(0x0f1d17);
    const grid = new THREE.GridHelper(40, 40, 0x2c4a3e, 0x1a2e26);
    scene.add(grid);
    placePath(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0));
    hud.say('Preview mode: no AR on this device. On your phone, tap START AR.');
    return;
  }
  hud.say('Tap START AR, then point at the floor.');
  document.body.appendChild(
    ARButton.createButton(renderer, {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: overlay },
    }),
  );
}

overlay.addEventListener('beforexrselect', event => event.preventDefault());

renderer.xr.addEventListener('sessionstart', async () => {
  const session = renderer.xr.getSession()!;
  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
  clearPath();
});
renderer.xr.addEventListener('sessionend', () => {
  hitTestSource = null;
});

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (placed || !reticle.visible) return;
  const start = new THREE.Vector3().setFromMatrixPosition(reticle.matrix);
  const from = new THREE.Vector3().setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
  placePath(start, from);
});
scene.add(controller);

const clock = new THREE.Clock();
const point = new THREE.Vector3();
const tangent = new THREE.Vector3();
const runnerPosition = new THREE.Vector3();

renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const seconds = time / 1000;

  if (frame && hitTestSource && !placed) {
    const hits = frame.getHitTestResults(hitTestSource);
    const pose = hits[0]?.getPose(renderer.xr.getReferenceSpace()!);
    reticle.visible = !!pose;
    if (pose) reticle.matrix.fromArray(pose.transform.matrix);
  }

  if (placed) {
    let runnerS: number;
    if (preview) {
      if (partner.state !== 'break') previewRunnerS = Math.min(path.length, previewRunnerS + PREVIEW_RUNNER_PACE * dt);
      runnerS = previewRunnerS;
      path.pointAt(runnerS - 1.2, camera.position).setY(1.35);
      camera.lookAt(path.pointAt(runnerS + 3, point).setY(0.5));
    } else {
      runnerPosition.setFromMatrixPosition(renderer.xr.getCamera().matrixWorld);
      runnerS = path.project(runnerPosition);
    }

    partner.update(dt, runnerS);
    path.pointAt(partner.s, point);
    path.tangentAt(partner.s, tangent);
    mascot.root.position.set(point.x, floorY, point.z);
    // Runs facing down the path; turns to face you while waiting or on a break.
    const facing = partner.state === 'run' ? Math.atan2(tangent.x, tangent.z) : Math.atan2(-tangent.x, -tangent.z);
    const turn = Math.atan2(Math.sin(facing - mascot.root.rotation.y), Math.cos(facing - mascot.root.rotation.y));
    mascot.root.rotation.y += turn * Math.min(1, dt * 5);
    mascot.update(dt, seconds, partner.gait);
    shadow.position.set(point.x, floorY + 0.003, point.z);
    path.update(seconds, runnerS);

    hud.update({ paceMetersPerSecond: partner.currentSpeed, leadMeters: Math.max(0, partner.s - runnerS) });
    hud.say(STATE_MESSAGES[partner.state]);
  }

  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

void init();
