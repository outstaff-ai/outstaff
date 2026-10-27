import type { WorkflowEvent } from "@outstaff/core";
import { clip } from "../log.js";
import type { StoredEvent } from "../store/types.js";
import type { Cancel } from "../types.js";
import { backoffDelay } from "./backoff.js";
import type {
  Delivery,
  DeliveryOptions,
  EventHandler,
  IntakeMeta,
  StoredPayload,
} from "./types.js";

/** Hands recorded events to the handlers. */
export function createDelivery(opts: DeliveryOptions): Delivery {
  const { store, clock, logger, backoff, maxAttempts } = opts;
  const handlers: EventHandler[] = [];
  let cancelRetry: Cancel | undefined;
  let blocked = false;

  const deliver = async (event: WorkflowEvent, meta: IntakeMeta): Promise<unknown> => {
    let failure: unknown;
    for (const handler of handlers) {
      try {
        await handler(event, meta);
      } catch (error) {
        failure ??= error;
        logger.warn("event handler failed", { type: event.type, error: clip(String(error)) });
      }
    }

    return failure;
  };

  const deliverStored = (stored: StoredEvent) => {
    const { event, trusted } = stored.payload as StoredPayload;
    return deliver(event, {
      source: stored.source as IntakeMeta["source"],
      externalId: stored.externalId,
      trusted,
    });
  };

  /**
   * A handler failed on the event: after `maxAttempts` it is given up on, before that it holds back the events behind
   * it until its retry. True when delivery has to stop here.
   */
  const failed = async (stored: StoredEvent, failure: unknown): Promise<boolean> => {
    const attempts = await store.noteEventAttempt(stored.source, stored.externalId);
    if (attempts >= maxAttempts) {
      logger.error("giving up on event", {
        source: stored.source,
        externalId: stored.externalId,
        attempts,
      });

      await store.markProcessed(stored.source, stored.externalId, String(failure));
      return false;
    }

    // Later events wait behind this one to keep the order.
    blocked = true;
    if (opts.isRunning()) {
      cancelRetry = clock.setTimeout(
        () => void drain(true),
        backoffDelay(failure, attempts, backoff),
      );
    }

    return true;
  };

  // At-least-once: events stay unprocessed until every handler returned, and are redelivered in order.
  const drainOnce = async (force: boolean) => {
    // A failed head event waits for its backoff; new events must not trigger an early retry.
    if (blocked && !force) {
      return;
    }

    cancelRetry?.();
    cancelRetry = undefined;
    blocked = false;
    if (handlers.length === 0) {
      return;
    }

    for (const stored of await store.listUnprocessed()) {
      const failure = await deliverStored(stored);
      if (failure === undefined) {
        await store.markProcessed(stored.source, stored.externalId);
        continue;
      }

      if (await failed(stored, failure)) {
        return;
      }
    }
  };

  let chain: Promise<void> = Promise.resolve();
  const drain = (force = false): Promise<void> => {
    chain = chain
      .then(() => drainOnce(force))
      .catch((error: unknown) => {
        logger.error("event delivery failed", { error: String(error) });
      });

    return chain;
  };

  return {
    handlers,
    drain,
    cancelRetry() {
      cancelRetry?.();
      cancelRetry = undefined;
    },
    settled: () => chain,
  };
}
