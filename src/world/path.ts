import * as THREE from 'three';

const SAMPLE_STEP = 0.1;
const DASH_SPACING = 0.25;
const UP = new THREE.Vector3(0, 1, 0);

const DASH_BASE = new THREE.Color(0x45c08f);
const DASH_HOT = new THREE.Color(0xd8fff0);
const DASH_DIM = new THREE.Color(0x1d4d3c);

/** A route laid on the floor, sampled densely so positions can be looked up by distance travelled. */
export class Path {
  readonly group = new THREE.Group();
  length = 0;

  private samples: THREE.Vector3[] = [];
  private cumulative: number[] = [];
  private dashes?: THREE.InstancedMesh;
  private dashDistances: number[] = [];
  private readonly scratch = new THREE.Color();

  build(start: THREE.Vector3, direction: THREE.Vector3, length: number) {
    const side = new THREE.Vector3().crossVectors(UP, direction).normalize();
    this.samples = [];
    this.cumulative = [];
    let travelled = 0;
    for (let u = 0; u <= length + 1e-6; u += SAMPLE_STEP) {
      // A gentle S-curve reads as a route rather than a laser line.
      const point = start.clone().addScaledVector(direction, u).addScaledVector(side, Math.sin((u / 8) * Math.PI * 2) * 0.6);
      const previous = this.samples.at(-1);
      if (previous) travelled += point.distanceTo(previous);
      this.samples.push(point);
      this.cumulative.push(travelled);
    }
    this.length = travelled;
    this.buildDashes();
  }

  pointAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const clamped = THREE.MathUtils.clamp(s, 0, this.length);
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= clamped) lo = mid;
      else hi = mid;
    }
    const span = this.cumulative[hi] - this.cumulative[lo] || 1;
    return out.lerpVectors(this.samples[lo], this.samples[hi], (clamped - this.cumulative[lo]) / span);
  }

  tangentAt(s: number, out: THREE.Vector3): THREE.Vector3 {
    const ahead = this.pointAt(s + 0.05, new THREE.Vector3());
    return this.pointAt(s - 0.05, out).negate().add(ahead).setY(0).normalize();
  }

  /** Distance along the path of the point nearest to `position` (ignoring height). */
  project(position: THREE.Vector3): number {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i];
      const d = (sample.x - position.x) ** 2 + (sample.z - position.z) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return this.cumulative[best] ?? 0;
  }

  /** Dashes behind the runner dim; a bright pulse travels ahead to show direction. */
  update(timeSeconds: number, runnerS: number) {
    if (!this.dashes) return;
    const pulse = runnerS + ((timeSeconds * 3) % 6);
    this.dashDistances.forEach((s, i) => {
      if (s < runnerS - 0.3) {
        this.scratch.copy(DASH_DIM);
      } else {
        const heat = Math.max(0, 1 - Math.abs(s - pulse) / 0.8);
        this.scratch.copy(DASH_BASE).lerp(DASH_HOT, heat);
      }
      this.dashes!.setColorAt(i, this.scratch);
    });
    if (this.dashes.instanceColor) this.dashes.instanceColor.needsUpdate = true;
  }

  private buildDashes() {
    if (this.dashes) {
      this.group.remove(this.dashes);
      this.dashes.geometry.dispose();
      (this.dashes.material as THREE.Material).dispose();
    }
    const count = Math.max(1, Math.floor(this.length / DASH_SPACING));
    const geometry = new THREE.PlaneGeometry(0.08, 0.14).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const unit = new THREE.Vector3(1, 1, 1);
    this.dashDistances = [];
    for (let i = 0; i < count; i++) {
      const s = (i + 0.5) * DASH_SPACING;
      this.pointAt(s, position).y += 0.004;
      this.tangentAt(s, tangent);
      rotation.setFromAxisAngle(UP, Math.atan2(tangent.x, tangent.z));
      mesh.setMatrixAt(i, matrix.compose(position, rotation, unit));
      mesh.setColorAt(i, DASH_BASE);
      this.dashDistances.push(s);
    }
    this.dashes = mesh;
    this.group.add(mesh);
  }
}
