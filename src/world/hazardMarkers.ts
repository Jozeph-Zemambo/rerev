import * as THREE from 'three';
import type { HazardCell, SurfaceMap } from './surfaceMap';

const POOL = 240;
const OBSTACLE_COLOR = new THREE.Color(0xff4b3e);
const DROP_COLOR = new THREE.Color(0xffb020);

/** Small discs on the floor where the depth camera sees something in the way. */
export class HazardMarkers {
  readonly mesh: THREE.InstancedMesh;
  private readonly cells: HazardCell[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor() {
    const geometry = new THREE.CircleGeometry(0.075, 16).rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geometry, material, POOL);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < POOL; i++) {
      this.mesh.setMatrixAt(i, this.hidden);
      this.mesh.setColorAt(i, OBSTACLE_COLOR);
    }
  }

  update(map: SurfaceMap, around: THREE.Vector3, now: number) {
    map.hazardCells(around.x, around.z, 6, now, this.cells);
    for (let i = 0; i < POOL; i++) {
      const cell = this.cells[i];
      if (!cell) {
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      this.mesh.setMatrixAt(i, this.matrix.makeTranslation(cell.x, cell.y + 0.008, cell.z));
      this.mesh.setColorAt(i, cell.kind === 'obstacle' ? OBSTACLE_COLOR : DROP_COLOR);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < POOL; i++) this.mesh.setMatrixAt(i, this.hidden);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
