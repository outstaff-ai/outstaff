import { createStatusMap, parseRepoUrl, policyOn, PortError } from "@outstaff/core";
import type { RepoRef } from "@outstaff/core";
import { DEFAULT_BACKOFF } from "./backoff.js";
import { createDelivery } from "./delivery.js";
import { createIngest } from "./ingest.js";
import { agentMentionResolver } from "./normalize.js";
import { createPoller } from "./poller.js";
import { pollSources, webhookParsers } from "./sources.js";
import { createTrust } from "./trust.js";
import type {
  BackoffOptions,
  Intake,
  IntakeOptions,
  StoredPayload,
  WebhookServer,
} from "./types.js";
import { createWebhookServer } from "./webhook.js";
import { defined } from "#/defined.js";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_STALE_POLL_MINUTES = 10;

/** How often to poll, and how long polling may fail before it is warned about. */
function pollTiming(opts: IntakeOptions) {
  const office = opts.team.office;
  const staleMinutes =
    opts.stalePollMinutes ?? office?.poll_warn_after_minutes ?? DEFAULT_STALE_POLL_MINUTES;

  return {
    intervalMs: (office?.poll_interval_seconds ?? 60) * 1000,
    stalePollMs: staleMinutes * 60_000,
  };
}

export function createIntake(opts: IntakeOptions): Intake {
  const { store, ports, team, clock, logger } = opts;
  const mode = team.office?.events ?? "poll";
  const { intervalMs, stalePollMs } = pollTiming(opts);

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
    ...defined({ ttlMs: opts.trustTtlMs, resolveAgent: opts.resolveAgent }),
  });

  // A trusted person's @mention of an agent in a comment; with the switch off nobody is mentioned.
  const mentions = policyOn(team.policies, "feedback.mentions")
    ? agentMentionResolver(team)
    : undefined;

  let running = false;
  const isRunning = () => running;
  const delivery = createDelivery({
    store,
    clock,
    logger,
    backoff,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    isRunning,
  });

  const { drain } = delivery;
  const ingest = createIngest({
    store,
    vcs: ports.vcs,
    clock,
    logger,
    trust,
    mentions,
    statuses: createStatusMap(team.workflow?.statuses),
    drain: () => drain(),
  });

  const sources = pollSources({ store, ports, team, docs: opts.docs, repos, logger, ingest });
  const poller = createPoller({ clock, logger, backoff, intervalMs, stalePollMs, isRunning });

  let server: WebhookServer | undefined;
  let address: { host: string; port: number } | undefined;

  const startWebhook = async () => {
    const parsers = webhookParsers(ports, ingest);
    if (Object.keys(parsers).length === 0) {
      running = false;
      throw new PortError("unsupported", "Webhook mode needs an adapter with parseWebhook.");
    }

    server = createWebhookServer({
      port: opts.webhook?.port ?? 8080,
      ...defined({ host: opts.webhook?.host }),
      sources: parsers,
      logger,
    });

    address = await server.listen();
  };

  return {
    onEvent(handler) {
      delivery.handlers.push(handler);
      if (running) {
        void drain(true);
      }
    },
    async start() {
      if (running) {
        return;
      }

      running = true;
      poller.reset(sources);
      await drain(true);
      if (mode === "webhook") {
        await startWebhook();
      }

      // In webhook mode only the sources without a webhook are polled.
      const polled = mode === "webhook" ? sources.filter((s) => s.always) : sources;
      for (const source of polled) {
        poller.schedule(source, 0, 0);
      }
    },
    async stop() {
      running = false;
      delivery.cancelRetry();
      await poller.stop();
      await delivery.settled();
      await server?.close();
      server = undefined;
      address = undefined;
    },
    async receive(event, meta) {
      const fresh = await store.recordEvent({
        source: meta.source,
        externalId: meta.externalId,
        type: event.type,
        payload: {
          raw: { externalId: meta.externalId, type: event.type },
          event,
          trusted: meta.trusted,
        } satisfies StoredPayload,
      });

      if (fresh) {
        void drain();
      }

      return fresh;
    },
    async pollOnce() {
      for (const source of sources) {
        await source.poll();
      }
    },
    address: () => address,
  };
}
