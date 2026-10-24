import { httpRouter } from 'convex/server';
import { internal } from './_generated/api';
import { env, httpAction } from './_generated/server';

const http = httpRouter();

/**
 * The Mac bridge posts each watch reading here:
 *   POST /heart-rate  { "bpm": 128, "device": "watch", "token": "<HR_BRIDGE_TOKEN>" }
 */
http.route({
  path: '/heart-rate',
  method: 'POST',
  handler: httpAction(async (ctx, req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response('Body must be JSON', { status: 400 });
    }
    if (typeof body !== 'object' || body === null) return new Response('Body must be an object', { status: 400 });
    const { bpm, device, token } = body as Record<string, unknown>;
    if (!env.HR_BRIDGE_TOKEN || token !== env.HR_BRIDGE_TOKEN) return new Response('Bad token', { status: 401 });
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 25 || bpm > 240) {
      return new Response('bpm must be a number between 25 and 240', { status: 400 });
    }
    const name = typeof device === 'string' && device.length > 0 && device.length <= 64 ? device : 'watch';
    await ctx.runMutation(internal.heartRate.record, { device: name, bpm, at: Date.now() });
    return new Response(null, { status: 204 });
  }),
});

export default http;
