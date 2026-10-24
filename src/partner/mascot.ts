import * as THREE from 'three';

export type Gait = {
  /** Forward speed in metres per second. */
  speed: number;
  /** Jogging on the spot (waiting for you, or on a break). */
  inPlace: boolean;
};

/**
 * A cartoon bean built from primitives and animated procedurally, so it needs no rig or
 * model file. Faces +Z. About 1 m tall.
 */
export class Mascot {
  readonly root = new THREE.Group();

  private readonly body = new THREE.Group();
  private readonly torso: THREE.Mesh;
  private readonly legs: THREE.Group[];
  private readonly arms: THREE.Group[];
  private phase = 0;
  private swing = 0;
  private lean = 0;

  constructor(color: THREE.ColorRepresentation = 0x45c08f) {
    const skin = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
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

  update(dt: number, timeSeconds: number, gait: Gait) {
    const moving = gait.inPlace || gait.speed > 0.15;
    const targetSwing = gait.inPlace ? 0.75 : THREE.MathUtils.clamp(gait.speed / 2.4, 0, 1);
    this.swing += ((moving ? targetSwing : 0) - this.swing) * Math.min(1, dt * 6);
    this.lean += (THREE.MathUtils.clamp(gait.speed / 3, 0, 1) * 0.2 - this.lean) * Math.min(1, dt * 4);

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
  }
}
