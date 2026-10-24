import * as THREE from 'three';
import type { SurfaceMap } from '../world/surfaceMap';

const COLS = 32;
const ROWS = 24;
/** Ignore the top quarter of the view (sky, ceilings, far walls) and readings outside this range. */
const TOP = 0.25;
const MIN_DEPTH = 0.25;
const MAX_DEPTH = 5;

type CpuDepth = { getDepthInMeters(x: number, y: number): number };
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

  /** Returns how many usable points were read this frame (0 if the phone gave no depth). */
  sample(frame: XRFrame, referenceSpace: XRReferenceSpace, map: SurfaceMap, now: number): number {
    const view = frame.getViewerPose(referenceSpace)?.views[0];
    const depth = view && (frame as FrameWithDepth).getDepthInformation?.(view);
    if (!view || !depth) return 0;

    this.inverseProjection.fromArray(view.projectionMatrix).invert();
    this.viewToWorld.fromArray(view.transform.matrix);
    this.samples.length = 0;

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
        // A point on the near plane in view space, scaled so its forward distance equals d.
        this.point.set(u * 2 - 1, 1 - v * 2, -1).applyMatrix4(this.inverseProjection);
        this.point.multiplyScalar(d / -this.point.z).applyMatrix4(this.viewToWorld);
        this.samples.push({ d, x: this.point.x, y: this.point.y, z: this.point.z });
      }
    }

    // Nearest first, so ground knowledge spreads outward before far points are judged.
    this.samples.sort((a, b) => a.d - b.d);
    for (const s of this.samples) map.addDepthPoint(s.x, s.y, s.z, now, s.d);
    return this.samples.length;
  }
}
