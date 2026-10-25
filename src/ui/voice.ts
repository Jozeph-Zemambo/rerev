import { clipPath, LINES, lineById, type LineId } from '../voice/lines';
import { SpeechQueue, type QueueOptions } from '../voice/speechQueue';

/** The buddy's speaking voice: says lines from the catalog by id. */
export interface Voice {
  say(id: LineId, options?: QueueOptions): void;
  /** Talking, or has something queued to say. */
  readonly busy: boolean;
  /** Stop talking and forget anything queued. */
  stop(): void;
  muted: boolean;
}

/**
 * The browser's built-in speech, reading a line's text. Used for every line that has no
 * recorded clip yet.
 */
class BrowserSpeech {
  /** Voice pitch (1 = normal). Each buddy gets its own, so Rev and Vita don't sound identical. */
  pitch = 1.2;

  readonly available = 'speechSynthesis' in window;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (!this.available) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
      this.voice =
        voices.find(v => /google.*(us|uk) english/i.test(v.name)) ??
        voices.find(v => /samantha|karen|moira|female/i.test(v.name)) ??
        voices[0] ??
        null;
    };
    pick();
    speechSynthesis.addEventListener('voiceschanged', pick);
  }

  speak(text: string, done: () => void) {
    if (!this.available) return done();
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = 1.05;
    utterance.pitch = this.pitch;
    // Chrome sometimes never fires `end`; don't let one lost event stall the buddy.
    const fallback = setTimeout(done, 2000 + text.split(/\s+/).length * 600);
    utterance.onend = utterance.onerror = () => {
      clearTimeout(fallback);
      done();
    };
    speechSynthesis.speak(utterance);
  }

  cancel() {
    if (this.available) speechSynthesis.cancel();
  }
}

/**
 * Plays the recorded clip for a line (`public/audio/lines/<id>.mp3`) when there is one, and
 * otherwise has the browser read the line's text. Which clips exist comes from
 * `audio/lines/manifest.json` (a JSON array of ids), so missing files are never requested.
 * Clips are fetched up front and decoded once audio is unlocked by a tap.
 */
export class LineVoice implements Voice {
  muted = false;
  private readonly speech = new BrowserSpeech();

  /** Pitch for lines read by the phone's own voice (recorded clips are unaffected). */
  set pitch(pitch: number) {
    this.speech.pitch = pitch;
  }
  private readonly queue: SpeechQueue<LineId>;
  private readonly files = new Map<LineId, Promise<ArrayBuffer | null>>();
  private readonly clips = new Map<LineId, AudioBuffer>();
  private source: AudioBufferSourceNode | null = null;
  private readonly context: () => AudioContext | null;

  /** `context` returns the app's shared AudioContext once a tap has unlocked it. */
  constructor(context: () => AudioContext | null) {
    this.context = context;
    this.queue = new SpeechQueue<LineId>(
      (id, done) => this.play(id, done),
      () => this.cut(),
      () => performance.now() / 1000,
    );
    void this.loadManifest();
  }

  say(id: LineId, options?: QueueOptions) {
    if (this.muted) return;
    this.decodeAll();
    this.queue.add(id, options);
  }

  get busy() {
    return this.queue.busy;
  }

  stop() {
    this.queue.stop();
  }

  /** Call after the tap that unlocks audio, so clips are decoded before they are needed. */
  prepare() {
    this.decodeAll();
  }

  /** Line ids with a recorded clip ready to play. */
  get recorded(): LineId[] {
    return [...this.clips.keys()];
  }

  private async loadManifest() {
    const ids = await fetch(`${import.meta.env.BASE_URL}audio/lines/manifest.json`, { cache: 'no-cache' })
      .then(response => (response.ok ? response.json() : []))
      .catch(() => []);
    if (!Array.isArray(ids)) return;
    const known = new Set<string>(LINES.map(line => line.id));
    for (const id of ids) {
      if (typeof id !== 'string' || !known.has(id)) continue;
      const lineId = id as LineId;
      this.files.set(
        lineId,
        fetch(`${import.meta.env.BASE_URL}${clipPath(lineId)}`)
          .then(response => (response.ok ? response.arrayBuffer() : null))
          .catch(() => null),
      );
    }
    this.decodeAll();
  }

  /** Decode fetched clips as soon as there is a running AudioContext to decode them with. */
  private decodeAll() {
    const ctx = this.context();
    if (!ctx || this.files.size === 0) return;
    for (const [id, file] of this.files) {
      this.files.delete(id);
      void file.then(async data => {
        if (!data) return;
        try {
          this.clips.set(id, await ctx.decodeAudioData(data));
        } catch {
          console.warn(`Voice clip for "${id}" could not be decoded; using the browser voice.`);
        }
      });
    }
  }

  private play(id: LineId, done: () => void) {
    const ctx = this.context();
    const clip = this.clips.get(id);
    if (!ctx || ctx.state !== 'running' || !clip) {
      this.speech.speak(lineById(id).text, done);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = clip;
    source.connect(ctx.destination);
    source.onended = () => {
      if (this.source === source) this.source = null;
      done();
    };
    this.source = source;
    source.start();
  }

  private cut() {
    this.speech.cancel();
    if (this.source) {
      const source = this.source;
      this.source = null;
      source.onended = null;
      source.stop();
    }
  }
}
