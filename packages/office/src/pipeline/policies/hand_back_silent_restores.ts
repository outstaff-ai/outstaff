import type { ActTarget, CanonicalStatus } from "@outstaff/core";
import {
  definePolicy,
  type PipelineEvent,
  type PolicyContext,
  type Proposal,
} from "@outstaff/policy";
import { NOT_CLOSED } from "./conditions.js";
import { HANDED_IN, withHandedIn } from "./hand-in.js";
import { requesterOf } from "./handover.js";

/** The ticket as the round found it, recorded when it started (`data.before` of the hand-back). */
interface Before {
  status?: CanonicalStatus | undefined;
  assignee?: ActTarget | undefined;
}

const beforeOf = (event: PipelineEvent): Before | undefined =>
  (event.data["before"] ?? undefined) as Before | undefined;

const STARTED_AS = "active";

type RestoreOp =
  | { op: "move"; ticket: string; to: CanonicalStatus }
  | { op: "assign"; ticket: string; to: ActTarget | null };

/** The status back, when the round's start moved the ticket to active and it is still there. */
const statusBack = (ticket: string, before: Before, now: string | undefined): RestoreOp[] =>
  before.status && before.status !== STARTED_AS && now === STARTED_AS
    ? [{ op: "move", ticket, to: before.status }]
    : [];

/** The assignee back, when the round's start gave the ticket to the agent and it still has it. */
const assigneeBack = (ticket: string, before: Before, agent: string, now: string | undefined) =>
  before.assignee?.id !== agent && now === agent
    ? [{ op: "assign" as const, ticket, to: before.assignee ?? null }]
    : [];

const inFlightOf = (event: PipelineEvent): string[] => {
  const waiting = event.data["waitingOn"];
  return Array.isArray(waiting) ? waiting.filter((w): w is string => typeof w === "string") : [];
};

/** A blocked hand-back the office took as silent: the work in flight it waits on, which is why, as the trace says. */
function waitingOn(event: PipelineEvent): string | undefined {
  const waiting = inFlightOf(event);
  return waiting.length > 0
    ? `handed back blocked, but it waits on work in flight (${waiting.join("; ")}), which is not blocked`
    : undefined;
}

/** Why nothing is restored: the work in flight it waits on, and what is left as it is. */
const nothingLeft = (
  event: PipelineEvent,
  ticket: string,
  stays: string | undefined,
): Proposal => ({
  type: "drop",
  reason: [
    waitingOn(event),
    stays ?? `nothing the round's start changed on ${ticket} is left to restore`,
  ]
    .filter(Boolean)
    .join(": "),
});

/**
 * Whether the ticket stays active: the round found it ready, and it waits on work in flight. Under way, back in ready
 * the idle pull would only start it again.
 */
const staysActive = (event: PipelineEvent, before: Before, now: string | undefined) =>
  inFlightOf(event).length > 0 && before.status === "ready" && now === STARTED_AS;

/** What puts the item's ticket back as the round found it, or a drop that says why nothing does. */
function restore(event: PipelineEvent, ctx: PolicyContext): Proposal[] {
  const ticket = ctx.ticket;
  const before = beforeOf(event);
  if (!ticket || !before) {
    return [{ type: "drop", reason: "the round's start recorded no ticket to restore" }];
  }

  const agent = event.actor.id;
  const now = ctx.state.ticketStatus(ticket);
  const kept = staysActive(event, before, now);
  const ops = [
    ...(kept ? [] : statusBack(ticket, before, now)),
    ...assigneeBack(ticket, before, agent, ctx.state.assignee(ticket)?.id),
  ];

  const stays = kept
    ? `${ticket} stays active, not back in ready, as it waits on work in flight`
    : undefined;

  if (!ops.length) {
    return [nothingLeft(event, ticket, stays)];
  }

  const back = `${waitingOn(event) ?? "the round finished silently"}: ${ticket} goes back to how the round found it`;
  return [{ type: "act", as: agent, ops, reason: [back, stays].filter(Boolean).join("; ") }];
}

export const policy = definePolicy({
  id: "hand_back_silent_restores",
  summary:
    "A silent hand-back leaves the ticket as it was before the round: what the round's start changed (the move to active, the assignment to the agent) is undone, for the agent. A field someone changed since is left alone, and so is a parent the agent kept active for its open sub-tickets. A ticket the round found ready that waits on work in flight stays active: back in ready, the idle pull would only start it again. The work item's other tickets awaiting review go to review and to the requester too. A blocked hand-back the office found waiting on work in flight (the ticket's pull requests open for review, its sub-tickets in review or with an agent) comes as silent, and its trace names that work: no PM is woken, and no human is told again.",
  on: ["agent.handed_back"],
  when: { all: [{ hand_back_status: ["silent"] }, NOT_CLOSED] },
  decides: `act for the agent: move the ticket back to the status it had before the round, and assign it back to whom it had, for each of the two still as the round's start set it; ${HANDED_IN}`,
  decide: (event, ctx): Proposal[] => withHandedIn(ctx, restore(event, ctx), requesterOf(ctx)),
});
