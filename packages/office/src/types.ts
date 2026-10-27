import type {
  AdapterRegistry,
  Chat,
  Knowledge,
  Logger,
  SecretSource,
  Tracker,
  Vcs,
} from "@outstaff/core";
import type { LOG_LEVELS } from "./main.js";
import type { Office } from "./office.types.js";

export type Cancel = () => void;

/** Time source for every office component, injected so tests are deterministic. */
export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): Cancel;
}

export interface ManualClock extends Clock {
  /** Moves time forward, firing due timers in order (timers they schedule included). */
  advance(ms: number): void;
  pending(): number;
}

export interface HealthServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port(): number;
}

export interface OfficePorts {
  vcs: Vcs;
  tracker?: Tracker;
  chat?: Chat;

  /** Only to read the comments people leave on documents; the agents write documents through their own port. */
  knowledge?: Knowledge;
}

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface RunningOffice {
  office: Office;
  health: HealthServer;
  stop(): Promise<void>;
}

export interface StartDeps {
  registry?: AdapterRegistry;
  secrets?: SecretSource;
  logger?: Logger;
  stockCatalogDir?: string;
}
