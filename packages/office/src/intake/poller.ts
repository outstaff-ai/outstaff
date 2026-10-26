import { PortError } from "@outstaff/core";
import { clip } from "../log.js";
import type { Cancel } from "../types.js";
import { backoffDelay } from "./backoff.js";
import type { PollSource, Poller, PollerOptions } from "./types.js";

/** Polls each source on its own timer, backing off after failures. */
export function createPoller(opts: PollerOptions): Poller {
  const { clock, logger, backoff, intervalMs, stalePollMs } = opts;
  const lastOk = new Map<string, number>();
  const timers = new Map<string, Cancel>();
  const inFlight = new Set<Promise<void>>();

  const schedule = (source: PollSource, delayMs: number, failures: number) => {
    timers.set(
      source.name,
      clock.setTimeout(() => {
        const run = (async () => {
          let next = failures;
          let delay = intervalMs;
          try {
            await source.poll();
            next = 0;
            lastOk.set(source.name, clock.now().getTime());
          } catch (error) {
            next = failures + 1;
            delay = backoffDelay(error, next, backoff);
            const code = error instanceof PortError ? error.code : "error";
            logger.error(
              `intake: ${source.name} poll failed (${code}), retrying in ${Math.round(delay / 1000)}s`,
              {
                source: source.name,
                code,
                retryInMs: delay,
                error: clip(String(error), 200),
              },
            );

            const quietMs =
              clock.now().getTime() - (lastOk.get(source.name) ?? clock.now().getTime());

            if (quietMs >= stalePollMs) {
              const minutes = Math.floor(quietMs / 60_000);
              logger.warn(`intake: no successful ${source.name} poll for ${minutes} minutes`, {
                source: source.name,
                minutes,
              });
            }
          }

          if (opts.isRunning()) {
            schedule(source, delay, next);
          }
        })();

        inFlight.add(run);
        void run.finally(() => inFlight.delete(run));
      }, delayMs),
    );
  };

  return {
    schedule,
    reset(sources) {
      for (const source of sources) {
        lastOk.set(source.name, clock.now().getTime());
      }
    },
    async stop() {
      for (const cancel of timers.values()) {
        cancel();
      }

      timers.clear();
      await Promise.allSettled(inFlight);
    },
  };
}
