/**
 * The buddy's speaking voice. A stand-in using the browser's built-in speech until a local
 * model (e.g. Kokoro on the Mac) is chosen; anything with a `speak(text)` can replace it.
 */
export interface Voice {
  speak(text: string, interrupt?: boolean): void;
  muted: boolean;
}

export class BrowserVoice implements Voice {
  muted = false;
  private voice: SpeechSynthesisVoice | null = null;

  constructor() {
    if (!('speechSynthesis' in window)) {
      this.muted = true;
      return;
    }
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

  speak(text: string, interrupt = false) {
    if (this.muted) return;
    if (interrupt) speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (this.voice) utterance.voice = this.voice;
    utterance.rate = 1.05;
    utterance.pitch = 1.2;
    speechSynthesis.speak(utterance);
  }
}
