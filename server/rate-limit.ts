import type { MiddlewareHandler } from 'hono';

/** Fixed-window in-memory limiter keyed by client IP (X-Forwarded-For from the trusted proxy). */
export function rateLimit(max: number, windowMs: number): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return async (c, next) => {
    if (max <= 0 || c.req.method === 'OPTIONS') return next();

    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const key = forwarded || c.req.header('x-real-ip') || 'local';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      c.header('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: 'Too many requests' }, 429);
    }
    entry.count += 1;
    return next();
  };
}
