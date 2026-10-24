import * as THREE from 'three';

/**
 * Drives the buddy model's animations from the runner's speed (ported from the model kit's
 * buddy-pace.js). Works with buddy.glb and buddy_girl.glb: same skeleton, same clips.
 *
 *   const pacer = new BuddyPacer(gltf.scene, gltf.animations, { height: 1.3 });
 *   pacer.play('Idle');        // any clip by name: Idle, Wave, Beckon, JogInPlace
 *   pacer.run(speedMps);       // auto jog → run; call whenever the speed changes
 *   pacer.update(dt);          // every frame, instead of mixer.update(dt)
 *
 * The app still moves the buddy along the path itself; this only makes the legs match that
 * movement so the feet don't slide.
 */

/** Height the .glb files are exported at, in metres. */
export const BUILT_HEIGHT = 1.075;

export type RunClip = 'Run_Jogging' | 'Run_JogForward';
export type BuddyClip = 'Idle' | 'Wave' | 'Beckon' | 'JogInPlace' | RunClip;

/**
 * Natural ground speed (m/s) and steps per second of each run clip played at 1x, at
 * BUILT_HEIGHT. Measured in Blender from how fast the planted foot slides back in the in-place
 * clip. Both scale with the buddy's height.
 */
export const GAITS: Record<RunClip, { speed: number; stepsPerSecond: number }> = {
  Run_Jogging: { speed: 0.79, stepsPerSecond: 2.34 },
  Run_JogForward: { speed: 1.17, stepsPerSecond: 3.0 },
};

/**
 * How the buddy keeps up as the runner speeds up:
 *   1. jog, playing the jog clip faster and faster, up to maxLegSpeed;
 *   2. switch to the run clip;
 *   3. play the run faster, up to maxLegSpeed;
 *   4. then lengthen the stride, up to maxStride;
 *   5. past that, the legs just go faster (cartoon scurry).
 */
export const PACE_DEFAULTS = {
  /** How much faster than a clip's own speed it can play and still look natural. */
  maxLegSpeed: 1.15,
  /** Longest stride, as a multiple of the clip's own. */
  maxStride: 1.6,
  /** Slower than this the jog looks like slow motion; better to show JogInPlace or Idle. */
  minLegSpeed: 0.6,
  /** Jog↔run switch hysteresis, so it doesn't flicker between clips at the boundary. */
  switchMargin: 0.05,
  /** Seconds to blend between clips. */
  crossfade: 0.3,
};
export type PaceOptions = typeof PACE_DEFAULTS;

export type PacePlan = {
  clip: RunClip;
  legSpeed: number;
  stride: number;
  stepsPerSecond: number;
  tooSlow: boolean;
};

/**
 * Pick the clip, leg speed and stride for a runner speed (m/s) at a height (m). `current` is the
 * clip playing now, for hysteresis.
 */
export function pacePlan(
  speed: number,
  height = BUILT_HEIGHT,
  current: string | null = null,
  options: Partial<PaceOptions> = PACE_DEFAULTS,
): PacePlan {
  const o = { ...PACE_DEFAULTS, ...options };
  const size = height / BUILT_HEIGHT;

  // Switch to the run once the jog would have to play faster than looks natural.
  const switchAt = GAITS.Run_Jogging.speed * size * o.maxLegSpeed;
  const margin = current === 'Run_JogForward' ? 1 - o.switchMargin : 1 + o.switchMargin;
  const clip: RunClip = speed > switchAt * margin ? 'Run_JogForward' : 'Run_Jogging';

  const boost = speed / (GAITS[clip].speed * size); // = legSpeed × stride
  let legSpeed: number;
  let stride: number;
  if (clip === 'Run_Jogging' || boost <= o.maxLegSpeed) {
    legSpeed = boost;
    stride = 1;
  } else if (boost <= o.maxLegSpeed * o.maxStride) {
    legSpeed = o.maxLegSpeed;
    stride = boost / o.maxLegSpeed;
  } else {
    stride = o.maxStride;
    legSpeed = boost / o.maxStride;
  }
  return {
    clip,
    legSpeed,
    stride,
    stepsPerSecond: GAITS[clip].stepsPerSecond * legSpeed,
    tooSlow: legSpeed < o.minLegSpeed,
  };
}

/**
 * How much of the stride boost each limb bone gets. Hips swing the full amount; knees,
 * shoulders and elbows follow less, or the back kick and elbow pump get cartoonishly big.
 */
const STRIDE_SHARE: Record<string, number> = { UpLeg: 1, Leg: 0.5, Arm: 0.6, ForeArm: 0.3 };

/** Average rotation of every bone over a clip: the middle of each limb's swing. */
function swingCenters(clip: THREE.AnimationClip) {
  const centers: Record<string, THREE.Quaternion> = {};
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const v = track.values;
    const sum = new THREE.Quaternion(0, 0, 0, 0);
    const q = new THREE.Quaternion();
    const first = new THREE.Quaternion(v[0], v[1], v[2], v[3]);
    for (let i = 0; i < v.length; i += 4) {
      q.set(v[i], v[i + 1], v[i + 2], v[i + 3]);
      const sign = q.dot(first) < 0 ? -1 : 1; // keep every sample on the same side
      sum.x += sign * q.x;
      sum.y += sign * q.y;
      sum.z += sign * q.z;
      sum.w += sign * q.w;
    }
    centers[track.name.slice(0, -'.quaternion'.length)] = sum.normalize();
  }
  return centers;
}

type Limb = { bone: THREE.Bone; share: number; raw: THREE.Quaternion | null };

export class BuddyPacer {
  readonly model: THREE.Object3D;
  readonly options: PaceOptions;
  readonly mixer: THREE.AnimationMixer;
  readonly actions: Record<string, THREE.AnimationAction> = {};
  /** Set a number to force the stride (for testing). */
  strideOverride: number | null = null;
  /** The latest pacePlan while running, else null. */
  plan: PacePlan | null = null;
  /** Name of the clip playing. */
  current: string | null = null;
  height = BUILT_HEIGHT;
  speed = 0;

  private readonly centers: Record<string, Record<string, THREE.Quaternion>> = {};
  private readonly limbs: Limb[] = [];
  /** A playThen in progress: the clip to go back to once `action` has finished its repeats. */
  private then: { action: THREE.AnimationAction; name: BuddyClip; thenName: BuddyClip } | null = null;

  constructor(
    model: THREE.Object3D,
    animations: THREE.AnimationClip[],
    { height = BUILT_HEIGHT, options = {} }: { height?: number; options?: Partial<PaceOptions> } = {},
  ) {
    this.model = model;
    this.options = { ...PACE_DEFAULTS, ...options };
    this.mixer = new THREE.AnimationMixer(model);
    for (const clip of animations) {
      this.actions[clip.name] = this.mixer.clipAction(clip);
      this.centers[clip.name] = swingCenters(clip);
    }
    model.traverse(o => {
      const part = (o as THREE.Bone).isBone ? o.name.match(/(UpLeg|ForeArm|Arm|Leg)$/) : null;
      if (part) this.limbs.push({ bone: o as THREE.Bone, share: STRIDE_SHARE[part[1]], raw: null });
    });
    this.mixer.addEventListener('finished', e => {
      const then = this.then;
      if (!then || e.action !== then.action) return;
      this.endThen();
      if (this.current === then.name) this.play(then.thenName);
    });
    this.setHeight(height);
  }

  /** Scale the buddy; its natural speed scales with it. */
  setHeight(height: number) {
    this.height = height;
    this.model.scale.setScalar(height / BUILT_HEIGHT);
    if (this.plan) this.run(this.speed);
  }

  /** Play any clip at its own speed (Idle, Wave, Beckon, JogInPlace, ...). */
  play(name: BuddyClip, timeScale = 1) {
    this.endThen();
    this.plan = null;
    this.mixer.timeScale = timeScale;
    this.fadeTo(name);
  }

  /** Play a clip a few times, then switch to another (e.g. Wave ×2, then back to Idle). */
  playThen(name: BuddyClip, repeats: number, thenName: BuddyClip) {
    const action = this.actions[name];
    if (!action) throw new Error(`No clip called ${name}`);
    this.play(name);
    action.setLoop(THREE.LoopRepeat, repeats);
    this.then = { action, name, thenName };
  }

  /** Follow the runner: picks jog or run, leg speed and stride from speed (m/s). */
  run(speed: number): PacePlan {
    this.endThen();
    this.speed = speed;
    let plan = pacePlan(speed, this.height, this.plan?.clip ?? null, this.options);
    if (this.strideOverride) {
      const boost = plan.legSpeed * plan.stride;
      const legSpeed = boost / this.strideOverride;
      plan = { ...plan, stride: this.strideOverride, legSpeed, stepsPerSecond: GAITS[plan.clip].stepsPerSecond * legSpeed };
    }
    this.plan = plan;
    this.mixer.timeScale = plan.legSpeed;
    this.fadeTo(plan.clip);
    return plan;
  }

  /** Call every frame with the seconds since the last frame. */
  update(dt: number) {
    // Give each limb back the clip's own rotation before the mixer runs. three.js only writes a
    // bone when the clip's value changes, so a stretched rotation left on the bone would be
    // stretched again next frame (flashing limbs).
    for (const limb of this.limbs) {
      if (limb.raw) {
        limb.bone.quaternion.copy(limb.raw);
        limb.raw = null;
      }
    }
    this.mixer.update(dt);

    const stride = this.plan?.stride ?? 1;
    if (stride === 1 || !this.plan) return;
    const centers = this.centers[this.plan.clip];
    for (const limb of this.limbs) {
      const center = centers[limb.bone.name];
      if (!center) continue;
      limb.raw = limb.bone.quaternion.clone();
      limb.bone.quaternion.copy(center).slerp(limb.raw, 1 + (stride - 1) * limb.share);
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }

  /**
   * Forget a pending playThen and put its clip back to looping forever. (The original kept a
   * 'finished' listener per call; a flourish cut short by another clip left it armed, so the
   * next time that clip played it would stop after the old repeat count and jump to Idle.)
   */
  private endThen() {
    if (!this.then) return;
    this.then.action.setLoop(THREE.LoopRepeat, Infinity);
    this.then = null;
  }

  private fadeTo(name: string) {
    const next = this.actions[name];
    if (!next) throw new Error(`No clip called ${name}`);
    if (this.current && next === this.actions[this.current]) return;
    next.reset().play();
    if (this.current) this.actions[this.current].crossFadeTo(next, this.options.crossfade, false);
    this.current = name;
  }
}
