import type { Clock } from "./types.js";

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The service allows about 100 requests while each comes within a second of the previous one; stay well under. */
export const BURST_BUDGET = 80;

/** A key counts as idle, and its burst as over, after this long without a request (the service needs about 1 s). */
export const IDLE_MS = 1_100;

/** Wait before retrying a request the service refused after a burst. */
export const RETRY_AFTER_BURST_MS = 1_200;

/**
 * Paces the requests of one API key. A burst is a run of requests each less than IDLE_MS after the
 * previous; when the budget of a burst is spent, the next request waits until the key has been idle.
 */
export class Pacer {
  private count = 0;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock = realClock,
    private readonly budget: number = BURST_BUDGET,
  ) {}

  /** Resolves when a request may go out; returns how many requests the current burst holds, this one included. */
  async acquire(): Promise<number> {
    for (;;) {
      const now = this.clock.now();
      if (now - this.last >= IDLE_MS) {
        this.count = 0;
      }

      if (this.count < this.budget) {
        this.count += 1;
        this.last = now;
        return this.count;
      }

      await this.clock.sleep(Math.max(this.last + IDLE_MS - now, 1));
    }
  }

  /** Forgets the burst, for a caller that has waited out the idle time itself. */
  reset(): void {
    this.count = 0;
    this.last = Number.NEGATIVE_INFINITY;
  }
}

const pacers = new Map<string, Pacer>();

/** One pacer per API key and host, shared by the tracker and knowledge adapters of a process. */
export function pacerFor(apiUrl: string, apiKey: string): Pacer {
  const id = `${apiUrl}\n${apiKey}`;
  let pacer = pacers.get(id);
  if (!pacer) {
    pacer = new Pacer();
    pacers.set(id, pacer);
  }

  return pacer;
}
