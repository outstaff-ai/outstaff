import { parseRepoUrl, PortError } from "@outstaff/core";
import type {
  DocEvent,
  RepoRef,
  TrackerEvent,
  UnmappedEvent,
  VcsEvent,
  WorkflowEvent,
} from "@outstaff/core";
import type { Cancel } from "../clock.js";
import { clip, prLabel, subjectLabel } from "../log.js";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.js";
import { normalizeDocEvent, normalizeTrackerEvent, normalizeVcsEvent } from "./normalize.js";
import { createTrust } from "./trust.js";
import type { EventHandler, Intake, IntakeMeta, IntakeOptions } from "./types.js";
import { createWebhookServer, type WebhookParser, type WebhookServer } from "./webhook.js";

const CURSOR_KEY = "events";
const DEFAULT_MAX_ATTEMPTS = 5;
const TRANSIENT = new Set(["rate_limited", "unavailable"]);
const DEFAULT_STALE_POLL_MINUTES = 10;

/** How many documents one poll of the knowledge base reads the comments of. */
export const DOC_POLL_LIMIT = 25;

/** The adapters re-read the last 5 minutes of each feed, so an id older than that no longer comes back. */
const UNMAPPED_MEMORY_MS = 5 * 60_000;
const UNMAPPED_MEMORY_CAP = 5_000;

interface StoredPayload {
  raw: { externalId: string; type: string };
  event: WorkflowEvent;
  trusted: boolean;
}

export function createIntake(opts: IntakeOptions): Intake {
  const { store, ports, team, clock, logger } = opts;
  const mode = team.office?.events ?? "poll";
  const intervalMs = (team.office?.poll_interval_seconds ?? 60) * 1000;
  const stalePollMs =
    (opts.stalePollMinutes ?? team.office?.poll_warn_after_minutes ?? DEFAULT_STALE_POLL_MINUTES) *
    60_000;

  const backoff: BackoffOptions = { ...DEFAULT_BACKOFF, ...opts.backoff };
  const repos: RepoRef[] = team.repos.map((r) => {
    const { host, owner, name } = parseRepoUrl(r.url);
    return { host, owner, name };
  });

  // Feeds are re-read with an overlap, so an unmapped event comes back on every poll. It is logged at info
  // once per event id and at debug after that. Kept in memory: after a restart it may be logged at info again.
  const seenUnmapped = new Map<string, number>();
  const firstSighting = (source: string, externalId: string): boolean => {
    const now = clock.now().getTime();
    for (const [key, at] of seenUnmapped) {
      if (now - at <= UNMAPPED_MEMORY_MS && seenUnmapped.size < UNMAPPED_MEMORY_CAP) {
        break;
      }

      seenUnmapped.delete(key);
    }

    const key = `${source}:${externalId}`;
    if (seenUnmapped.has(key)) {
      return false;
    }

    seenUnmapped.set(key, now);
    return true;
  };

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
        logger.warn("event handler failed", { type: event.type, error: clip(String(error)) });
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
    subject: string,
    normalize: () => Promise<{ event: WorkflowEvent; trusted: boolean } | undefined>,
  ) => {
    const dropped = (reason: string, level: "info" | "debug" = "debug") =>
      logger[level](`intake: dropped ${source} ${raw.type} on ${subject}: ${reason}`, {
        source,
        type: raw.type,
        subject,
        externalId: raw.externalId,
        reason,
      });

    const result = await normalize();
    if (!result) {
      dropped(
        "the office does not map this event type",
        firstSighting(source, raw.externalId) ? "info" : "debug",
      );

      return;
    }

    const payload: StoredPayload = { raw, event: result.event, trusted: result.trusted };
    const fresh = await store.recordEvent({
      source,
      externalId: raw.externalId,
      type: result.event.type,
      payload,
    });

    const { event } = result;
    const where = subjectLabel(event.subject);
    if (!fresh) {
      dropped("duplicate of an event already recorded");
      return;
    }

    logger.info(
      `intake: recorded ${source} ${event.type} on ${where} by ${event.actor.id} (${result.trusted ? "trusted" : "untrusted"})`,
      {
        source,
        type: event.type,
        subject: where,
        actor: event.actor.id,
        actorKind: event.actor.kind,
        trusted: result.trusted,
      },
    );

    await drain();
  };

  const logUnmapped = (source: IntakeMeta["source"], page: { unmapped?: UnmappedEvent[] }) => {
    for (const u of page.unmapped ?? []) {
      const subject = u.repo ? `${u.repo.owner}/${u.repo.name}` : source;
      const level = firstSighting(source, u.externalId) ? "info" : "debug";
      logger[level](
        `intake: dropped ${source} ${u.type} on ${subject}: the adapter does not map this event type`,
        {
          source,
          type: u.type,
          subject,
          externalId: u.externalId,
          reason: "the adapter does not map this event type",
        },
      );
    }
  };

  const ingestVcs = (event: VcsEvent) =>
    ingest("vcs", event, prLabel(event), async () => {
      const actor = await trust.vcsActor(event.repo, event.actor);
      const mapped = normalizeVcsEvent(event, actor);
      if (mapped && actor.kind === "human") {
        await withInlineComments(event, mapped);
      }

      return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
    });

  // A submitted review brings the inline comments it was written with; they are stored with the event.
  const withInlineComments = async (event: VcsEvent, mapped: WorkflowEvent) => {
    const id = event.type === "pr.review_submitted" ? event.data["reviewId"] : undefined;
    if (id === undefined || id === null) {
      return;
    }

    try {
      const found = await ports.vcs.reviewComments(event.repo, event.number, String(id));
      if (found.length > 0) {
        mapped.data["comments"] = found.map((c) => ({
          id: c.id,
          path: c.path,
          ...(c.line === undefined ? {} : { line: c.line }),
          body: c.body,
          ...(c.url ? { url: c.url } : {}),
          ...(c.threadId ? { threadId: c.threadId } : {}),
        }));
      }
    } catch (error) {
      // Transient failures abort the page so it is retried; the cursor does not move.
      if (!(error instanceof PortError) || TRANSIENT.has(error.code)) {
        throw error;
      }

      logger.warn(`intake: inline comments of review ${String(id)} not read: ${error.message}`, {
        review: String(id),
        code: error.code,
      });
    }
  };

  const ingestTracker = (event: TrackerEvent) =>
    ingest("tracker", event, event.key, async () => {
      const actor = trust.trackerActor(event.actor);
      const mapped = normalizeTrackerEvent(event, actor);
      return mapped && { event: mapped, trusted: actor.kind !== "human" || actor.trusted };
    });

  const ingestDoc = (event: DocEvent, ticket: string | undefined) =>
    ingest("knowledge", event, event.doc, async () => {
      const actor = trust.trackerActor(event.actor);
      return {
        event: normalizeDocEvent(event, actor, ticket),
        trusted: actor.kind !== "human" || actor.trusted,
      };
    });

  // With no stored cursor the source returns its recent history; that is not news, so only remember where "now" is.
  const setBaseline = async (source: IntakeMeta["source"], cursor: string) => {
    await store.setCursor(source, CURSOR_KEY, cursor);
    logger.info(`intake: baseline set for ${source}`);
  };

  interface Source {
    name: "vcs" | "tracker" | "knowledge";
    poll(): Promise<void>;

    /** No webhook exists for it, so it is polled in webhook mode too. */
    always?: true;
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

        logUnmapped("vcs", page);
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

        logUnmapped("tracker", page);
        for (const event of page.events) {
          await ingestTracker(event);
        }

        await store.setCursor("tracker", CURSOR_KEY, page.cursor);
      },
    });
  }

  const { knowledge } = ports;
  if (knowledge && opts.docs) {
    const watched = opts.docs;
    sources.push({
      name: "knowledge",
      always: true,
      async poll() {
        const cursor = await store.getCursor("knowledge", CURSOR_KEY);
        const docs = watched.open(DOC_POLL_LIMIT);
        // Nothing to read yet: the first call still happens, so that what is written before the first document is
        // not mistaken for the baseline later.
        if (cursor !== undefined && docs.length === 0) {
          return;
        }

        const page = await knowledge.events(
          docs.map((d) => d.id),
          cursor,
        );

        if (cursor === undefined) {
          await setBaseline("knowledge", page.cursor);
          return;
        }

        const ticketOf = new Map(docs.map((d) => [d.id, d.ticket]));
        for (const event of page.events) {
          await ingestDoc(event, ticketOf.get(event.doc));
        }

        await store.setCursor("knowledge", CURSOR_KEY, page.cursor);
      },
    });
  }

  const lastOk = new Map<string, number>();
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
      for (const source of sources) {
        lastOk.set(source.name, clock.now().getTime());
      }

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
        for (const source of sources.filter((s) => s.always)) {
          schedule(source, 0, 0);
        }

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
