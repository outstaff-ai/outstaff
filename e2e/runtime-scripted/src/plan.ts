import type { ItemContext } from "./prompt.js";
import type { Action, Script } from "./scripts.js";

type Message = NonNullable<ItemContext["conversation"]>[number];

/** The milestone and the tickets the PM proposes when a human asks her in chat to re-plan. */
export const PLAN_MILESTONE = "Checkout cleanup";
export const PLAN_TICKETS = ["Split the cart totals", "Show the order summary"];

const PROPOSAL = /^Proposal: milestone "(.+?)" with (.+)\. Shall I file it\?$/m;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The prompt does not say ${what}.`);
  }

  return value;
}

/** The proposal, as the PM's last message in the thread: the milestone and its tickets in order. */
const proposed = (talk: Message[]) => {
  const said = PROPOSAL.exec(talk.findLast((m) => m.agent)?.text ?? "");
  return said
    ? { milestone: said[1]!, tickets: [...said[2]!.matchAll(/"(.+?)"/g)].map((m) => m[1]!) }
    : undefined;
};

/**
 * Files a confirmed plan: the milestone, then each ticket in it, for the PM herself, ready, as the human confirmed it
 * for now. The agent acknowledges all of it in one reply when the session ends.
 */
async function* fileConfirmed(plan: {
  milestone: string;
  tickets: string[];
}): AsyncGenerator<Action, string, string> {
  const made = yield { type: "tool", tool: "milestone_create", input: { title: plan.milestone } };
  const id = need(/^Created milestone (\S+?)\./m.exec(made)?.[1], "the new milestone");
  for (const title of plan.tickets) {
    yield {
      type: "tool",
      tool: "ticket_create",
      input: {
        title,
        body: `Part of the ${plan.milestone} plan.`,
        milestone: id,
        assignee: "me",
        status: "ready",
      },
    };
  }

  return `Filed the plan in milestone ${plan.milestone}.`;
}

/**
 * A request to re-plan is answered with a proposal and nothing filed; the human's confirmation in the thread files it.
 * Undefined for any other message.
 */
export async function* planInChat(
  talk: Message[],
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const plan = proposed(talk);
  if (plan && /^(yes|confirmed)\b/i.test(latest)) {
    return yield* fileConfirmed(plan);
  }

  if (!/better planning/i.test(latest)) {
    return undefined;
  }

  yield { type: "tool", tool: "milestone_list", input: {} };
  const tickets = PLAN_TICKETS.map((t) => `"${t}"`).join(" and ");
  return `Proposal: milestone "${PLAN_MILESTONE}" with ${tickets}. Shall I file it?`;
}

/**
 * A human asks in chat to start the next milestone: that is its confirmation, so the session starts the first planned
 * one in the roadmap's order itself and says so, instead of asking the human to set it in the tracker. Undefined for
 * any other message.
 */
export async function* startNextMilestone(
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  if (!/^start the next milestone\b/i.test(latest.trim())) {
    return undefined;
  }

  const listed = yield { type: "tool", tool: "milestone_list", input: { status: ["planned"] } };
  const next = /^- (\S+) \[planned\] (.+?):/m.exec(listed);
  if (!next) {
    return "There is no planned milestone to start.";
  }

  const [, id, title] = next;
  yield { type: "tool", tool: "milestone_status", input: { id, to: "active" } };
  return `Started ${title} (${id}).`;
}

/**
 * The PM's round on tickets she filed for herself from a confirmed plan: one round for all of them. Confirmed for now,
 * they are filed ready, so the office queues them as her work; she hands them to the requester to review.
 */
export async function* plannedTickets(ctx: ItemContext, key: string): Script {
  const also = [...ctx.journal.matchAll(/also filed (\S+)/g)].map((m) => m[1]!);
  for (const ticket of [key, ...also]) {
    yield { type: "tool", tool: "ticket_move", input: { key: ticket, to: "review" } };
  }

  return `Planned ${[key, ...also].join(", ")} in their milestone, for your review.`;
}

/**
 * A request for later in chat (`file a backlog ticket for <what>`): the ticket is filed in the backlog and nothing
 * more; the reply says so. Undefined for any other message.
 */
export async function* fileForLater(
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const what = /^file a backlog ticket for (.+?)\.?$/i.exec(latest.trim())?.[1];
  if (!what) {
    return undefined;
  }

  const filed = yield {
    type: "tool",
    tool: "ticket_create",
    input: { title: what, body: "Asked in chat, for later.", status: "backlog" },
  };

  const key = /^Created (\S+?)\./m.exec(filed)?.[1] ?? "the ticket";
  return `Filed ${key} in the backlog for later: nothing starts it until you move it on.`;
}
