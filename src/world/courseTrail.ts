import * as THREE from 'three';

/** Enough dashes for a 500 m walk at one per 25 cm. */
const POOL = 2000;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The course being recorded, drawn as it is walked: one small dash on the floor per recorded
 * sample, pointing the way you were going.
 */
export class CourseTrail {
  readonly mesh: THREE.InstancedMesh;
  private count = 0;
  private readonly last = new THREE.Vector3(NaN, 0, NaN);
  private readonly matrix = new THREE.Matrix4();
  private readonly rotation = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1, 1, 1);

  constructor() {
    const geometry = new THREE.PlaneGeometry(0.07, 0.14).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0x9fe1cb, transparent: true, opacity: 0.9, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, POOL);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  add(x: number, y: number, z: number) {
    if (this.count >= POOL) return;
    const heading = Number.isNaN(this.last.x) ? 0 : Math.atan2(x - this.last.x, z - this.last.z);
    this.rotation.setFromAxisAngle(UP, heading);
    this.position.set(x, y + 0.012, z);
    this.mesh.setMatrixAt(this.count++, this.matrix.compose(this.position, this.rotation, this.scale));
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.last.set(x, y, z);
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
    this.last.set(NaN, 0, NaN);
  }
}
