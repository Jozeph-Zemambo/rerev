import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  /** Latest heart rate per device (one row each, overwritten). High churn, so kept on its own. */
  heartRates: defineTable({
    device: v.string(),
    bpm: v.number(),
    at: v.number(),
  }).index('by_device', ['device']),

  runs: defineTable({
    kind: v.union(v.literal('quick'), v.literal('route')),
    startedAt: v.number(),
    goalPaceSecPerKm: v.number(),
    zoneLow: v.number(),
    zoneHigh: v.number(),
    routeDistance: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    summary: v.optional(
      v.object({
        distance: v.number(),
        duration: v.number(),
        avgHr: v.optional(v.number()),
        maxHr: v.optional(v.number()),
        breaks: v.number(),
        stars: v.number(),
        coins: v.number(),
      }),
    ),
  }).index('by_startedAt', ['startedAt']),

  /** Pace and heart-rate samples during a run, a few seconds apart. */
  runSamples: defineTable({
    runId: v.id('runs'),
    t: v.number(),
    distance: v.number(),
    pace: v.number(),
    hr: v.optional(v.number()),
  }).index('by_runId_and_t', ['runId', 't']),
});
