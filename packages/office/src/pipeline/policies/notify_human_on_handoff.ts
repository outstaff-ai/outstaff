import type { WorkflowPr } from "@outstaff/core";
import {
  definePolicy,
  type NoticePr,
  type NoticeSeen,
  type PolicyContext,
  type Proposal,
} from "@outstaff/policy";
import { handedIn } from "./hand-in.js";
import { handedOver, requesterOf } from "./handover.js";

const drop = (reason: string): Proposal[] => [{ type: "drop", reason }];

const noticePr = (pr: WorkflowPr): NoticePr => ({
  ref: `${pr.ref.repo.owner}/${pr.ref.repo.name}#${pr.ref.number}`,
  ...(pr.url ? { url: pr.url } : {}),
  title: pr.title,
});

const openForReview = (ctx: PolicyContext, ticket: string) =>
  ctx.state.pullRequestsOf(ticket).filter((p) => p.state === "open" && !p.draft);

/** The ticket's pull requests open for review, to link in the message. */
const reviewPrs = (ctx: PolicyContext, ticket: string) => openForReview(ctx, ticket).map(noticePr);

/** What a notice about the ticket puts in front of the human: the head of each pull request open for review. */
const seenOf = (ctx: PolicyContext, ticket: string, human: string): NoticeSeen => ({
  human,
  prs: Object.fromEntries(openForReview(ctx, ticket).map((p) => [noticePr(p).ref, p.head ?? ""])),
});

/**
 * Whether the round's own result goes to a chat thread with the human: the hand-back names the chat members whose
 * threads the item came from or was attached from, where the chat desk posts its result.
 */
function inThread(ctx: PolicyContext, human: string): boolean {
  const members = ctx.event.data["chat"];
  const chat = ctx.options.humans?.find(
    (h) => h.identities.tracker === human || h.identities.vcs === human || h.name === human,
  )?.identities.chat;

  return Array.isArray(members) && chat !== undefined && members.includes(chat);
}

const sameHolder = (holder: unknown, human: string) =>
  typeof holder === "object" &&
  holder !== null &&
  (holder as { status?: unknown }).status === "review" &&
  (holder as { assignee?: { id?: unknown } }).assignee?.id === human;

/**
 * Why a hand-back puts nothing new in front of the human, decided from the state, not from the agent's words: the round
 * found the ticket in review with them already, and no pull request is open for review with a head they were not told
 * of (`data.notified`, the last notice about the ticket). A merge round on a merged pull request, or a rebase that
 * pushed nothing, is such a round. Undefined when there is something new.
 */
function nothingNew(ctx: PolicyContext, ticket: string, seen: NoticeSeen): string | undefined {
  if (!sameHolder(ctx.event.data["before"], seen.human)) {
    return undefined;
  }

  const heads = Object.entries(seen.prs);
  if (heads.length === 0) {
    return `${ticket} was in review with ${seen.human} already, and no pull request of it is open for review`;
  }

  const notified = ctx.event.data["notified"] as NoticeSeen | undefined;
  const told = notified?.human === seen.human ? notified.prs : undefined;
  return told && heads.every(([ref, head]) => told[ref] === head)
    ? `${ticket} was in review with ${seen.human} already, with the pull request heads they were told of`
    : undefined;
}

/** The human a hand-back as done gives the ticket to: the requester, or the human the agent handed it over to. */
function handedTo(ctx: PolicyContext, ticket: string): string | undefined {
  if (handedOver(ctx, requesterOf(ctx)).length === 0) {
    return requesterOf(ctx);
  }

  const assignee = ctx.state.assignee(ticket);
  return assignee?.kind === "human" ? assignee.id : undefined;
}

const said = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);

/** The words the notice leads with: the agent's message for the human, else its summary; none when both are empty. */
function wordsOf(ctx: PolicyContext): { text?: string } {
  const text = said(ctx.event.data["message"]) ?? said(ctx.event.data["summary"]);
  return text ? { text } : {};
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

  // The round posts its result in a chat thread with the human: nothing more.
  const told = inThread(ctx, human);
  const seen = seenOf(ctx, ticket, human);
  const stale = told ? undefined : nothingNew(ctx, ticket, seen);
  const where = told ? ", in the chat thread the round reports to" : "";
  return [
    stale
      ? { type: "drop", reason: `nothing new for ${human}: ${stale}` }
      : {
          type: "notify",
          as: ctx.event.actor.id,
          human,
          need: "review",
          ticket,
          prs: reviewPrs(ctx, ticket),
          ...wordsOf(ctx),
          ...(told ? { told } : {}),
          seen,
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

  const told = inThread(ctx, human);
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
    "When work lands on a human, the agent tells them in chat: its own message from the hand-back first (its summary when it gave none), then what is needed, with the pull request links and the ticket they are for: a hand-back as done that gives the ticket to them, listing every ticket it gives them (the item's sub-tickets in review and the tickets of the pull requests it opened too), a ticket in review or blocked that an agent gives to them (a PM that cannot unblock it, for example), or an agent's pull request opened for review, for the requester of its ticket. It is a direct message, or a reply in the chat thread of the agent with that human the ticket's work is tied to (work filed or attached from chat, and its later rounds). Nothing more is sent for a round that posts its own result in a chat thread with that human, nor for a round that put nothing new in front of them: it found the ticket in review with them and left no pull request open for review with a head they were not told of, such as a merge round on a merged pull request or a rebase that pushed nothing. The office batches one agent's messages to one human.",
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
    "notify the human in chat (a direct message, or a reply in the chat thread with them the ticket's work is tied to), as the agent: the requester on a hand-back as done (or the human the agent handed the ticket over to; nothing more when the round posts its own result in a chat thread with that human; nothing at all when the round found the ticket in review with them and left no pull request open for review with a head the last notice did not name), with every other ticket of the item the hand-back gives the requester for review, the assignee when an agent gives a ticket in review or blocked to a human (not the echo of an office act, nor the agent blocked on it), the requester of the ticket of an agent's pull request opened for review; on `policies.notify_handoff`",
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
