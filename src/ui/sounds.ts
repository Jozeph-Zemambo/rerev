/** Tiny synthesized pickup sounds, so there are no audio files to ship. */
export class Sounds {
  private context: AudioContext | null = null;

  /** Call from a tap so the browser allows audio. */
  unlock() {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  star() {
    this.blip([1046, 1568], 0.07, 0.12);
  }

  coin() {
    this.blip([988, 1319], 0.08, 0.16);
  }

  private blip(frequencies: number[], step: number, volume: number) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    frequencies.forEach((frequency, i) => {
      const start = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(volume, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, start + step * 1.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + step * 2);
    });
  }
}
