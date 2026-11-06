import { CANONICAL_STATUSES, PortError, type Tracker } from "@outstaff/core";
import { z } from "zod";
import { requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key, summary } from "./ticket-support.js";
import type { AgentEnv, VerbContext } from "./types.js";

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toUpperCase() === b.toUpperCase();

/** The ticket of the round the caller runs in; none for a chat session or a round without one. */
async function roundTicket(env: AgentEnv, workItemId: string): Promise<string | undefined> {
  const items = await env.office!.work({ workItemId });
  return items.find((i) => i.current)?.ticketKey;
}

/**
 * A move to active is part of working the ticket, which the office starts: it makes the ticket active when a round on
 * it starts. Moved by an agent anywhere else, the ticket would sit in progress with nothing working on it, since the
 * office takes an agent's own move as no request for work. So only a round on the ticket, or on its parent, moves it
 * there; a ticket already active, or a call with no office round, is left alone.
 */
async function checkActiveMove(
  env: AgentEnv,
  tracker: Tracker,
  ticket: string,
  ctx: VerbContext,
): Promise<void> {
  if (!ctx.workItemId || !env.office) {
    return;
  }

  const issue = await tracker.getIssue(ticket);
  const round =
    issue.status.canonical === "active" ? issue.key : await roundTicket(env, ctx.workItemId);

  if (same(round, issue.key) || same(round, issue.parent)) {
    return;
  }

  throw new PortError(
    "invalid",
    `Moving ${issue.key} to active starts no work: the office makes a ticket active when a round on it starts, and nothing would pick it up. To continue it from a chat thread, run ost work attach ${issue.key} --confirmed. If that fails, tell the requester in the thread what it said and leave the ticket where it is.`,
  );
}

export const ticketMove = defineVerb({
  name: "ticket.move",
  summary: "Move a ticket to another status.",
  description:
    "Moves a ticket to a canonical status (backlog, ready, active, review, blocked, done, canceled). The tracker's own status names are mapped by the team's workflow settings. Only a round on the ticket (or on its parent) moves it to active, since that move starts no work: to continue a ticket from chat, attach the request with ost work attach.",
  input: z.strictObject({
    key,
    to: z
      .enum(CANONICAL_STATUSES as [string, ...string[]])
      .describe("Canonical status to move to."),
  }),
  args: ["key", "to"],
  examples: ["ost ticket move ACME-12 review"],
  async run(env, input, ctx) {
    const tracker = requireTracker(env);
    if (input.to === "active") {
      await checkActiveMove(env, tracker, input.key, ctx);
    }

    const issue = await tracker.transition(
      input.key,
      input.to as (typeof CANONICAL_STATUSES)[number],
    );

    const url = tracker.links.issue(issue.key);
    return result(
      [`Moved ${issue.key} to ${issue.status.name}.`, ...summary(issue, url)],
      { issue },
      [url],
    );
  },
});
