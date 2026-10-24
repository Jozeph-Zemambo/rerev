'use node';

import Anthropic from '@anthropic-ai/sdk';
import { v } from 'convex/values';
import { ACTIONS, DECISION_LINE_IDS, decisionMenu, decisionSchema, parseDecision } from '../src/voice/decisions';
import { lineById } from '../src/voice/lines';
import { action, env } from './_generated/server';

const FORMAT = { type: 'json_schema', schema: decisionSchema() } as const;

const SYSTEM = `You decide what Buddy does. Buddy is a cheerful cartoon running partner in an AR running app. The runner said something mid-run that keyword matching didn't understand. Pick one action and one line id from that action's list. You never write words: each line is pre-recorded.

- Soft statements ("I'm tired", "my legs are dying") mean ask_break, not break. Use break only for a clear request to stop or rest.
- Grumbles about effort or the route ("man, this is steep") are none with an encouraging line.
- confirm_yes or confirm_no only when a question is pending and they answered it.
- Chest pain, dizziness, feeling faint or unwell: break with cmd_break_unwell.
- Questions about distance, pace, time or heart rate: status.
- Small talk, jokes, anything unclear: none.

Actions and their lines:
${decisionMenu()}`;

const QUESTIONS = { break: lineById('confirm_ask_break').text } as const;

/**
 * Free-form voice commands, decided by Claude Haiku: an action plus one of the pre-recorded
 * lines allowed for it. Only used for what the on-phone keyword rules don't settle, and only
 * if ANTHROPIC_API_KEY is set on the deployment (`npx convex env set ANTHROPIC_API_KEY ...`).
 * Returns null when unavailable, and the phone falls back to its own guess or "didn't catch that".
 */
export const interpret = action({
  args: {
    said: v.string(),
    /** The question the buddy is waiting on an answer to, if any. */
    pending: v.optional(v.literal('break')),
    run: v.object({
      state: v.string(),
      bpm: v.optional(v.number()),
      zoneLow: v.number(),
      zoneHigh: v.number(),
      metres: v.number(),
      paceSecondsPerKm: v.optional(v.number()),
      onBreak: v.boolean(),
    }),
  },
  returns: v.union(
    v.null(),
    v.object({
      action: v.union(...ACTIONS.map(name => v.literal(name))),
      lineId: v.union(...DECISION_LINE_IDS.map(id => v.literal(id))),
    }),
  ),
  handler: async (_ctx, args) => {
    if (!env.ANTHROPIC_API_KEY) return null;
    const said = args.said.slice(0, 300).replace(/"/g, "'");
    const { run } = args;
    const zone = run.bpm === undefined ? 'unknown' : run.bpm > run.zoneHigh ? 'above' : run.bpm < run.zoneLow ? 'below' : 'in';
    const pace = run.paceSecondsPerKm
      ? `${Math.floor(run.paceSecondsPerKm / 60)}:${String(Math.round(run.paceSecondsPerKm % 60)).padStart(2, '0')}/km`
      : 'unknown';
    const context = [
      `Buddy: ${run.state}${run.onBreak ? ' (on a break)' : ''}`,
      `Heart rate: ${run.bpm === undefined ? 'unknown' : Math.round(run.bpm)}, zone ${run.zoneLow}-${run.zoneHigh} (${zone})`,
      `Pace: ${pace}, ${Math.round(run.metres)} m so far`,
      `Pending question: ${args.pending ? `"${QUESTIONS[args.pending]}"` : 'none'}`,
      `Runner said: "${said}"`,
    ].join('\n');

    // A runner won't wait long for an answer: fail fast and let the phone fall back.
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 8000, maxRetries: 1 });
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-5-5',
        max_tokens: 128,
        system: SYSTEM,
        // A small pick from a menu: no thinking keeps it fast and the output to ~25 tokens.
        thinking: { type: 'disabled' },
        output_config: { effort: 'low', format: FORMAT },
        messages: [{ role: 'user', content: context }],
      });
      if (response.stop_reason !== 'end_turn') return null;
      const text = response.content.find(block => block.type === 'text');
      return text ? parseDecision(text.text, args.pending ?? null) : null;
    } catch (error) {
      if (error instanceof Anthropic.APIError) console.error(`Buddy could not reach Claude (${error.status})`, error.message);
      else console.error('Buddy could not reach Claude', error);
      return null;
    }
  },
});
