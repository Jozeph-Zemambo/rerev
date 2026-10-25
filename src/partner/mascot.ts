import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Bean, BEAN_HEIGHT } from './bean';
import type { BuddyColor } from './buddies';
import { buddyMotion, type Gait } from './buddyMotion';
import { BuddyPacer } from './buddyPace';

export type { Gait } from './buddyMotion';
export { BUDDY_COLORS, type BuddyColor } from './buddies';

/**
 * The buddy's height in metres: the one setting for its size. The model is scaled to it (and
 * its pace maths told) through the pacer; the bubble and blob shadow follow it too.
 */
export const BUDDY_HEIGHT = 1.3;

const MODELS: Record<BuddyColor, { file: string; bean: number }> = {
  blue: { file: 'buddy.glb', bean: 0x6ec3ea },
  pink: { file: 'buddy_girl.glb', bean: 0xf6a8c8 },
};

/** Two-step light ramp: one hard shadow step, the toon look. */
const ramp = new THREE.DataTexture(new Uint8Array([150, 255]), 2, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.needsUpdate = true;

/**
 * Inverted-hull outline: the back faces of a copy of the mesh, pushed out along the normals and
 * drawn dark, peek out round the edges. Unlike OutlineEffect it needs no second scene render, so
 * it's safe in the WebXR loop. Pushed out before skinning, in model metres (as built).
 */
const OUTLINE_WIDTH = 0.006;
const outline = new THREE.MeshBasicMaterial({ color: 0x241c26, side: THREE.BackSide });
outline.onBeforeCompile = shader => {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\n\ttransformed += normalize( normal ) * ${OUTLINE_WIDTH.toFixed(4)};`,
  );
};
/** Parts that get an outline. Not the cheeks, pupils, mouth or headband stripe: they're painted on. */
const OUTLINED = new Set(['Body', 'EyeWhite', 'Shoe', 'Sole', 'Headband']);

/** Leans into hills (rise over run → radians), capped; none while on the spot. */
const HILL_LEAN = 1.5;
const MAX_UPHILL_LEAN = 0.3;
const MAX_DOWNHILL_LEAN = 0.15;
/** The first wave or beckon comes this soon after starting to idle or wait. */
const FIRST_FLOURISH = 1.2;

type Loaded = { model: THREE.Object3D; pacer: BuddyPacer };

const loader = new GLTFLoader();

/**
 * The running buddy: a rigged cartoon model, animated from the partner's gait. Faces +Z with its
 * feet at the origin of `root`, which the app moves and turns along the path. Shows the
 * procedural bean until the model has loaded, or if it can't be.
 */
export class Mascot {
  readonly root = new THREE.Group();

  private readonly bean = new Bean();
  /** Holds the model inside `root` and tilts it on hills; the pacer only animates the limbs. */
  private readonly holder = new THREE.Group();
  private buddy: Loaded | null = null;
  private color: BuddyColor | null = null;
  private loads = 0;
  private lean = 0;
  /** Which looping motion is playing ('' after a swap, so the next update starts it afresh). */
  private motionKey = '';
  private flourishClock = 0;
  private running = false;

  constructor(color: BuddyColor) {
    this.bean.root.scale.setScalar(BUDDY_HEIGHT / BEAN_HEIGHT);
    this.root.add(this.bean.root, this.holder);
    this.setColor(color);
  }

  /** Load the blue or pink buddy and swap it in once it's ready. */
  setColor(color: BuddyColor) {
    if (color === this.color) return;
    this.color = color;
    this.bean.setColor(MODELS[color].bean);
    const load = ++this.loads;
    loader
      .loadAsync(`${import.meta.env.BASE_URL}models/${MODELS[color].file}`)
      .then(gltf => {
        if (load !== this.loads) return dispose(gltf.scene);
        this.swapIn(gltf.scene, gltf.animations);
      })
      .catch(err => console.warn(`Couldn't load the ${color} buddy; keeping the bean.`, err));
  }

  update(dt: number, timeSeconds: number, gait: Gait) {
    if (!this.buddy) {
      this.bean.update(dt, timeSeconds, gait);
      return;
    }
    const hill = gait.inPlace || gait.idle ? 0 : THREE.MathUtils.clamp(gait.grade * HILL_LEAN, -MAX_DOWNHILL_LEAN, MAX_UPHILL_LEAN);
    this.lean += (hill - this.lean) * Math.min(1, dt * 4);
    this.holder.rotation.x = this.lean;

    const pacer = this.buddy.pacer;
    const motion = buddyMotion(gait, this.running, BUDDY_HEIGHT);
    this.running = motion.kind === 'pace';
    if (motion.kind === 'pace') {
      pacer.run(motion.speed);
      this.motionKey = 'pace';
    } else {
      const { clip, flourish } = motion;
      const key = `${clip}+${flourish?.clip ?? ''}`;
      if (key !== this.motionKey) {
        this.motionKey = key;
        pacer.play(clip);
        this.flourishClock = flourish ? flourish.every - FIRST_FLOURISH : 0;
      } else if (flourish) {
        // Every `every` seconds from the start of one flourish to the next.
        this.flourishClock += dt;
        if (this.flourishClock >= flourish.every && pacer.current === clip) {
          this.flourishClock = 0;
          pacer.playThen(flourish.clip, flourish.repeats, clip);
        }
      }
    }
    pacer.update(dt);
  }

  private swapIn(model: THREE.Object3D, animations: THREE.AnimationClip[]) {
    dress(model);
    if (this.buddy) {
      this.buddy.pacer.dispose();
      this.holder.remove(this.buddy.model);
      dispose(this.buddy.model);
    }
    // Only ever sized through the pacer, so its pace maths knows the height and the feet don't slide.
    this.buddy = { model, pacer: new BuddyPacer(model, animations, { height: BUDDY_HEIGHT }) };
    this.holder.add(model);
    this.bean.root.visible = false;
    this.motionKey = '';
    this.running = false;
  }
}

/** Toon materials, and an outline hull on the main parts. */
function dress(model: THREE.Object3D) {
  const hulls: THREE.SkinnedMesh[] = [];
  model.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Skinned meshes move outside their rest-pose bounds, so culling would make limbs vanish.
    mesh.frustumCulled = false;
    const old = mesh.material as THREE.MeshStandardMaterial;
    mesh.material = new THREE.MeshToonMaterial({ color: old.color, gradientMap: ramp });
    old.dispose();
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh && OUTLINED.has(old.name)) hulls.push(mesh as THREE.SkinnedMesh);
  });
  for (const mesh of hulls) {
    const hull = new THREE.SkinnedMesh(mesh.geometry, outline);
    hull.bind(mesh.skeleton, mesh.bindMatrix);
    hull.position.copy(mesh.position);
    hull.quaternion.copy(mesh.quaternion);
    hull.scale.copy(mesh.scale);
    hull.frustumCulled = false;
    mesh.parent!.add(hull);
  }
}

function dispose(model: THREE.Object3D) {
  model.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    if (mesh.material !== outline) (mesh.material as THREE.Material).dispose();
  });
}
