import type { Logger, Tracker, TeamConfig, Vcs, WorkflowEvent } from "@outstaff/core";
import type { Clock } from "../clock.js";
import type { Store } from "../store/index.js";
import type { BackoffOptions } from "./backoff.js";

export interface IntakeMeta {
  source: "vcs" | "tracker";
  externalId: string;

  /**
   * False when a human without write access (or not on the explicit `humans` list) caused the event. Such events
   * are recorded and delivered but must not be treated as instructions; they also carry `data.untrusted: true`.
   */
  trusted: boolean;
}

/**
 * Delivery is at-least-once: an event stays unprocessed until every handler returned, is redelivered after a
 * handler error (with backoff) or a restart, and in order. Handlers must therefore be idempotent.
 */
export type EventHandler = (event: WorkflowEvent, meta: IntakeMeta) => void | Promise<void>;

export interface IntakeOptions {
  store: Store;
  ports: { vcs: Vcs; tracker?: Tracker };
  team: TeamConfig;
  clock: Clock;
  logger: Logger;

  /** How long a cached VCS permission lookup stays valid. Default 10 minutes. */
  trustTtlMs?: number;
  backoff?: Partial<BackoffOptions>;

  /** Webhook mode only. Port 0 picks a free one. */
  webhook?: { port: number; host?: string };

  /** Warn when a polled source has had no successful poll for this long. Default 10 minutes; `office.poll_warn_after_minutes`. */
  stalePollMinutes?: number;

  /** Delivery attempts before an event is given up on and marked processed with an error. Default 5. */
  maxAttempts?: number;

  /** Overrides how a VCS login maps to a team person (for tests); by default only `people[].identities.vcs` counts. */
  resolveAgent?: (login: string) => string | undefined;
}

export interface Intake {
  start(): Promise<void>;
  stop(): Promise<void>;
  onEvent(handler: EventHandler): void;

  /** Poll mode: run one pass over every source now, outside the timer schedule. */
  pollOnce(): Promise<void>;

  /** Webhook mode: where the receiver listens, once started. */
  address(): { host: string; port: number } | undefined;
}
