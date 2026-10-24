import { ConvexClient } from 'convex/browser';

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;

/** One shared connection to the Convex backend, or null if the app was built without one. */
export const convex: ConvexClient | null = url ? new ConvexClient(url) : null;
