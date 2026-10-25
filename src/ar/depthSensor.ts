import * as THREE from 'three';
import type { SurfaceMap } from '../world/surfaceMap';

export const COLS = 32;
export const ROWS = 24;
/** Ignore the top quarter of the view (sky, ceilings, far walls) and readings outside this range. */
export const TOP = 0.25;
const MIN_DEPTH = 0.25;
const MAX_DEPTH = 5;

type CpuDepth = { getDepthInMeters(x: number, y: number): number };

function safeDepth(depth: CpuDepth, u: number, v: number) {
  try {
    return depth.getDepthInMeters(u, v);
  } catch {
    return -1;
  }
}
type FrameWithDepth = XRFrame & { getDepthInformation?(view: XRView): CpuDepth | undefined };

/**
 * Turns the phone's depth map into 3D points in the room and feeds them to the SurfaceMap.
 * The depth value is distance along the camera's forward axis, so each sample is unprojected
 * through the view's projection matrix and placed in the world with the view's pose.
 */
export class DepthSensor {
  private readonly inverseProjection = new THREE.Matrix4();
  private readonly viewToWorld = new THREE.Matrix4();
  private readonly point = new THREE.Vector3();
  private readonly samples: { d: number; x: number; y: number; z: number }[] = [];
  private readonly camera = new THREE.Vector3();
  /** Field testing: frames read, and how many came back identical to the one before (stale). */
  frames = 0;
  unchanged = 0;
  /**
   * The last frame's raw readings, for field-test recording: depth per grid cell in millimetres
   * (0 = no reading), and the view's pose and projection matrices.
   */
  readonly grid = new Uint16Array(COLS * ROWS);
  pose: number[] = [];
  projection: number[] = [];
  private lastProbe = '';

  /** Returns how many usable points were read this frame (0 if the phone gave no depth). */
  sample(frame: XRFrame, referenceSpace: XRReferenceSpace, map: SurfaceMap, now: number): number {
    const view = frame.getViewerPose(referenceSpace)?.views[0];
    const depth = view && (frame as FrameWithDepth).getDepthInformation?.(view);
    if (!view || !depth) return 0;

    this.inverseProjection.fromArray(view.projectionMatrix).invert();
    this.viewToWorld.fromArray(view.transform.matrix);
    this.samples.length = 0;
    this.grid.fill(0);
    this.pose = Array.from(view.transform.matrix);
    this.projection = Array.from(view.projectionMatrix);

    for (let row = 0; row < ROWS; row++) {
      const v = TOP + ((1 - TOP) * (row + 0.5)) / ROWS;
      for (let col = 0; col < COLS; col++) {
        const u = (col + 0.5) / COLS;
        let d: number;
        try {
          d = depth.getDepthInMeters(u, v);
        } catch {
          continue;
        }
        if (!(d >= MIN_DEPTH && d <= MAX_DEPTH)) continue;
        this.grid[row * COLS + col] = Math.round(d * 1000);
        // A point on the near plane in view space, scaled so its forward distance equals d.
        this.point.set(u * 2 - 1, 1 - v * 2, -1).applyMatrix4(this.inverseProjection);
        this.point.multiplyScalar(d / -this.point.z).applyMatrix4(this.viewToWorld);
        this.samples.push({ d, x: this.point.x, y: this.point.y, z: this.point.z });
      }
    }

    // A few fixed pixels: if they read exactly the same as last time while the phone moves, the
    // depth image isn't updating.
    const probe = [0.5, 0.65, 0.8].map(v => safeDepth(depth, 0.5, v).toFixed(4)).join(',');
    this.frames++;
    if (probe === this.lastProbe) this.unchanged++;
    this.lastProbe = probe;

    // Nearest first, so ground knowledge spreads outward before far points are judged.
    this.samples.sort((a, b) => a.d - b.d);
    this.camera.setFromMatrixPosition(this.viewToWorld);
    map.addDepthFrame(this.samples, now, this.camera);
    return this.samples.length;
  }
}
