import * as THREE from 'three';
import type { Gait } from './buddyMotion';

/** While idle, waves for WAVE_FOR seconds out of every WAVE_EVERY. */
const WAVE_EVERY = 4.5;
const WAVE_FOR = 1.8;

/** Height of the bean's head, in metres. */
export const BEAN_HEIGHT = 1.02;

/**
 * A cartoon bean built from primitives and animated procedurally, so it needs no rig or
 * model file. Faces +Z. BEAN_HEIGHT tall. Stands in for the buddy model while it loads, or if
 * it can't be loaded.
 */
export class Bean {
  readonly root = new THREE.Group();

  private readonly body = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly legs: THREE.Group[];
  private readonly arms: THREE.Group[];
  private phase = 0;
  private swing = 0;
  private lean = 0;
  private idle = 0;
  private wave = 0;
  private readonly skin: THREE.MeshStandardMaterial;

  constructor(color: THREE.ColorRepresentation = 0x45c08f) {
    const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    this.skin = skin;
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14201b, roughness: 0.4 });

    this.root.add(this.body);

    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.34, 8, 24), skin);
    this.torso.position.y = 0.65;
    this.body.add(this.torso);

    for (const x of [-0.075, 0.075]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.068, 24, 16), white);
      eye.position.set(x, 0.84, 0.165);
      eye.scale.set(1, 1.15, 0.7);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 16, 12), dark);
      pupil.position.set(x * 0.9, 0.83, 0.21);
      this.body.add(eye, pupil);
    }
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.01, 8, 20, Math.PI), dark);
    smile.position.set(0, 0.745, 0.195);
    smile.rotation.z = Math.PI;
    this.body.add(smile);

    this.legs = [-0.09, 0.09].map(x => {
      const hip = new THREE.Group();
      hip.position.set(x, 0.3, 0);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.14, 6, 12), skin);
      leg.position.y = -0.13;
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), dark);
      foot.scale.set(1, 0.55, 1.45);
      foot.position.set(0, -0.265, 0.03);
      hip.add(leg, foot);
      this.root.add(hip);
      return hip;
    });

    this.arms = [-1, 1].map(sideSign => {
      const shoulder = new THREE.Group();
      shoulder.position.set(sideSign * 0.205, 0.78, 0);
      shoulder.rotation.z = sideSign * 0.28;
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.14, 6, 12), skin);
      arm.position.y = -0.11;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.052, 16, 12), skin);
      hand.position.y = -0.22;
      shoulder.add(arm, hand);
      this.body.add(shoulder);
      return shoulder;
    });
  }

  setColor(color: THREE.ColorRepresentation) {
    this.skin.color.set(color);
  }

  update(dt: number, timeSeconds: number, gait: Gait) {
    const moving = gait.inPlace || gait.speed > 0.15;
    const targetSwing = gait.inPlace ? 0.75 : THREE.MathUtils.clamp(gait.speed / 2.4, 0, 1);
    this.swing += ((moving ? targetSwing : 0) - this.swing) * Math.min(1, dt * 6);
    // Leans into the run, more on uphills, back a touch on downhills.
    const hillLean = THREE.MathUtils.clamp(gait.grade * 1.5, -0.15, 0.3);
    const targetLean = THREE.MathUtils.clamp(gait.speed / 3, 0, 1) * 0.2 + (gait.inPlace ? 0 : hillLean);
    this.lean += (targetLean - this.lean) * Math.min(1, dt * 4);

    const strideHz = gait.inPlace ? 2.6 : 1.1 + gait.speed * 0.55;
    this.phase += dt * Math.PI * 2 * strideHz;
    const s = Math.sin(this.phase);

    this.legs[0].rotation.x = s * 0.95 * this.swing;
    this.legs[1].rotation.x = -s * 0.95 * this.swing;
    this.arms[0].rotation.x = -s * 1.1 * this.swing;
    this.arms[1].rotation.x = s * 1.1 * this.swing;

    // Bounce on each footfall, squash a little on landing, breathe when idle.
    const bounce = Math.abs(s) * 0.06 * this.swing;
    this.body.position.y = bounce;
    this.body.rotation.x = this.lean;
    const breathe = (1 - this.swing) * Math.sin(timeSeconds * 2.2) * 0.015;
    this.torso.scale.set(1, 1 - Math.abs(Math.cos(this.phase)) * 0.05 * this.swing + breathe, 1);

    // Idle: bob on the spot and wave one arm overhead every few seconds. Only the pose changes.
    this.idle += ((gait.idle ? 1 : 0) - this.idle) * Math.min(1, dt * 4);
    const waving = gait.idle && timeSeconds % WAVE_EVERY < WAVE_FOR;
    this.wave += ((waving ? 1 : 0) - this.wave) * Math.min(1, dt * 6);
    this.body.position.y += Math.abs(Math.sin(timeSeconds * 3.2)) * 0.025 * this.idle;
    const right = this.arms[1];
    right.rotation.z = 0.28 + this.wave * (2.3 + Math.sin(timeSeconds * 11) * 0.35);
    if (this.wave > 0.01) right.rotation.x *= 1 - this.wave;
  }
}
