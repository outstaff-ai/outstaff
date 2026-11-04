import type { WorkflowPr } from "@outstaff/core";
import { definePolicy, type NoticePr, type PolicyContext, type Proposal } from "@outstaff/policy";
import { handedIn } from "./hand-in.js";
import { handedOver, requesterOf } from "./handover.js";

const drop = (reason: string): Proposal[] => [{ type: "drop", reason }];

const noticePr = (pr: WorkflowPr): NoticePr => ({
  ref: `${pr.ref.repo.owner}/${pr.ref.repo.name}#${pr.ref.number}`,
  ...(pr.url ? { url: pr.url } : {}),
  title: pr.title,
});

/** The ticket's pull requests open for review, to link in the message. */
const reviewPrs = (ctx: PolicyContext, ticket: string) =>
  ctx.state
    .pullRequestsOf(ticket)
    .filter((p) => p.state === "open" && !p.draft)
    .map(noticePr);

/** The human a hand-back as done gives the ticket to: the requester, or the human the agent handed it over to. */
function handedTo(ctx: PolicyContext, ticket: string): string | undefined {
  if (handedOver(ctx, requesterOf(ctx)).length === 0) {
    return requesterOf(ctx);
  }

  const assignee = ctx.state.assignee(ticket);
  return assignee?.kind === "human" ? assignee.id : undefined;
}

/** The hand-back's summary, as the message's words: none when it is empty. */
function summaryOf(ctx: PolicyContext): { text?: string } {
  const summary = ctx.event.data["summary"];
  return typeof summary === "string" && summary.trim() ? { text: summary } : {};
}

/**
 * A hand-back as done gives the ticket to the requester (`hand_back_done`), or leaves it with the human the agent
 * handed it over to. A blocked hand-back goes to the PM, or the blocked agent tells the requester itself.
 */
function handBack(ctx: PolicyContext): Proposal[] {
  const ticket = ctx.ticket as string;
  if (ctx.event.data["status"] !== "done" || ctx.state.ticketStatus(ticket) === "blocked") {
    return drop(
      "only a hand-back as done gives the ticket to a human: a blocked one goes to the PM, or the blocked agent tells the requester itself (hand_back.blocked_notify)",
    );
  }

  const human = handedTo(ctx, ticket);
  if (!human) {
    return drop(
      `${ticket} goes to no human: it has no requester, or it was handed over to an agent`,
    );
  }

  // The chat thread the work came from gets the result, which tells the requester.
  const told = ctx.event.data["chat"] === true && human === requesterOf(ctx);
  const where = told ? ", in the chat thread the work came from" : "";
  return [
    {
      type: "notify",
      as: ctx.event.actor.id,
      human,
      need: "review",
      ticket,
      prs: reviewPrs(ctx, ticket),
      ...summaryOf(ctx),
      ...(told ? { told } : {}),
      reason: `${ctx.event.actor.id} handed ${ticket} back to ${human} for review${where}`,
    },
    ...handedInNotices(ctx),
  ];
}

/**
 * The item's other tickets the hand-back gives to the requester for review (`hand_back_done`): its sub-tickets in
 * review and the tickets of the pull requests it opened, one notice each, so the message lists them all.
 */
function handedInNotices(ctx: PolicyContext): Proposal[] {
  const human = requesterOf(ctx);
  if (!human) {
    return [];
  }

  const told = ctx.event.data["chat"] === true;
  return handedIn(ctx, human).map((key): Proposal => ({
    type: "notify",
    as: ctx.event.actor.id,
    human,
    need: "review",
    ticket: key,
    prs: reviewPrs(ctx, key),
    ...(told ? { told } : {}),
    reason: `${ctx.event.actor.id}'s hand-back of ${ctx.ticket} gave ${key} to ${human} for review`,
  }));
}

/** An agent gave a ticket in review or blocked to a human itself: a PM that cannot unblock it, for example. */
function assigned(ctx: PolicyContext): Proposal[] {
  const ticket = ctx.ticket as string;
  if (typeof ctx.event.data["echo"] === "string") {
    return drop("the echo of an office act: the event that caused it tells the human");
  }

  const assignee = ctx.state.assignee(ticket);
  const status = ctx.state.ticketStatus(ticket);
  if (assignee?.kind !== "human" || (status !== "review" && status !== "blocked")) {
    return drop(`${ticket} is not with a human in review or blocked`);
  }

  // The tracker may report the blocked agent's own hand-back assignment after a later one (the PM's), so the state no
  // longer shows it as the act's echo. Its hand-back decided who is told: the PM, or its own blocked report.
  if (status === "blocked" && ctx.state.blockedAgent(ticket) === ctx.event.actor.id) {
    return drop(`${ctx.event.actor.id} is blocked on ${ticket}: its hand-back decides who is told`);
  }

  return [
    {
      type: "notify",
      as: ctx.event.actor.id,
      human: assignee.id,
      need: status,
      ticket,
      prs: reviewPrs(ctx, ticket),
      reason: `${ctx.event.actor.id} gave ${ticket} (${status}) to ${assignee.id}`,
    },
  ];
}

/** An agent's pull request opened for review waits for the requester of its ticket. */
function opened(ctx: PolicyContext): Proposal[] {
  const author = ctx.person("author");
  const human = requesterOf(ctx);
  if ("skip" in author || !ctx.pr || !human) {
    return drop("no agent's pull request with a human to review it");
  }

  return [
    {
      type: "notify",
      as: author.value,
      human,
      need: "review",
      ...(ctx.ticket ? { ticket: ctx.ticket } : {}),
      prs: [noticePr(ctx.pr)],
      reason: `${author.value} opened ${noticePr(ctx.pr).ref} for ${human} to review`,
    },
  ];
}

export const policy = definePolicy({
  id: "notify_human_on_handoff",
  summary:
    "When work lands on a human, the agent tells them in a direct message in chat, with the ticket and pull request links and what is needed: a hand-back as done that gives the ticket to them, listing every ticket it gives them (the item's sub-tickets in review and the tickets of the pull requests it opened too), a ticket in review or blocked that an agent gives to them (a PM that cannot unblock it, for example), or an agent's pull request opened for review, for the requester of its ticket. The office batches one agent's messages to one human.",
  on: ["agent.handed_back", "ticket.assigned", "pr.opened"],
  when: {
    any: [
      {
        all: [
          { hand_back_status: ["done"] },
          { not: { ticket_status: ["blocked", "done", "canceled"] } },
        ],
      },
      {
        all: [
          { actor_kind: "agent" },
          { assignee_kind: "human" },
          { ticket_status: ["review", "blocked"] },
        ],
      },
      { all: [{ pr_author_kind: "agent" }, { not: { pr_draft: true } }] },
    ],
  },
  decides:
    "notify the human in chat, as the agent: the requester on a hand-back as done (or the human the agent handed the ticket over to; nothing more when the work came from a chat thread, which gets the result), with every other ticket of the item the hand-back gives the requester for review, the assignee when an agent gives a ticket in review or blocked to a human (not the echo of an office act, nor the agent blocked on it), the requester of the ticket of an agent's pull request opened for review; on `policies.notify_handoff`",
  decide(event, ctx) {
    if (event.type === "pr.opened") {
      return opened(ctx);
    }

    if (!ctx.ticket || event.actor.kind !== "agent") {
      return drop("no agent's change on a ticket");
    }

    return event.type === "agent.handed_back" ? handBack(ctx) : assigned(ctx);
  },
});
