'use node';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { v } from 'convex/values';
import { z } from 'zod';
import { action, env } from './_generated/server';

const INTENTS = ['break', 'go', 'faster', 'slower', 'status', 'finish', 'chat'] as const;

const Reply = z.object({
  intent: z.enum(INTENTS),
  reply: z.string(),
});

const SYSTEM = `You are Buddy, a cheerful cartoon running partner inside an AR running app. The runner just said something out loud mid-run that simple keyword matching didn't understand.

Decide what they want and answer in character:
- intent "break": they want to stop or rest.
- intent "go": they want to start moving again.
- intent "faster" / "slower": change the pace.
- intent "status": they're asking how they're doing.
- intent "finish": they want to end the run.
- intent "chat": anything else (small talk, a question, encouragement).

"reply" is what Buddy says back: one or two short, warm sentences (under 25 words) that suit being heard while running. Use the run details given. Never give medical advice beyond suggesting they slow down or rest; if they mention chest pain, dizziness or feeling faint, use intent "break" and tell them to stop and get help.`;

/**
 * Free-form voice commands, interpreted by Claude Haiku. Only used when the on-phone keyword
 * matcher doesn't recognise a phrase, and only if ANTHROPIC_API_KEY is set on the deployment
 * (`npx convex env set ANTHROPIC_API_KEY ...`). Returns null when unavailable.
 */
export const interpret = action({
  args: {
    said: v.string(),
    run: v.object({
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
      intent: v.union(...INTENTS.map(intent => v.literal(intent))),
      reply: v.string(),
    }),
  ),
  handler: async (_ctx, args) => {
    if (!env.ANTHROPIC_API_KEY) return null;
    const said = args.said.slice(0, 300);
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    try {
      const response = await client.messages.parse({
        model: 'claude-haiku-5-5',
        max_tokens: 400,
        system: SYSTEM,
        output_config: { effort: 'low', format: zodOutputFormat(Reply) },
        messages: [{ role: 'user', content: `Run details: ${JSON.stringify(args.run)}\nThe runner said: "${said}"` }],
      });
      if (response.stop_reason === 'refusal' || !response.parsed_output) return null;
      return response.parsed_output;
    } catch (error) {
      console.error('Buddy could not reach Claude', error);
      return null;
    }
  },
});
