import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window counter kept in memory. Enough for one instance; no extra dependency. */
export class Counter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private windowMs: number,
    private max: number,
  ) {}

  private bucket(key: string): Bucket {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Count one event. Returns seconds to wait when the limit is exceeded, otherwise 0. */
  hit(key: string): number {
    const b = this.bucket(key);
    b.count++;
    return b.count > this.max ? Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000)) : 0;
  }

  /** Seconds to wait if the key is already at the limit, without counting a new event. */
  blockedFor(key: string): number {
    const b = this.bucket(key);
    return b.count >= this.max ? Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000)) : 0;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

export function tooMany(res: Response, retryAfter: number): void {
  res
    .status(429)
    .set('Retry-After', String(retryAfter))
    .json({ error: 'rate_limited', reasons: [`Too many requests. Try again in ${retryAfter} seconds.`] });
}

export function rateLimit(windowMs: number, max: number, key: (req: Request) => string = (req) => req.ip ?? 'unknown') {
  const counter = new Counter(windowMs, max);
  return (req: Request, res: Response, next: NextFunction) => {
    const wait = counter.hit(key(req));
    if (wait) return tooMany(res, wait);
    next();
  };
}
