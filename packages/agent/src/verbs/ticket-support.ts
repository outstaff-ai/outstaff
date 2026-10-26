import { PortError, type Issue, type Member, type Tracker } from "@outstaff/core";
import { z } from "zod";
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
