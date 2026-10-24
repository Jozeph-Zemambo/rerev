import * as THREE from 'three';
import type { Path } from './path';

export type CollectibleKind = 'star' | 'coin';

const SPACING = 5;
const FIRST_AT = 6;
/** Every fifth spot is a coin, the rest are stars. */
const COIN_EVERY = 5;
const HOVER = 0.55;
/** Only items in this window around the runner are drawn. */
const SHOW_BEHIND = 2;
const SHOW_AHEAD = 30;
/** Collected when the runner passes within this distance (sideways slack for walking off-line). */
const REACH = 1.1;
const POP_TIME = 0.35;

type Item = { s: number; side: number; kind: CollectibleKind; collected: boolean; popAge: number; mesh: THREE.Mesh };

const starGeometry = (() => {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.12 : 0.055;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: 0.035, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2 }).center();
})();
const coinGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.025, 28).rotateX(Math.PI / 2);
const starMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc33, emissive: 0x8a5200, emissiveIntensity: 0.45, metalness: 0.25, roughness: 0.35 });
const coinMaterial = new THREE.MeshStandardMaterial({ color: 0xf5b400, emissive: 0x6b4000, emissiveIntensity: 0.35, metalness: 0.6, roughness: 0.3 });

/** Stars and coins floating over the path, collected by running through them. */
export class Collectibles {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private showAhead = SHOW_AHEAD;
  private readonly at = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();

  /** `showAhead` caps how far ahead items appear (under one lap on a lap course). */
  layout(pathLength: number, showAhead = SHOW_AHEAD) {
    this.clear();
    this.showAhead = showAhead;
    let index = 0;
    for (let s = FIRST_AT; s < pathLength - 2; s += SPACING, index++) {
      const kind: CollectibleKind = index % COIN_EVERY === COIN_EVERY - 1 ? 'coin' : 'star';
      const mesh = new THREE.Mesh(kind === 'star' ? starGeometry : coinGeometry, kind === 'star' ? starMaterial : coinMaterial);
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ s, side: Math.sin(s * 0.7) * 0.25, kind, collected: false, popAge: 0, mesh });
    }
  }

  clear() {
    this.group.clear();
    this.items = [];
  }

  /** Returns what the runner picked up this frame. */
  update(dt: number, time: number, path: Path, runnerS: number, runner: THREE.Vector3): CollectibleKind[] {
    const picked: CollectibleKind[] = [];
    for (const item of this.items) {
      const inWindow = item.s > runnerS - SHOW_BEHIND && item.s < runnerS + this.showAhead;
      if (item.collected) {
        if (item.popAge < POP_TIME) {
          item.popAge += dt;
          const t = item.popAge / POP_TIME;
          item.mesh.scale.setScalar(t < 1 ? 1 + t * 1.2 : 0);
          item.mesh.position.y += dt * 1.2;
          item.mesh.rotation.y += dt * 18;
          item.mesh.visible = t < 1;
        }
        continue;
      }
      item.mesh.visible = inWindow;
      if (!inWindow) continue;

      path.pointAt(item.s, this.at);
      path.tangentAt(item.s, this.tangent);
      // Sideways offset across the direction of travel.
      this.at.x += this.tangent.z * item.side;
      this.at.z -= this.tangent.x * item.side;
      this.at.y += HOVER + Math.sin(time * 2.4 + item.s) * 0.04;
      item.mesh.position.copy(this.at);
      item.mesh.rotation.y = time * (item.kind === 'coin' ? 3 : 1.6) + item.s;

      const sideways = Math.hypot(runner.x - this.at.x, runner.z - this.at.z);
      const reached = Math.abs(item.s - runnerS) < 0.6 && sideways < REACH;
      // A fast runner can skip past the reach window between frames; still count it if close.
      const passedClose = runnerS > item.s + 0.6 && runnerS < item.s + 2 && sideways < 2.4;
      if (reached || passedClose) {
        item.collected = true;
        item.popAge = 0;
        picked.push(item.kind);
      }
    }
    return picked;
  }
}
