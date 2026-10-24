export type Intent = 'break' | 'go' | 'faster' | 'slower' | 'status' | 'finish' | 'unknown';

/**
 * Checked in order: "go faster" is about speed, not starting; "don't stop" must not read as
 * "stop"; "stop the run" means finish rather than take a break. Only clear commands live
 * here; softer things like "I'm tired" deserve a question first (see `voice/conversation.ts`).
 */
const RULES: [Intent, RegExp][] = [
  ['faster', /\b(faster|speed (it )?up|pick (it|the pace)? ?up|quicker|push)\b/],
  ['slower', /\b(slower|slow (it )?down|easy|ease (it )?(off|up)|too fast|chill)\b/],
  ['go', /\b(don'?t stop|keep (going|running)|let'?s go|go( again)?|continue|resume|ready|start again|carry on|i'?m good|back on)\b/],
  ['finish', /\b(finish|end (the )?run|i'?m done|we'?re done|stop the run)\b/],
  ['break', /\b(break|breather|rest|stop|wait|pause|hold on|need a (sec|second|minute)|can'?t breathe)\b/],
  ['status', /\b(how (am i|are we) doing|how far|how long|status|my heart|heart rate|pace)\b/],
];

/** Map what the runner said to an action. Plain keyword rules: instant, offline, predictable. */
export function parseIntent(transcript: string): Intent {
  const text = transcript.toLowerCase().replace(/[^\w' ]+/g, ' ');
  for (const [intent, pattern] of RULES) if (pattern.test(text)) return intent;
  return 'unknown';
}

type RecognitionResult = { 0: { transcript: string } };
type RecognitionEvent = { results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};

/** Push-to-talk speech recognition (Chrome's built-in recognizer). */
export class VoiceCommands {
  onHeard: (transcript: string, intent: Intent) => void = () => {};
  onState: (listening: boolean, error?: string) => void = () => {};
  private recognition: Recognition | null = null;
  private listening = false;

  get supported() {
    return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  }

  toggle() {
    if (this.listening) this.recognition?.stop();
    else this.listen();
  }

  private listen() {
    const Ctor = (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
      .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition;
    if (!Ctor) {
      this.onState(false, 'Voice commands need Chrome.');
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = event => {
      const transcript = event.results[0]?.[0]?.transcript ?? '';
      if (transcript) this.onHeard(transcript, parseIntent(transcript));
    };
    recognition.onerror = event => {
      if (event.error !== 'aborted' && event.error !== 'no-speech') this.onState(false, `Didn't catch that (${event.error}).`);
    };
    recognition.onend = () => {
      this.listening = false;
      this.onState(false);
    };
    this.recognition = recognition;
    this.listening = true;
    this.onState(true);
    recognition.start();
  }
}
