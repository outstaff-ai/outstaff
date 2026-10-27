import type { Logger, PrRef, TeamConfig } from "@outstaff/core";
import type { LinkPayloadOf } from "@outstaff/protocol";
import type { Store, WorkItemStatus } from "#/store/types.js";
import type { Clock } from "#/types.js";

export type LinkStore = Pick<
  Store,
  | "listItems"
  | "getItem"
  | "listRuns"
  | "readJournal"
  | "getSubject"
  | "getTrace"
  | "listTraces"
  | "listTracesRecorded"
>;

export interface OfficeLinkOptions {
  /** `link.url` from the team file, for example `wss://ops.acme.example/link`. */
  url: string;

  /** `OUTSTAFF_LINK_TOKEN`, sent as the bearer token. */
  token: string;
  team: Pick<TeamConfig, "people">;
  store: LinkStore;

  /** Links to tickets, pull requests and documents, from the office's adapters. */
  links: SubjectLinks;

  /** Who this office is, for the `hello` after the service's welcome. */
  identity: LinkPayloadOf<"hello">["office"];

  /** Handles of the people whose agent is connected now. */
  connected(): string[];
  clock: Clock;
  logger: Logger;

  /** How often the link looks for changes to notify. Default 1000. */
  pollMs?: number;

  /** How often it pings a quiet service; three silent intervals close the connection. Default 15000. */
  pingMs?: number;

  /** How long a request may take before it is answered with `timeout`. Default 10000. */
  requestTimeoutMs?: number;
  backoff?: { baseMs?: number; maxMs?: number };

  /** 0..1, for jitter. Default Math.random. */
  random?: () => number;
}

export type LinkState = "idle" | "connecting" | "connected" | "backoff" | "stopped";

export interface LinkStatus {
  state: LinkState;

  /** Why the last connection failed or ended, if it did. */
  lastError?: string | undefined;
}

/** The office's connection out to a service. It never throws and never holds up the office. */
export interface OfficeLink {
  start(): void;
  stop(): Promise<void>;
  status(): LinkStatus;
}

/** Where shipping traces stands: the latest recording time sent, and the traces sent at exactly that time. */
export interface TraceCursor {
  from?: string | undefined;
  sent: ReadonlySet<string>;
}

export interface EventFilter {
  since?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
  source?: string | undefined;
  person?: string | undefined;
  ticket?: string | undefined;
  pr?: string | undefined;

  /** Only events where the engine and the pipeline differ. */
  differs?: true | undefined;
}

export interface ItemFilter {
  status?: WorkItemStatus | undefined;
  person?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}

export interface Notifier {
  /** Takes stock when the service welcomes the office, and sends the people. */
  begin(): Promise<void>;

  /** Sends what changed since the last look. */
  look(): Promise<void>;
}

/** Where the office's adapters say a subject lives, for the ones they know. */
export interface SubjectLinks {
  ticket?(key: string): string;
  pr?(pr: PrRef): string;
  doc?(id: string): string;
}
