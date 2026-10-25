import * as THREE from 'three';
import type { RoutePoint } from '../world/path';
import type { SurfaceMap } from '../world/surfaceMap';

const DEPTH_COLS = 32;
const DEPTH_ROWS = 20;

/**
 * A stand-in for the real world when there is no AR (a laptop): a floor, a ramp, a crate on
 * the route and a wide barrier, plus fake depth and ground sensors that raycast against them.
 * The same SurfaceMap / Path pipeline runs on these readings as on a phone.
 */
export class PreviewWorld {
  readonly group = new THREE.Group();
  readonly route: RoutePoint[] = [
    { x: 0, z: 0 },
    { x: 0, z: -9 },
    { x: -2, z: -12 },
    { x: -6, z: -13 },
    { x: -6, z: -26 },
    { x: -2, z: -30 },
    { x: 6, z: -30 },
    { x: 6, z: -44 },
  ];
  private readonly solids: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly down = new THREE.Vector3();
  private readonly hits: THREE.Intersection[] = [];

  /** `withObstacles` adds the ramp, crate and barrier; map-route previews use a bare floor. */
  constructor(withObstacles = true, size = 80) {
    const ground = new THREE.MeshStandardMaterial({ color: 0x3c5a48, roughness: 0.95 });
    const wood = new THREE.MeshStandardMaterial({ color: 0xb5793d, roughness: 0.8 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x8c8a84, roughness: 0.9 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), ground);
    this.add(floor);
    this.group.add(new THREE.GridHelper(size, size / 2, 0x557a63, 0x4a6a56));
    if (!withObstacles) return;

    // Ramp up 0.45 m over 4 m, a 3 m plateau, then down over 4 m, on the long straight.
    const rampShape = new THREE.Shape();
    // Drawn along +x then rotated a quarter turn, so x = 15..26 lands on z = -15..-26.
    rampShape.moveTo(15, 0);
    rampShape.lineTo(19, 0.45);
    rampShape.lineTo(22, 0.45);
    rampShape.lineTo(26, 0);
    rampShape.lineTo(15, 0);
    const ramp = new THREE.Mesh(new THREE.ExtrudeGeometry(rampShape, { depth: 3, bevelEnabled: false }), concrete);
    ramp.rotation.y = Math.PI / 2;
    ramp.position.set(-7.5, 0, 0);
    this.add(ramp);

    // A crate sitting on the first straight, slightly right of the line.
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.5), wood);
    crate.position.set(0.15, 0.225, -5.5);
    this.add(crate);

    // Four steps up (17 cm risers, 30 cm treads) onto a landing, on the last straight.
    const RISE = 0.17;
    const TREAD = 0.3;
    for (let k = 1; k <= 4; k++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2, RISE * k, TREAD), concrete);
      step.position.set(6, (RISE * k) / 2, -33 - TREAD * (k - 0.5));
      this.add(step);
    }
    const landing = new THREE.Mesh(new THREE.BoxGeometry(2, RISE * 4, 5.8), concrete);
    landing.position.set(6, RISE * 2, -34.2 - 2.9);
    this.add(landing);

    // A barrier too wide to step around, up on the landing.
    const barrier = new THREE.Mesh(new THREE.BoxGeometry(5, 0.9, 0.3), wood);
    barrier.position.set(6, RISE * 4 + 0.45, -39);
    this.add(barrier);
  }

  /** Simulated depth camera: a grid of rays from the camera through the lower 3/4 of the view. */
  sampleDepth(camera: THREE.PerspectiveCamera, map: SurfaceMap, now: number) {
    const points: { d: number; p: THREE.Vector3 }[] = [];
    for (let row = 0; row < DEPTH_ROWS; row++) {
      const v = 0.25 + (0.75 * (row + 0.5)) / DEPTH_ROWS;
      for (let col = 0; col < DEPTH_COLS; col++) {
        const u = (col + 0.5) / DEPTH_COLS;
        this.ndc.set(u * 2 - 1, 1 - v * 2);
        this.raycaster.setFromCamera(this.ndc, camera);
        this.raycaster.far = 5;
        this.hits.length = 0;
        this.raycaster.intersectObjects(this.solids, false, this.hits);
        const hit = this.hits[0];
        if (hit) points.push({ d: hit.distance, p: hit.point.clone() });
      }
    }
    points.sort((a, b) => a.d - b.d);
    map.addDepthFrame(points.map(({ d, p }) => ({ x: p.x, y: p.y, z: p.z, d })), now, camera.position);
  }

  /** Simulated AR hit-tests: a few rays angled down at the ground ahead. */
  sampleGround(camera: THREE.PerspectiveCamera, map: SurfaceMap) {
    const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    for (const pitch of [20, 30, 45]) {
      const p = (pitch * Math.PI) / 180;
      this.down.copy(forward).multiplyScalar(Math.cos(p)).setY(-Math.sin(p)).normalize();
      this.raycaster.set(camera.position, this.down);
      this.raycaster.far = 8;
      this.hits.length = 0;
      this.raycaster.intersectObjects(this.solids, false, this.hits);
      const hit = this.hits[0];
      if (hit) map.addGroundSample(hit.point.x, hit.point.y, hit.point.z, 2, map.groundTolerance(0.1));
    }
  }

  /** True ground height under a point (for placing the simulated runner's eyes). */
  groundHeight(x: number, z: number): number {
    this.raycaster.set(new THREE.Vector3(x, 5, z), new THREE.Vector3(0, -1, 0));
    this.raycaster.far = 10;
    this.hits.length = 0;
    this.raycaster.intersectObjects(this.solids, false, this.hits);
    return this.hits[0]?.point.y ?? 0;
  }

  /** A box sitting on the floor, e.g. a bag dropped on the lap course. */
  addBox(x: number, z: number, width: number, height: number, depth: number) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshStandardMaterial({ color: 0x5b6fb5, roughness: 0.7 }));
    box.position.set(x, height / 2, z);
    this.add(box);
  }

  private add(mesh: THREE.Mesh) {
    this.solids.push(mesh);
    this.group.add(mesh);
  }
}
