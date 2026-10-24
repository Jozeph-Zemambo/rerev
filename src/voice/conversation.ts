import { parseIntent, type Intent } from '../ui/voiceCommands';
import type { Decision, PendingKind } from './decisions';

/** How long the buddy waits for a yes or no before dropping the question. */
export const QUESTION_TIMEOUT = 10;

/**
 * The one open question the buddy may have asked ("Want to take a break?"). Pure and clocked
 * by the caller, so it can be tested without timers.
 */
export class PendingQuestion {
  private kind: PendingKind | null = null;
  private askedAt = 0;

  ask(kind: PendingKind, now: number) {
    this.kind = kind;
    this.askedAt = now;
  }

  /** The open question, or null if none was asked or it has timed out. */
  current(now: number): PendingKind | null {
    if (this.kind && now - this.askedAt > QUESTION_TIMEOUT) this.kind = null;
    return this.kind;
  }

  clear() {
    this.kind = null;
  }
}

const YES = /\b(yes|yeah|yep|yup|ya|sure|ok|okay|please|alright|all right|definitely|let'?s do it|go on then|why not)\b/;
const NO = /\b(no|nah|nope|not yet|not now|keep going|keep running|i'?m (good|fine|ok|okay)|no thanks|carry on)\b/;

/** A plain yes or no in what was said, or null if it is neither (or both). */
export function answerOf(transcript: string): 'yes' | 'no' | null {
  const text = normalise(transcript);
  const yes = YES.test(text);
  const no = NO.test(text);
  if (yes === no) return null;
  return yes ? 'yes' : 'no';
}

/**
 * Things a runner says that hint at what they want without asking for it. They are worth a
 * question or a kind word rather than an action, and Claude can tell them apart better than
 * keywords; these are the fallbacks if Claude isn't available.
 */
const SOFT: [Decision, RegExp][] = [
  // Feeling unwell is never "tough bit, keep going": stop, even without Claude.
  [{ action: 'break', lineId: 'cmd_break_unwell' }, /\b(chest|dizzy|faint|light ?headed|unwell|sick|nause\w*|heart (hurts|pain)|palpitations?)\b/],
  [{ action: 'ask_break', lineId: 'confirm_ask_break_tired' }, /\b(tired|exhausted|knackered|wiped|dying|dead|my legs|cramp|so hot|out of breath|winded|struggling)\b/],
  [{ action: 'none', lineId: 'chat_tough' }, /\b(steep|hill|hard|tough|brutal|hurts|ouch|ugh|oof)\b/],
  [{ action: 'none', lineId: 'chat_thanks' }, /\b(thanks|thank you|good job|love you|you'?re (great|awesome|cute))\b/],
];

/** The kind word or question a soft phrase deserves when Claude can't be asked, or null. */
export function softDecision(transcript: string): Decision | null {
  const text = normalise(transcript);
  for (const [decision, pattern] of SOFT) if (pattern.test(text)) return decision;
  return null;
}

/**
 * Where what the runner said should go:
 *  - `answer`: a yes/no to the open question, handled on the phone;
 *  - `intent`: a clear command the keyword rules know ("stop", "faster"), handled on the phone;
 *  - `claude`: anything softer or unknown, for Claude to decide (`fallback` if it can't).
 */
export type Route = { kind: 'answer'; answer: 'yes' | 'no' } | { kind: 'intent'; intent: Exclude<Intent, 'unknown'> } | { kind: 'claude'; fallback: Decision | null };

export function routeTranscript(transcript: string, pending: PendingKind | null): Route {
  const intent = parseIntent(transcript);
  // "No, I need to stop" is a stop, whatever the question was.
  const decisive = intent === 'break' || intent === 'finish';
  if (pending && !decisive) {
    const answer = answerOf(transcript);
    if (answer) return { kind: 'answer', answer };
  }
  if (intent !== 'unknown') return { kind: 'intent', intent };
  return { kind: 'claude', fallback: softDecision(transcript) };
}

function normalise(transcript: string) {
  return transcript.toLowerCase().replace(/[^\w' ]+/g, ' ');
}
