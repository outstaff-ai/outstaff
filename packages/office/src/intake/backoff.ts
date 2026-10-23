import { PortError } from "@outstaff/core";

export interface BackoffOptions {
  /** First retry delay after an `unavailable` failure. Default 1000. */
  baseMs: number;

  /** Cap for exponential growth and for an adapter-provided `retryAfterMs`. Default 300000. */
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 300_000 };

/** Delay before the next poll after `failures` consecutive failures (>= 1). */
export function backoffDelay(error: unknown, failures: number, opts: BackoffOptions): number {
  if (
    error instanceof PortError &&
    error.code === "rate_limited" &&
    error.retryAfterMs !== undefined
  ) {
    return Math.min(Math.max(error.retryAfterMs, 0), opts.maxMs);
  }

  return Math.min(opts.baseMs * 2 ** Math.max(0, failures - 1), opts.maxMs);
}
