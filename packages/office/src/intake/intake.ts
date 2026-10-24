import { parseRepoUrl, PortError } from "@outstaff/core";
import type { RepoRef, TrackerEvent, VcsEvent, WorkflowEvent } from "@outstaff/core";
import type { Cancel } from "../clock.js";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
import { normalizeTrackerEvent, normalizeVcsEvent } from "./normalize.js";
import { createTrust } from "./trust.js";
import type { EventHandler, Intake, IntakeMeta, IntakeOptions } from "./types.js";
import { createWebhookServer, type WebhookParser, type WebhookServer } from "./webhook.js";

const CURSOR_KEY = "events";
const DEFAULT_MAX_ATTEMPTS = 5;

interface StoredPayload {
  raw: { externalId: string; type: string };
  event: WorkflowEvent;
  trusted: boolean;
}

export function createIntake(opts: IntakeOptions): Intake {
  const { store, ports, team, clock, logger } = opts;
  const mode = team.office?.events ?? "poll";
  const intervalMs = (team.office?.poll_interval_seconds ?? 60) * 1000;
  const backoff: BackoffOptions = { ...DEFAULT_BACKOFF, ...opts.backoff };
  const repos: RepoRef[] = team.repos.map((r) => {
    const { host, owner, name } = parseRepoUrl(r.url);
    return { host, owner, name };
  });

  const trust = createTrust({
    store,
    vcs: ports.vcs,
    team,
    clock,
    ...(opts.trustTtlMs === undefined ? {} : { ttlMs: opts.trustTtlMs }),
    ...(opts.resolveAgent ? { resolveAgent: opts.resolveAgent } : {}),
  });

  const handlers: EventHandler[] = [];
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let running = false;
  let cancelRetry: Cancel | undefined;
  let blocked = false;

  const deliver = async (event: WorkflowEvent, meta: IntakeMeta): Promise<unknown> => {
    let failure: unknown;
    for (const handler of handlers) {
      try {
        await handler(event, meta);
      } catch (error) {
        failure ??= error;
        logger.warn("event handler failed", { type: event.type, error: String(error) });
      }
    }

    return failure;
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
      const { event, trusted } = stored.payload as StoredPayload;
      const failure = await deliver(event, {
        source: stored.source as IntakeMeta["source"],
        externalId: stored.externalId,
        trusted,
      });

      if (failure === undefined) {
        await store.markProcessed(stored.source, stored.externalId);
        continue;
      }

      const attempts = await store.noteEventAttempt(stored.source, stored.externalId);
      if (attempts >= maxAttempts) {
        logger.error("giving up on event", {
          source: stored.source,
          externalId: stored.externalId,
          attempts,
        });

        await store.markProcessed(stored.source, stored.externalId, String(failure));
        continue;
      }

      // Later events wait behind this one to keep the order.
      blocked = true;
      if (running) {
        cancelRetry = clock.setTimeout(
          () => void drain(true),
          backoffDelay(failure, attempts, backoff),
        );
      }

      return;
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

  // Classify first (may throw on a transient failure and abort the page), then dedupe-and-record, then deliver.
  const ingest = async (
    source: IntakeMeta["source"],
    raw: { externalId: string; type: string },
    normalize: () => Promise<{ event: WorkflowEvent; trusted: boolean } | undefined>,
  ) => {
    const result = await normalize();
    if (!result) {
      logger.debug("event not mapped", { source, type: raw.type });
      return;
    }

    const payload: StoredPayload = { raw, event: result.event, trusted: result.trusted };
    const fresh = await store.recordEvent({
      source,
      externalId: raw.externalId,
      type: result.event.type,
      payload,
    });

    if (fresh) {
      await drain();
    }
  };

  const ingestVcs = (event: VcsEvent) =>
    ingest("vcs", event, async () => {
      const actor = await trust.vcsActor(event.repo, event.actor);
      const mapped = normalizeVcsEvent(event, actor);
      return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
    });

  const ingestTracker = (event: TrackerEvent) =>
    ingest("tracker", event, async () => {
      const actor = trust.trackerActor(event.actor);
      const mapped = normalizeTrackerEvent(event, actor);
      return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
    });

  // With no stored cursor the source returns its recent history; that is not news, so only remember where "now" is.
  const setBaseline = async (source: IntakeMeta["source"], cursor: string) => {
    await store.setCursor(source, CURSOR_KEY, cursor);
    logger.info(`intake: baseline set for ${source}`);
  };

  interface Source {
    name: "vcs" | "tracker";
    poll(): Promise<void>;
  }

  const sources: Source[] = [
    {
      name: "vcs",
      async poll() {
        const cursor = await store.getCursor("vcs", CURSOR_KEY);
        const page = await ports.vcs.events(repos, cursor);
        if (cursor === undefined) {
          await setBaseline("vcs", page.cursor);
          return;
        }

        for (const event of page.events) {
          await ingestVcs(event);
        }

        await store.setCursor("vcs", CURSOR_KEY, page.cursor);
      },
    },
  ];

  const { tracker } = ports;
  if (tracker && team.integrations.tracker) {
    sources.push({
      name: "tracker",
      async poll() {
        const cursor = await store.getCursor("tracker", CURSOR_KEY);
        const page = await tracker.events(cursor);
        if (cursor === undefined) {
          await setBaseline("tracker", page.cursor);
          return;
        }

        for (const event of page.events) {
          await ingestTracker(event);
        }

        await store.setCursor("tracker", CURSOR_KEY, page.cursor);
      },
    });
  }

  const timers = new Map<string, Cancel>();
  const inFlight = new Set<Promise<void>>();

  const schedule = (source: Source, delayMs: number, failures: number) => {
    timers.set(
      source.name,
      clock.setTimeout(() => {
        const run = (async () => {
          let next = failures;
          let delay = intervalMs;
          try {
            await source.poll();
            next = 0;
          } catch (error) {
            next = failures + 1;
            delay = backoffDelay(error, next, backoff);
            logger.warn("poll failed", {
              source: source.name,
              code: error instanceof PortError ? error.code : "error",
              retryInMs: delay,
              error: String(error),
            });
          }

          if (running) {
            schedule(source, delay, next);
          }
        })();

        inFlight.add(run);
        void run.finally(() => inFlight.delete(run));
      }, delayMs),
    );
  };

  const webhookParsers = (): Record<string, WebhookParser> => {
    const parsers: Record<string, WebhookParser> = {};
    if (ports.vcs.parseWebhook) {
      parsers["vcs"] = async (headers, body) => {
        for (const event of await ports.vcs.parseWebhook!(headers, body)) {
          await ingestVcs(event);
        }
      };
    }

    if (tracker?.parseWebhook) {
      parsers["tracker"] = async (headers, body) => {
        for (const event of await tracker.parseWebhook!(headers, body)) {
          await ingestTracker(event);
        }
      };
    }

    return parsers;
  };

  let server: WebhookServer | undefined;
  let address: { host: string; port: number } | undefined;

  return {
    onEvent(handler) {
      handlers.push(handler);
      if (running) {
        void drain(true);
      }
    },
    async start() {
      if (running) {
        return;
      }

      running = true;
      await drain(true);
      if (mode === "webhook") {
        const parsers = webhookParsers();
        if (Object.keys(parsers).length === 0) {
          running = false;
          throw new PortError("unsupported", "Webhook mode needs an adapter with parseWebhook.");
        }

        server = createWebhookServer({
          port: opts.webhook?.port ?? 8080,
          ...(opts.webhook?.host === undefined ? {} : { host: opts.webhook.host }),
          sources: parsers,
          logger,
        });

        address = await server.listen();
        return;
      }

      for (const source of sources) {
        schedule(source, 0, 0);
      }
    },
    async stop() {
      running = false;
      cancelRetry?.();
      cancelRetry = undefined;
      for (const cancel of timers.values()) {
        cancel();
      }

      timers.clear();
      await Promise.allSettled(inFlight);
      await chain;
      await server?.close();
      server = undefined;
      address = undefined;
    },
    async pollOnce() {
      for (const source of sources) {
        await source.poll();
      }
    },
    address: () => address,
  };
}
