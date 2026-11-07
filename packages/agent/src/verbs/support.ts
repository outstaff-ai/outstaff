import {
  PortError,
  createTicketLinker,
  parseRepoUrl,
  type Knowledge,
  type PortName,
  type RepoRef,
  type TicketLinker,
  type Tracker,
  type Vcs,
} from "@outstaff/core";
import type { Filed, OfficeClient } from "./office.types.js";
import type { AgentEnv, Round } from "./types.js";

/** The one formatter outgoing text goes through: ticket keys linked, links on the tracker's or knowledge host guarded. */
export function ticketLinker(env: AgentEnv): TicketLinker {
  return createTicketLinker(env.team, env.tracker, {
    knowledge: env.knowledge,
    flag: (message) => env.log?.warn(message),
  });
}

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

/** What started the round when another agent did: a teammate's question (`ost ask`), an unblock, an agent's mention. */
function startedByAgent(round: Round): string | undefined {
  switch (round.kind) {
    case "question":
      return "a teammate's question";
    case "unblock":
      return "an unblock, started by a teammate's blocked hand-back";
    case "reconcile":
      return "the office's sweep of the board";
    case "asked":
      return round.trigger === "human" ? undefined : "a teammate's mention";
    default:
      return undefined;
  }
}

/**
 * A round on a ticket in backlog, other than a chat session: the ticket is planned for later, not started. Work a chat
 * session attached or filed comes without the ticket's status, as a human asked for it.
 */
const onBacklog = (round: Round) => round.ticketStatus === "backlog" && round.kind !== "chat";

/**
 * Only a trusted human starts new work. A round another agent started (a question, an unblock, an agent's mention)
 * may answer, comment, route existing work and hand back, but files no ticket and opens no pull request; it puts the
 * proposal to a trusted human instead. So does a round on a ticket in backlog (a comment or a mention on it): the work
 * starts when a human moves the ticket on, or asks for it in chat. Other rounds a human started, and work on an
 * assigned ticket, are not limited.
 */
export function requireHumanStarted(env: AgentEnv, what: "file a ticket" | "open a pull request") {
  const round = env.round;
  const from = round && startedByAgent(round);
  if (from) {
    throw new PortError(
      "forbidden",
      `This round is ${from}, not a trusted human's request, so it does not ${what}: only a trusted human starts new work, and a teammate's question, mention or approval is not their confirmation. Put the proposal to a trusted human instead: comment it on the ticket (what, why, and your recommendation), or, answering a question, suggest it in your answer for the asker to take to a human; then hand back.`,
    );
  }

  if (round && onBacklog(round)) {
    throw new PortError(
      "forbidden",
      `This round is on a ticket in backlog, so it does not ${what}: backlog is work planned for later, and it starts only when a trusted human moves the ticket to ready or active, or asks for the work in chat. Answer the comment or update the ticket instead (its description, its plan, a proposal), then hand back. Backlog is not a blocker: hand back silent, or with the answer, never blocked.`,
    );
  }
}

/** What a chat session is told after it filed work. The agent posts the reply, and where the work went, itself. */
export const filedLine = (f: Filed) =>
  f.work.length > 0
    ? `Filed as work item ${f.item.id}. You are busy, so it runs next, after the work running now; your agent tells the requester, who may move it. Finish with a short note.`
    : `Filed as work item ${f.item.id}. It starts now. Finish with a short note.`;

const sameRepo = (a: RepoRef, b: RepoRef) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** A repo of the team by its name in team.yaml, by `owner/name` (how `ost work` shows a pull request) or by `host/owner/name`; anything else is refused. */
export function resolveRepo(env: AgentEnv, ref: string): Required<RepoRef> {
  const byName = env.team.repos.find((r) => r.name === ref);
  if (byName) {
    return parseRepoUrl(byName.url);
  }

  const short = /^([^/\s]+)\/([^/\s]+)$/.exec(ref);
  const named = short
    ? env.team.repos
        .map((r) => parseRepoUrl(r.url))
        .find((r) => sameRepo(r, { owner: short[1]!, name: short[2]! }))
    : undefined;

  if (named) {
    return named;
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
