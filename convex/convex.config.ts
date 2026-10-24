import { defineApp } from 'convex/server';
import { v } from 'convex/values';

const app = defineApp({
  env: {
    /** Shared secret the Mac heart-rate bridge sends with each reading. */
    HR_BRIDGE_TOKEN: v.optional(v.string()),
    /** Claude API key for the buddy's lines and voice commands (optional). */
    ANTHROPIC_API_KEY: v.optional(v.string()),
  },
});

export default app;
