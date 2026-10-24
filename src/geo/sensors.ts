import type { LatLon } from './geo';

export type Fix = LatLon & { accuracy: number; time: number };

/** Live GPS position (high accuracy). */
export class Gps {
  latest: Fix | null = null;
  error: string | null = null;
  private watchId: number | null = null;
  private listeners = new Set<(fix: Fix) => void>();

  start() {
    if (this.watchId !== null || !('geolocation' in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      position => {
        this.error = null;
        this.latest = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          time: position.timestamp / 1000,
        };
        this.listeners.forEach(listener => listener(this.latest!));
      },
      error => {
        this.error = error.message;
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  onFix(listener: (fix: Fix) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }
}

type OrientationWithCompass = DeviceOrientationEvent & { webkitCompassHeading?: number };

/**
 * Phone compasses point to magnetic north; maps use true north. In Calgary magnetic north is
 * about 13° east of true north (2026, approximate). The GPS refit corrects whatever is left.
 */
const MAGNETIC_DECLINATION = (13.2 * Math.PI) / 180;
/** Readings older than this are stale (e.g. events paused during an AR session). */
const STALE_AFTER = 2;

/**
 * Compass heading of the direction the back camera faces, radians clockwise from north.
 * Android Chrome reports absolute orientation via `deviceorientationabsolute`; iOS Safari via
 * `webkitCompassHeading`. Smoothed, because raw magnetometer readings jitter.
 */
export class Compass {
  private smoothed: number | null = null;
  private updatedAt = -Infinity;
  private sinAvg = 0;
  private cosAvg = 0;
  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;
    const request = (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission;
    if (request) await request().catch(() => 'denied');
    const absoluteEvent = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    addEventListener(absoluteEvent, event => this.onOrientation(event as OrientationWithCompass));
  }

  private onOrientation(event: OrientationWithCompass) {
    let heading: number | null = null;
    if (typeof event.webkitCompassHeading === 'number') {
      heading = (event.webkitCompassHeading * Math.PI) / 180;
    } else if (event.absolute && event.alpha !== null && event.beta !== null && event.gamma !== null) {
      heading = cameraHeading(event.alpha, event.beta, event.gamma);
    }
    if (heading === null || Number.isNaN(heading)) return;
    // Circular moving average.
    this.sinAvg += (Math.sin(heading) - this.sinAvg) * 0.15;
    this.cosAvg += (Math.cos(heading) - this.cosAvg) * 0.15;
    this.smoothed = Math.atan2(this.sinAvg, this.cosAvg);
    this.updatedAt = performance.now() / 1000;
  }

  /** True-north heading of the back camera, radians clockwise from north, or null if stale/unknown. */
  get heading(): number | null {
    if (this.smoothed === null || performance.now() / 1000 - this.updatedAt > STALE_AFTER) return null;
    return (this.smoothed + MAGNETIC_DECLINATION + 4 * Math.PI) % (2 * Math.PI);
  }
}

/**
 * Heading of the device's back camera (its -z axis) from W3C device orientation angles.
 * The orientation is Rz(alpha)·Rx(beta)·Ry(gamma) taking device axes to Earth axes
 * (x east, y north, z up); the camera looks along device -z.
 */
export function cameraHeading(alphaDeg: number, betaDeg: number, gammaDeg: number): number {
  const a = (alphaDeg * Math.PI) / 180;
  const b = (betaDeg * Math.PI) / 180;
  const g = (gammaDeg * Math.PI) / 180;
  const [ca, sa, sb, cg, sg] = [Math.cos(a), Math.sin(a), Math.sin(b), Math.cos(g), Math.sin(g)];
  // Third column of R (where device +z points), negated for the camera direction.
  const east = -(ca * sg + sa * sb * cg);
  const north = -(sa * sg - ca * sb * cg);
  return (Math.atan2(east, north) + 2 * Math.PI) % (2 * Math.PI);
}
