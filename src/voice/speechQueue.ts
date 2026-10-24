/** A line waiting to be said, or being said. */
type Item<T> = { value: T; queuedAt: number };

export type QueueOptions = {
  /** Cut off whatever is playing and drop the queue (safety lines, answers to the runner). */
  interrupt?: boolean;
  /** Only say it if nothing else is playing or waiting (coin quips, idle chatter). */
  ifIdle?: boolean;
};

/** Lines that waited this long behind others are stale (a turn already passed): skip them. */
export const MAX_WAIT = 6;

/**
 * One-at-a-time playback order for the buddy's lines, independent of how a line is played
 * (recorded clip or browser speech). `play` starts a line and must call `done` once when it
 * finishes; `cut` stops the one playing. Callbacks from a line that was cut are ignored.
 */
export class SpeechQueue<T> {
  private queue: Item<T>[] = [];
  private playing: Item<T> | null = null;
  private generation = 0;
  private readonly play: (value: T, done: () => void) => void;
  private readonly cut: () => void;
  private readonly clock: () => number;

  constructor(play: (value: T, done: () => void) => void, cut: () => void, clock: () => number) {
    this.play = play;
    this.cut = cut;
    this.clock = clock;
  }

  get busy() {
    return this.playing !== null || this.queue.length > 0;
  }

  add(value: T, options: QueueOptions = {}) {
    if (options.ifIdle && this.busy) return;
    if (options.interrupt) this.stop();
    this.queue.push({ value, queuedAt: this.clock() });
    if (!this.playing) this.next();
  }

  stop() {
    this.queue = [];
    if (this.playing) {
      this.playing = null;
      this.generation++;
      this.cut();
    }
  }

  private next() {
    const now = this.clock();
    while (this.queue.length && now - this.queue[0].queuedAt > MAX_WAIT) this.queue.shift();
    const item = this.queue.shift();
    this.playing = item ?? null;
    if (!item) return;
    const generation = ++this.generation;
    let finished = false;
    this.play(item.value, () => {
      if (finished || generation !== this.generation) return;
      finished = true;
      this.playing = null;
      this.next();
    });
  }
}
