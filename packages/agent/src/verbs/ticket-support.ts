import { PortError, type Issue, type Member, type Tracker } from "@outstaff/core";
import { z } from "zod";
import { requireOffice } from "./support.js";
import type { ResolvedAssignee } from "./ticket-create.types.js";
import type { AgentEnv } from "./types.js";

export const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Not a ticket key.")
  .describe("Ticket key, for example ACME-12.");

export const who = (m?: Member) =>
  m ? `${m.name}${m.username ? ` (@${m.username})` : ""}` : "nobody";

export const summary = (issue: Issue, url: string) => [
  `${issue.key}: ${issue.title}`,
  `Status: ${issue.status.name}${issue.status.canonical ? ` (${issue.status.canonical})` : ""}`,
  `Assignee: ${who(issue.assignee)}`,
  ...(issue.labels.length ? [`Labels: ${issue.labels.join(", ")}`] : []),
  url,
];

/** The tracker member a name, username or id names; "me" is the caller. */
export async function memberFor(env: AgentEnv, tracker: Tracker, to: string): Promise<Member> {
  const wanted = (to.toLowerCase() === "me" ? env.person : to).toLowerCase();
  const members = await tracker.members();
  const hit =
    members.find((m) => m.id.toLowerCase() === wanted) ??
    members.find((m) => m.username?.toLowerCase() === wanted) ??
    members.find((m) => m.name.toLowerCase() === wanted);

  if (!hit) {
    throw new PortError("not_found", `No tracker member matches "${to}".`);
  }

  return hit;
}

/** The prefix of an assignee that names a role rather than a person: `role:developer`. */
export const ROLE_PREFIX = "role:";

/** The teammate's tracker member: by the tracker identity team.yaml gives them, else by their handle. */
export async function teammateOnTracker(
  env: AgentEnv,
  tracker: Tracker,
  handle: string,
): Promise<Member> {
  const identity = env.team.people.find((p) => p.handle === handle)?.identities?.tracker;
  if (!identity) {
    return memberFor(env, tracker, handle);
  }

  const hit = (await tracker.members()).find((m) => m.id === identity || m.username === identity);
  if (!hit) {
    throw new PortError(
      "not_found",
      `No tracker member matches ${handle}'s tracker identity "${identity}".`,
    );
  }

  return hit;
}

/**
 * The member an assignee names. `role:<role>` goes to the person the office routes the role to, as `ost ask` routes a
 * question: the least busy person with it, never the caller for its own role; a role nobody has is refused. Anything
 * else is a member's username, name or id, or "me".
 */
export async function resolveAssignee(
  env: AgentEnv,
  tracker: Tracker,
  to: string,
): Promise<ResolvedAssignee> {
  if (!to.toLowerCase().startsWith(ROLE_PREFIX)) {
    return { member: await memberFor(env, tracker, to) };
  }

  const name = to.slice(ROLE_PREFIX.length).trim().toLowerCase();
  if (!name) {
    throw new PortError("invalid", 'Name the role after "role:", for example role:developer.');
  }

  const handle = await requireOffice(env).resolveRole(name);
  return { member: await teammateOnTracker(env, tracker, handle), role: { name, handle } };
}

/** The line that says who a role went to; none for an assignee named directly. */
export const roleLine = (to: Pick<ResolvedAssignee, "role"> | undefined): string[] =>
  to?.role ? [`Role ${to.role.name} went to ${to.role.handle}.`] : [];
