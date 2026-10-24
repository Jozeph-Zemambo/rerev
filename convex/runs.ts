import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

const summary = v.object({
  distance: v.number(),
  duration: v.number(),
  avgHr: v.optional(v.number()),
  maxHr: v.optional(v.number()),
  breaks: v.number(),
  stars: v.number(),
  coins: v.number(),
});

export const start = mutation({
  args: {
    kind: v.union(v.literal('quick'), v.literal('route')),
    goalPaceSecPerKm: v.number(),
    zoneLow: v.number(),
    zoneHigh: v.number(),
    routeDistance: v.optional(v.number()),
  },
  returns: v.id('runs'),
  handler: async (ctx, args) => ctx.db.insert('runs', { ...args, startedAt: Date.now() }),
});

/** Append a batch of pace / heart-rate samples (the phone sends a few every ~10 s). */
export const addSamples = mutation({
  args: {
    runId: v.id('runs'),
    samples: v.array(v.object({ t: v.number(), distance: v.number(), pace: v.number(), hr: v.optional(v.number()) })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get('runs', args.runId);
    if (!run || run.finishedAt !== undefined) return null;
    for (const sample of args.samples.slice(0, 200)) await ctx.db.insert('runSamples', { runId: args.runId, ...sample });
    return null;
  },
});

export const finish = mutation({
  args: { runId: v.id('runs'), summary },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get('runs', args.runId);
    if (!run || run.finishedAt !== undefined) return null;
    await ctx.db.patch('runs', args.runId, { finishedAt: Date.now(), summary: args.summary });
    return null;
  },
});

/** Most recent finished runs, newest first. */
export const recent = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('runs'),
      kind: v.union(v.literal('quick'), v.literal('route')),
      startedAt: v.number(),
      summary,
    }),
  ),
  handler: async ctx => {
    const runs = await ctx.db.query('runs').withIndex('by_startedAt').order('desc').take(30);
    return runs
      .filter(run => run.summary !== undefined)
      .slice(0, 10)
      .map(run => ({ _id: run._id, kind: run.kind, startedAt: run.startedAt, summary: run.summary! }));
  },
});
