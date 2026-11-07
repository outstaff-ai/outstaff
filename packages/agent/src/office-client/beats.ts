import type { Logger } from "@outstaff/core";
import type { ClientClock, RequestFn } from "./types.js";

/** Heartbeats in a row the office may leave unanswered before the agent gives up on the connection. */
const MISSES_ALLOWED = 1;

/**
 * Sends a heartbeat every `heartbeatMs` for each running item (one without an item when none runs), each waiting
 * `heartbeatMs` for its answer. A beat that goes unanswered is sent once more right away; only a second miss in a row
 * calls `silent`. A busy office then has two intervals to answer before the agent reconnects.
 */
export function createBeats(deps: {
  clock: ClientClock;
  log: Logger;
  request: RequestFn;
  connected(): boolean;
  items(): Iterable<string>;
  silent(): void;
}) {
  const { clock, log, request } = deps;
  let cancel: (() => void) | undefined;
  // A beat answered or missed on an earlier connection does not schedule the next one on this.
  let generation = 0;

  function schedule(heartbeatMs: number, missed: number, delayMs: number, gen: number) {
    cancel?.();
    cancel = clock.setTimeout(() => {
      if (gen !== generation || !deps.connected()) {
        return;
      }

      const ids = [...deps.items()];
      const beats =
        ids.length === 0
          ? [request("heartbeat", {}, heartbeatMs)]
          : ids.map((workItemId) => request("heartbeat", { workItemId }, heartbeatMs));

      Promise.all(beats).then(
        () => gen === generation && schedule(heartbeatMs, 0, heartbeatMs, gen),
        () => gen === generation && onMiss(heartbeatMs, missed + 1, gen),
      );
    }, delayMs);
  }

  function onMiss(heartbeatMs: number, missed: number, gen: number) {
    if (missed > MISSES_ALLOWED) {
      log.warn("office did not answer a heartbeat; reconnecting", { missed });
      deps.silent();
      return;
    }

    log.info("office did not answer a heartbeat; sending another", { missed });
    schedule(heartbeatMs, missed, 0, gen);
  }

  return {
    start(heartbeatMs: number) {
      generation += 1;
      schedule(heartbeatMs, 0, heartbeatMs, generation);
    },

    stop() {
      generation += 1;
      cancel?.();
      cancel = undefined;
    },
  };
}
