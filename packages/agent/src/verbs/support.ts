import {
  PortError,
  parseRepoUrl,
  type Knowledge,
  type PortName,
  type RepoRef,
  type Tracker,
  type Vcs,
} from "@outstaff/core";
import type { Filed, OfficeClient } from "./office.js";
import type { AgentEnv } from "./types.js";

function need<T>(env: AgentEnv, port: PortName, impl: T | undefined, label: string): T {
  if (impl !== undefined) {
    return impl;
  }

  const reason = env.unavailable?.[port];
  throw new PortError("unsupported", reason ?? `no ${label} configured for this team`);
}

export const requireTracker = (env: AgentEnv): Tracker =>
  need(env, "tracker", env.tracker, "tracker");

export const requireKnowledge = (env: AgentEnv): Knowledge =>
  need(env, "knowledge", env.knowledge, "knowledge base");

export const requireVcs = (env: AgentEnv): Vcs => need(env, "vcs", env.vcs, "code host");

export function requireOffice(env: AgentEnv): OfficeClient {
  if (!env.office) {
    throw new PortError("unavailable", "not connected to an office");
  }

  return env.office;
}

/** What a chat session is told after it filed work. The agent posts the reply and any placement question itself. */
export const filedLine = (f: Filed) =>
  f.waiting
    ? `Filed as work item ${f.item.id}. You are busy, so it waits last; your agent asks the requester where it goes. Finish with a short note.`
    : `Filed as work item ${f.item.id}. It starts now. Finish with a short note.`;

const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** A repo of the team by its name in team.yaml, or by `host/owner/name`; anything else is refused. */
export function resolveRepo(env: AgentEnv, ref: string): Required<RepoRef> {
  const byName = env.team.repos.find((r) => r.name === ref);
  if (byName) {
    return parseRepoUrl(byName.url);
  }

  let parsed: Required<RepoRef> | undefined;
  try {
    parsed = parseRepoUrl(ref);
  } catch {
    parsed = undefined;
  }

  const known = parsed
    ? env.team.repos.map((r) => parseRepoUrl(r.url)).find((r) => sameRepo(r, parsed))
    : undefined;

  if (!known) {
    const names = env.team.repos.map((r) => r.name).join(", ");
    throw new PortError("not_found", `"${ref}" is not a repository of this team (${names}).`);
  }

  return known;
}

export const repoLabel = (r: RepoRef) => `${r.owner}/${r.name}`;
