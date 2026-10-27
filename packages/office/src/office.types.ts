import type { AdapterRegistry, Logger, SecretSource, TeamConfig } from "@outstaff/core";
import type { OfficeDoctor } from "./doctor/index.js";
import type { Engine } from "./engine/index.js";
import type { Intake } from "./intake/index.js";
import type { ProtocolServer } from "./protocol/index.js";
import type { Scheduler } from "./scheduler/index.js";
import type { Store } from "./store/types.js";
import type { OfficeLink } from "./link/index.js";
import type { PipelineRunner } from "./pipeline/index.js";
import type { Clock, OfficePorts } from "./types.js";
import type { UsageTracker } from "./usage/index.js";
import type { WorkState } from "./workstate/index.js";

export interface OfficeOptions {
  /** Port of the agent connection (`/agent`). Default 8080. 0 picks a free one. */
  agentPort?: number;
  agentHost?: string;

  /** Port of the webhook receiver when `office.events` is "webhook". Default 8082. */
  webhookPort?: number;
  webhookHost?: string;

  /** Heartbeat interval the agents are told, and how often queues are checked for new work. */
  heartbeatMs?: number;
  pollMs?: number;

  /** How often the work state rescans open pull requests. */
  refreshIntervalMs?: number;
  staleAfterMinutes?: number;

  /** Minutes after which a usage report counts as unknown. Default 30. */
  usageStaleAfterMinutes?: number;
  officeVersion?: string;

  /** Where the office's secret files are, for the doctor's file mode checks. Default /run/secrets/outstaff. */
  secretsDir?: string;
}

export interface CreateOfficeInput {
  team: TeamConfig;
  registry: AdapterRegistry;
  secrets: SecretSource;
  store: Store;
  clock: Clock;
  logger?: Logger;

  /** What the doctor's adapter checks call the providers with. Default the global fetch (tests only). */
  fetch?: typeof fetch;

  /** The merged catalog (stock plus ejected); only the role titles and summaries are read. */
  catalog?: { roles: Record<string, { title: string; summary: string }> };
  options?: OfficeOptions;
}

export interface ComponentHealth {
  ok: boolean;
  detail?: string;
}

export interface OfficeHealth {
  ok: boolean;
  state: "created" | "starting" | "running" | "stopping" | "stopped";
  components: Record<string, ComponentHealth>;
}

export interface Office {
  /** Starts the agent connection first, then work state and intake, then the scheduler's housekeeping. */
  start(): Promise<void>;

  /** Stops taking in events, lets running handlers finish, closes connections and the store. Idempotent. */
  stop(): Promise<void>;
  health(): Promise<OfficeHealth>;

  /** Port the agents connect to, once started. */
  agentPort(): number;

  /** The parts, for diagnostics and tests. */
  readonly parts: {
    intake: Intake;
    workState: WorkState;
    engine: Engine;
    scheduler: Scheduler;
    usage: UsageTracker;
    server: ProtocolServer;
    ports: OfficePorts;

    /** The event pipeline in shadow or live mode (`office.pipeline`); absent when it is off. */
    pipeline?: PipelineRunner | undefined;

    /** The office link to a monitoring or management service (`link.url` and `OUTSTAFF_LINK_TOKEN`); absent without them. */
    link?: OfficeLink | undefined;

    /** The doctor checks: run at start, daily and on demand, and reported by the agents. */
    doctor: OfficeDoctor;
  };
}
