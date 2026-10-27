import type {
  AdapterRegistry,
  Logger,
  SecretSource,
  TeamConfig,
  Vcs,
  AdbGrant,
  Chat,
  Knowledge,
  Layout,
  Policy,
  PortName,
  Tracker,
} from "@outstaff/core";
import type { OfficeClient } from "./office.types.js";

import type { z } from "zod";
import type { Attachment } from "#/runner/types.js";
import type { ToolStatus } from "#/tools/types.js";

/** What every verb returns; `text` already contains every URL in `links`. */
export interface VerbResult {
  text: string;
  data: unknown;
  links: string[];
}

/** The services and devices this person may reach (`network` in team.yaml, roles and person merged). */
export interface NetworkAccess {
  http: {
    name: string;
    origin: string;

    /** The bearer token, read when a request is made; it never leaves the verb. */
    token?: () => string;
  }[];
  adb: AdbGrant[];

  /** Replaces the global `fetch` and the `adb` binary (tests only). */
  fetch?: typeof fetch;
  adbCommand?: string;
}

/** Everything a verb touches: who is acting, the team, and the ports built from its config. */
export interface AgentEnv {
  /** Handle of the person (agent) this process runs as. */
  person: string;

  team: TeamConfig;
  tracker?: Tracker;
  knowledge?: Knowledge;
  vcs?: Vcs;
  chat?: Chat;
  office?: OfficeClient;
  network?: NetworkAccess;

  /**
   * The person's Policy and directory layout. Verbs that read a file the caller names (`--body-file`) refuse
   * without them, and read only what the Policy lets the Read tool read.
   */
  policy?: Policy;
  layout?: Layout;

  /** Why a configured port is missing (adapter not installed, creation failed), by port. */
  unavailable?: Partial<Record<PortName, string>>;
  log?: Logger;

  /** The tools declared for this person and whether each installed; set at startup. */
  tools?: ToolStatus[];

  /**
   * The files shared in the chat message this chat session answers, downloaded to its scratch directory. Filing
   * the request as a ticket attaches them to it. Data from the requester.
   */
  attachments?: Attachment[];

  /** The files attached to tickets of this run, by ticket key, downloaded to the scratch directory. Data from whoever attached them. */
  ticketFiles?: Record<string, Attachment[]>;
}

export interface VerbContext {
  /** The work item the caller is running for, when there is one. */
  workItemId?: string;

  /** The directory the caller works in (its worktree); relative paths and a default repo and branch come from it. */
  cwd?: string;
}

export interface Verb {
  /** For example "ticket.show"; the CLI path is "ost ticket show" and the runtime tool is "ticket_show". */
  name: string;
  summary: string;
  description: string;
  input: z.ZodObject;

  /** Command path when it is not the name split at dots (`ost team` is the config view, so the roster is `ost roster`). */
  cli?: string[];

  /** Input fields taken as positional arguments on the command line, in order. */
  args: string[];
  examples: string[];
  run(env: AgentEnv, input: never, ctx: VerbContext): Promise<VerbResult>;
}

export interface VerbField {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array";
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];

  /** Position among the positional arguments, or undefined for an option. */
  arg?: number;
}

export interface Uploaded {
  attached: string[];
  failed: { name: string; reason: string }[];
}

export interface MentionGuard {
  /** `text` with each teammate's `@handle` replaced by their name. Throws `invalid` for any other login. */
  apply(text: string): string;
}

/** A code host that can merge: it declares `vcs.merge`, so it has all four operations. */
export type MergeVcs = Vcs &
  Required<Pick<Vcs, "reviewState" | "requiredChecks" | "mergeOptions" | "mergePullRequest">>;

export interface CreateAgentEnvOptions {
  team: TeamConfig;

  /** Handle of the person this process runs as. */
  person: string;
  registry: AdapterRegistry;
  secrets: SecretSource;
  office?: OfficeClient;

  log?: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}
