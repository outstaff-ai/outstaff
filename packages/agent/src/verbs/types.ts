import type {
  Chat,
  Knowledge,
  Layout,
  Logger,
  Policy,
  PortName,
  TeamConfig,
  Tracker,
  Vcs,
} from "@outstaff/core";
import type { z } from "zod";
import type { Attachment } from "../runner/attachments.js";
import type { ToolStatus } from "../tools/types.js";
import type { OfficeClient } from "./office.js";

/** What every verb returns; `text` already contains every URL in `links`. */
export interface VerbResult {
  text: string;
  data: unknown;
  links: string[];
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

export function defineVerb<S extends z.ZodObject>(
  verb: Omit<Verb, "input" | "run" | "cli"> & {
    cli?: string[];
    input: S;
    run(env: AgentEnv, input: z.output<S>, ctx: VerbContext): Promise<VerbResult>;
  },
): Verb {
  return verb as unknown as Verb;
}

/** Text from lines and the links they must contain. */
export function result(lines: string[], data: unknown, links: string[]): VerbResult {
  const unique = [...new Set(links)];
  const text = lines.join("\n");
  const missing = unique.filter((l) => !text.includes(l));
  return {
    text: missing.length ? `${text}\n${missing.join("\n")}` : text,
    data,
    links: unique,
  };
}
