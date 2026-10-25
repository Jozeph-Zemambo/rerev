import type { SurfaceMap } from '../world/surfaceMap';

/** Downward angles (degrees below the camera's forward axis) and sideways tilts for the rays. */
const RAYS: [pitch: number, yaw: number][] = [
  [20, 0],
  [30, 0],
  [45, 0],
  [30, -20],
  [30, 20],
];

/**
 * Extra AR hit-test rays aimed at the ground ahead. ARCore answers them against the surfaces
 * it tracks (camera features plus motion sensors), which gives solid ground samples for the
 * SurfaceMap even where the depth map is noisy.
 */
export class GroundRays {
  private sources: XRHitTestSource[] = [];
  private readonly hits: { x: number; y: number; z: number }[] = [];
  /** Floor hits since the field log last took them (field-test recording only). */
  readonly recent: number[][] = [];

  async start(session: XRSession) {
    this.stop();
    const viewer = await session.requestReferenceSpace('viewer');
    for (const [pitch, yaw] of RAYS) {
      const p = (pitch * Math.PI) / 180;
      const y = (yaw * Math.PI) / 180;
      const direction = { x: Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: -Math.cos(y) * Math.cos(p), w: 0 };
      try {
        const source = await session.requestHitTestSource?.({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0, w: 1 }, direction) });
        if (source) this.sources.push(source);
      } catch {
        // Some browsers reject offset rays; the depth map still works without them.
      }
    }
  }

  /** Returns how many rays hit the ground this frame. */
  sample(frame: XRFrame, referenceSpace: XRReferenceSpace, map: SurfaceMap, now: number): number {
    const hits = this.hits;
    hits.length = 0;
    for (const source of this.sources) {
      const pose = frame.getHitTestResults(source)[0]?.getPose(referenceSpace);
      if (!pose) continue;
      const { x, y, z } = pose.transform.position;
      hits.push({ x, y, z });
      if (this.recent.length < 200) this.recent.push([x, y, z]);
    }
    // All together, so the map can tell the phone's world drifting from the floor changing.
    map.addFloorHits(hits, now);
    return hits.length;
  }

  get rays() {
    return this.sources.length;
  }

  stop() {
    this.sources.forEach(s => s.cancel());
    this.sources = [];
  }
}
