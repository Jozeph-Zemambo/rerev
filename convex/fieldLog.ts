import { v } from 'convex/values';
import { internalQuery, mutation } from './_generated/server';

/**
 * Field-test recordings: what the phone's sensors and surface map did on a walk outside
 * (`?field` in the link), for tuning thresholds afterwards. Not used by the app itself.
 */
export const add = mutation({
  args: {
    session: v.string(),
    entries: v.array(v.object({ t: v.number(), kind: v.string(), data: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, { session, entries }) => {
    for (const entry of entries.slice(0, 400)) await ctx.db.insert('fieldLogs', { session, ...entry });
    return null;
  },
});

/** Recent sessions with their entry counts (newest first). For reading results from the CLI. */
export const sessions = internalQuery({
  args: {},
  returns: v.array(v.object({ session: v.string(), entries: v.number() })),
  handler: async ctx => {
    const recent = await ctx.db.query('fieldLogs').order('desc').take(4000);
    const counts = new Map<string, number>();
    for (const row of recent) counts.set(row.session, (counts.get(row.session) ?? 0) + 1);
    return [...counts].map(([session, entries]) => ({ session, entries }));
  },
});

/** One session's entries in time order, a page at a time. */
export const bySession = internalQuery({
  args: { session: v.string(), after: v.optional(v.number()), limit: v.optional(v.number()) },
  returns: v.array(v.object({ t: v.number(), kind: v.string(), data: v.any() })),
  handler: async (ctx, { session, after, limit }) => {
    const rows = await ctx.db
      .query('fieldLogs')
      .withIndex('by_session_and_t', q => q.eq('session', session).gt('t', after ?? -1))
      .take(Math.min(limit ?? 200, 500));
    return rows.map(({ t, kind, data }) => ({ t, kind, data }));
  },
});
