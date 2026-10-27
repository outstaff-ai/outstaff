import type {
  ActorKind,
  DocEvent,
  Knowledge,
  Logger,
  Member,
  RepoRef,
  Tracker,
  TeamConfig,
  TrackerEvent,
  UnmappedEvent,
  Vcs,
  VcsEvent,
  WorkflowEvent,
} from "@outstaff/core";
import type { Store } from "#/store/index.js";
import type { Clock } from "#/types.js";

export interface BackoffOptions {
  /** First retry delay after an `unavailable` failure. Default 1000. */
  baseMs: number;

  /** Cap for exponential growth and for an adapter-provided `retryAfterMs`. Default 300000. */
  maxMs: number;
}

export interface Actor {
  kind: ActorKind;
  id: string;

  /** Only meaningful for humans. */
  trusted: boolean;
}

export interface Trust {
  vcsActor(repo: RepoRef, login: string): Promise<Actor>;
  trackerActor(member: Member): Actor;
}

export interface TrustOptions {
  store: Store;
  vcs: Vcs;
  team: TeamConfig;
  clock: Clock;
  ttlMs?: number;
  resolveAgent?: (login: string) => string | undefined;
}

/** Verifies and parses one delivery. Throws `PortError` (`forbidden`, `invalid`, `unsupported`). */
export type WebhookParser = (
  headers: Record<string, string | undefined>,
  body: string,
) => Promise<void>;

export interface WebhookServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

export interface IntakeMeta {
  source: "vcs" | "tracker" | "knowledge";
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
  ports: { vcs: Vcs; tracker?: Tracker; knowledge?: Knowledge };

  /**
   * The documents agents wrote for open work, whose comments the knowledge source reads: at most `limit`, the most
   * recently active first. Without it nothing is read from the knowledge base.
   */
  docs?: { open(limit: number): { id: string; ticket?: string }[] };
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

/** What intake records for an event: the raw identity, the normalized event, and whether to trust it. */
export interface StoredPayload {
  raw: { externalId: string; type: string };
  event: WorkflowEvent;
  trusted: boolean;
}

export interface DeliveryOptions {
  store: Store;
  clock: Clock;
  logger: Logger;
  backoff: BackoffOptions;
  maxAttempts: number;

  /** Whether intake runs; a failed event is only retried on a timer while it does. */
  isRunning(): boolean;
}

export interface Delivery {
  readonly handlers: EventHandler[];

  /** Delivers the unprocessed events in order; `force` retries a failed head event before its backoff ran out. */
  drain(force?: boolean): Promise<void>;

  /** Cancels a pending retry. */
  cancelRetry(): void;

  /** Settles once the drains started so far are done. */
  settled(): Promise<void>;
}

export interface IngestOptions {
  store: Store;
  vcs: Vcs;
  clock: Clock;
  logger: Logger;
  trust: Trust;

  /** Resolves `@mentions` to agent handles; unset when the switch is off. */
  mentions: ((names: unknown) => string[]) | undefined;
  drain(): Promise<void>;
}

export interface Ingest {
  vcs(event: VcsEvent): Promise<void>;
  tracker(event: TrackerEvent): Promise<void>;
  doc(event: DocEvent, ticket: string | undefined): Promise<void>;
  logUnmapped(source: IntakeMeta["source"], page: { unmapped?: UnmappedEvent[] }): void;
}

export interface SourcesOptions {
  store: Store;
  ports: IntakeOptions["ports"];
  team: TeamConfig;
  docs: IntakeOptions["docs"];
  repos: RepoRef[];
  logger: Logger;
  ingest: Ingest;
}

export interface PollSource {
  name: "vcs" | "tracker" | "knowledge";
  poll(): Promise<void>;

  /** No webhook exists for it, so it is polled in webhook mode too. */
  always?: true;
}

export interface PollerOptions {
  clock: Clock;
  logger: Logger;
  backoff: BackoffOptions;
  intervalMs: number;
  stalePollMs: number;

  /** Whether intake runs; a source is only polled again while it does. */
  isRunning(): boolean;
}

export interface Poller {
  /** Starts polling the source after `delayMs`, `failures` being the failed polls in a row so far. */
  schedule(source: PollSource, delayMs: number, failures: number): void;

  /** Counts the sources' quiet time from now. */
  reset(sources: readonly PollSource[]): void;

  /** Cancels the timers and waits for the polls in flight. */
  stop(): Promise<void>;
}
