import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

/** A watch reading older than this means the watch has gone quiet. */
const STALE_MS = 8000;

export type HeartSource = 'watch' | 'manual' | 'simulated' | 'none';

/**
 * Where the buddy gets your heart rate: the watch (straight over Bluetooth, or relayed through
 * Convex by the laptop bridge), a manual value for demos, or a simple simulation when previewing
 * on a laptop. Manual beats watch beats simulation; between the two watch routes, the latest
 * reading wins.
 */
export class HeartRateFeed {
  manual: number | null = null;
  private watch: { bpm: number; at: number } | null = null;
  private simulated: number | null = null;
  private connected = false;
  private spikeUntil = 0;

  connect(client: ConvexClient | null) {
    if (this.connected || !client) return;
    this.connected = true;
    client.onUpdate(api.heartRate.latest, { device: 'watch' }, reading => {
      if (reading && (!this.watch || reading.at > this.watch.at)) this.watch = reading;
    });
  }

  /** A reading that came straight from the watch (Bluetooth). */
  reportWatch(bpm: number) {
    this.watch = { bpm, at: Date.now() };
  }

  get source(): HeartSource {
    if (this.manual !== null) return 'manual';
    if (this.watchFresh()) return 'watch';
    if (this.simulated !== null) return 'simulated';
    return 'none';
  }

  get bpm(): number | null {
    if (this.manual !== null) return this.manual;
    if (this.watchFresh()) return this.watch!.bpm;
    return this.simulated;
  }

  /**
   * Laptop preview only: heart rate drifts toward a level set by running speed, recovers when
   * resting, and spikes once early on so the coaching can be seen working.
   */
  simulate(dt: number, speedMetresPerSecond: number, resting: boolean, elapsed: number) {
    if (this.simulated === null) {
      this.simulated = 92;
      this.spikeUntil = 0;
    }
    // One hard stretch (a hill, a sprint) from 15 s to 45 s into the run.
    if (elapsed > 15 && this.spikeUntil === 0) this.spikeUntil = elapsed + 30;
    const spike = elapsed < this.spikeUntil ? 40 : 0;
    const target = resting ? 98 : 70 + 30 * speedMetresPerSecond + spike;
    this.simulated += (target - this.simulated) * Math.min(1, dt / 6);
  }

  resetSimulation() {
    this.simulated = null;
  }

  private watchFresh() {
    return this.watch !== null && Date.now() - this.watch.at < STALE_MS;
  }
}
