import type { Avatars } from "./avatars.js";
import type { Chat } from "./chat.js";
import type { PORT_ERROR_CODES } from "./errors.js";
import type { Knowledge } from "./knowledge.js";
import type { Runtime } from "./runtime.js";
import type { Tracker } from "./tracker.js";
import type { Vcs } from "./vcs.js";

export type CanonicalStatus =
  | "backlog"
  | "ready"
  | "active"
  | "review"
  | "blocked"
  | "done"
  | "canceled";

/** Canonical status -> the status name used in the tracker (from `team.workflow.statuses`). */
export type StatusMap = Partial<Record<CanonicalStatus, string>>;

export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface RepoRef {
  owner: string;
  name: string;
  host?: string;
}

export interface SecretSpec {
  key: string;
  description: string;

  /** Where to get it; shown by `ost setup`. */
  where: string;

  /** `ost setup --derive` can compute it. */
  derivable?: boolean;

  /** The adapter works without it (for example when another credential is supplied instead). */
  optional?: boolean;

  /** The condition that makes it needed, when the adapter asks for it only for some people; shown in the contract table. */
  when?: string;
}

export interface SecretSource {
  get(key: string): string | undefined;
  require(key: string): string;
}

export interface PortImpls {
  tracker: Tracker;
  knowledge: Knowledge;
  vcs: Vcs;
  chat: Chat;
  runtime: Runtime;
  avatars: Avatars;
}
