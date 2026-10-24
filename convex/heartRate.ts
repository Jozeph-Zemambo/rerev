import { v } from 'convex/values';
import { internalMutation, query } from './_generated/server';

/** Store a reading as the device's latest heart rate. */
export const record = internalMutation({
  args: { device: v.string(), bpm: v.number(), at: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('heartRates')
      .withIndex('by_device', q => q.eq('device', args.device))
      .unique();
    if (existing) await ctx.db.patch('heartRates', existing._id, { bpm: args.bpm, at: args.at });
    else await ctx.db.insert('heartRates', args);
    return null;
  },
});

/** The device's latest heart rate. The phone subscribes to this and updates live. */
export const latest = query({
  args: { device: v.string() },
  returns: v.union(v.null(), v.object({ bpm: v.number(), at: v.number() })),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query('heartRates')
      .withIndex('by_device', q => q.eq('device', args.device))
      .unique();
    return row ? { bpm: row.bpm, at: row.at } : null;
  },
});
