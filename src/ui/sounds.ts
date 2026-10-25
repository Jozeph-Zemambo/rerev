/** Tiny synthesized pickup sounds, so there are no audio files to ship. Also owns the app's AudioContext. */
export class Sounds {
  private context: AudioContext | null = null;

  /** Call from a tap so the browser allows audio. */
  unlock() {
    this.context ??= new AudioContext();
    void this.context.resume();
  }

  /** The shared AudioContext once a tap has created it (the buddy's voice clips play on it too). */
  get audio(): AudioContext | null {
    return this.context;
  }

  star() {
    this.blip([1046, 1568], 0.07, 0.12);
  }

  coin() {
    this.blip([988, 1319], 0.08, 0.16);
  }

  /** Race countdown: a short beep on 3, 2, 1, and a higher, longer one on go. */
  countdown(go: boolean) {
    if (go) this.blip([1175], 0.32, 0.22);
    else this.blip([659], 0.12, 0.18);
  }

  /** Crossing the finish line: a little rising fanfare. */
  fanfare() {
    this.blip([784, 988, 1175, 1568], 0.09, 0.16);
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
