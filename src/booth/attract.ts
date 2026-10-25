import './attract.css';
import * as THREE from 'three';
import { BUDDY_NAMES, type BuddyColor } from '../partner/buddies';
import { BOOTH_MOTION } from '../partner/buddyMotion';
import { BUDDY_HEIGHT, Mascot } from '../partner/mascot';
import { createShadow } from '../world/shadow';

/**
 * The laptop's attract screen (/?booth): Rev and Vita, big, side by side, doing what they do in
 * AR at the booth (Rev idles, Vita waves), with their names and the tagline. Nothing to press:
 * Esc goes back to the app.
 */

/** Left to right as read: "Rev · Vita". x in metres from the middle. */
const CAST: { color: BuddyColor; x: number; turn: number }[] = [
  { color: 'blue', x: -0.7, turn: 0.2 },
  { color: 'pink', x: 0.7, turn: -0.2 },
];
/** How wide and tall the pair (with a margin) must fit on screen, in metres. */
const FRAME_WIDTH = 2.8;
/** The buddies take up this much of the screen's height... */
const FILL = 0.6;
/** ...with their feet this far down it (0 = top), leaving room for the names and tagline. */
const FEET_AT = 0.72;
const FOV = 26;

document.body.classList.add('attract');
document.title = 'ReReV · Rev & Vita';

const root = document.createElement('div');
root.className = 'attract-root';
document.body.appendChild(root);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
root.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
scene.add(new THREE.HemisphereLight(0xfff1dc, 0xc9a98a, 2.3));
const key = new THREE.DirectionalLight(0xfff4e6, 1.5);
key.position.set(-1.6, 4, 3);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.radius = 6;
key.shadow.bias = -0.0005;
Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.5, far: 10 });
scene.add(key);

// A warm pool of light on the floor, the soft cast shadows on it, and a contact blob under each.
scene.add(floorGlow());
const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ color: 0x5a3216, opacity: 0.14 }));
ground.receiveShadow = true;
scene.add(ground);

const buddies = CAST.map(({ color, x, turn }, i) => {
  const mascot = new Mascot(color);
  mascot.castShadows = true;
  mascot.root.position.x = x;
  mascot.root.rotation.y = turn;
  scene.add(mascot.root);
  const blob = createShadow();
  blob.position.set(x, 0.002, 0);
  scene.add(blob);
  const name = document.createElement('p');
  name.className = 'attract-name';
  name.dataset.buddy = color;
  name.textContent = BUDDY_NAMES[color];
  root.appendChild(name);
  return { color, x, turn, mascot, name, phase: i * 2.1 };
});

const eyebrow = document.createElement('p');
eyebrow.className = 'attract-eyebrow';
eyebrow.textContent = 'Meet your AR running buddies';
root.appendChild(eyebrow);

const tagline = document.createElement('p');
tagline.className = 'attract-tagline';
tagline.innerHTML = '<span class="logo">Re<span>Re</span>V</span><span class="dot">·</span>revitalise your run';
root.appendChild(tagline);

const exit = document.createElement('button');
exit.type = 'button';
exit.className = 'attract-exit';
exit.textContent = 'Esc · back to the app';
root.appendChild(exit);

function leave() {
  location.href = location.pathname;
}
exit.onclick = leave;
addEventListener('keydown', e => {
  if (e.key === 'Escape') leave();
});

// Hide the cursor (and the way out) unless the mouse is moving.
let idleTimer = 0;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => document.body.classList.add('idle'), 2500);
}
addEventListener('pointermove', wake);
wake();

/** Where the camera sits, for the window's shape: the pair fills FILL of the height, or fits the width. */
const aim = { y: 0, distance: 0, height: 0 };
function frame() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const byHeight = BUDDY_HEIGHT / FILL / (2 * tan);
  const byWidth = FRAME_WIDTH / (2 * tan * camera.aspect);
  aim.distance = Math.max(byHeight, byWidth);
  const visible = 2 * aim.distance * tan;
  // Centre of the view, so the feet land FEET_AT down the screen.
  aim.y = (FEET_AT - 0.5) * visible;
  aim.height = aim.y + 0.35;
  camera.updateProjectionMatrix();
}
addEventListener('resize', frame);
frame();

const clock = new THREE.Clock();
const at = new THREE.Vector3();
let shown = false;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  // A slow drift of the camera, so the pair feels present rather than pasted on.
  camera.position.set(Math.sin(t * 0.21) * 0.12, aim.height + Math.sin(t * 0.33) * 0.03, aim.distance);
  camera.lookAt(0, aim.y, 0);
  camera.updateMatrixWorld();

  for (const buddy of buddies) {
    // Turned a little toward the middle, swaying gently as if glancing at passers-by.
    buddy.mascot.root.rotation.y = buddy.turn + Math.sin(t * 0.4 + buddy.phase) * 0.07;
    buddy.mascot.perform(dt, t, BOOTH_MOTION[buddy.color]);
    // Names sit just under the feet, wherever the window puts them.
    at.set(buddy.x, -0.09, 0).project(camera);
    const x = ((at.x + 1) / 2) * innerWidth;
    const y = ((1 - at.y) / 2) * innerHeight;
    buddy.name.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`;
  }
  if (!shown) {
    shown = true;
    for (const buddy of buddies) buddy.name.classList.add('ready');
  }
  renderer.render(scene, camera);
});

/** A soft sunny disc on the floor under the pair. */
function floorGlow() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255, 196, 120, 0.55)');
  gradient.addColorStop(0.55, 'rgba(255, 210, 150, 0.25)');
  gradient.addColorStop(1, 'rgba(255, 220, 170, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 2.6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }),
  );
  mesh.position.y = 0.001;
  return mesh;
}
