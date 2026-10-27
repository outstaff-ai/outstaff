import { PortError } from "@outstaff/core";
import type { BackoffOptions } from "./types.js";

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
