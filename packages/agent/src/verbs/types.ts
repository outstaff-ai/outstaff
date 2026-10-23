import type { Chat, Knowledge, Logger, PortName, TeamConfig, Tracker, Vcs } from "@outstaff/core";
import type { z } from "zod";
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

  /** Why a configured port is missing (adapter not installed, creation failed), by port. */
  unavailable?: Partial<Record<PortName, string>>;
  log?: Logger;

  /** The tools declared for this person and whether each installed; set at startup. */
  tools?: ToolStatus[];
}

export interface VerbContext {
  /** The work item the caller is running for, when there is one. */
  workItemId?: string;
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
