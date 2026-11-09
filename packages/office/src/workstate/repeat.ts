import type { Logger } from "@outstaff/core";
import type { Cancel, Clock } from "#/types.js";

/**
 * Runs `run` on the clock every `ms` while started, each run after the one before ends. A failed run is logged as
 * `<what> failed`, and the next one still comes.
 */
export function repeating(
  clock: Clock,
  logger: Pick<Logger, "warn">,
  what: string,
  ms: number,
  run: () => Promise<void>,
) {
  let timer: Cancel | undefined;
  let running = false;
  const next = () => {
    timer = clock.setTimeout(() => {
      void run().then(
        () => running && next(),
        (error: unknown) => {
          logger.warn(`${what} failed`, { error: String(error) });
          if (running) {
            next();
          }
        },
      );
    }, ms);
  };

  return {
    running: () => running,
    start() {
      running = true;
      next();
    },
    stop() {
      running = false;
      timer?.();
      timer = undefined;
    },
  };
}
