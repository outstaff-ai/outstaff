import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";

const FINISHED = new Set(["done", "canceled"]);

/**
 * The agents who may go on with the parent: the closed sub-ticket's (the one it is assigned to, its author once merged,
 * else who last worked on it), then the parent's own.
 */
function candidates(ctx: PolicyContext, parent: string): string[] {
  const own = ctx.person(["assignee", "last_worker"]);
  const holder = ctx.state.assignee(parent);
  return [
    ...("skip" in own ? [] : [own.value]),
    ...(holder?.kind === "agent" && ctx.options.people.includes(holder.id) ? [holder.id] : []),
  ];
}

/**
 * Whether the agent has another unfinished sub-ticket of the parent. One in the backlog counts here: a sibling the
 * closed ticket blocked may still wait there until its unblocking moves it to ready.
 */
const hasMore = (ctx: PolicyContext, parent: string, agent: string) =>
  ctx.state
    .subTickets(parent)
    .some(
      (t) =>
        t !== ctx.ticket &&
        !FINISHED.has(ctx.state.ticketStatus(t) ?? "done") &&
        ctx.state.assignee(t)?.id === agent,
    );

export const policy = definePolicy({
  id: "subticket_closed_to_agent",
  summary:
    "A sub-ticket closing wakes an agent on the parent ticket when the parent is open and that agent has more unfinished sub-tickets of it: the closed sub-ticket's agent, else the parent's. The agent planned their order when it split the parent, and picks the next one.",
  on: ["ticket.closed"],
  when: {
    all: [
      { ticket_status: ["done", "canceled"] },
      { parent_status: ["backlog", "ready", "active", "review", "blocked"] },
    ],
  },
  instruction:
    "{{ticket}} was {{closed}}. The open sub-tickets of {{parent}}: {{parent.open}}. Continue with the next one in the order you planned, the way the repository asks. When none is for you to do now and each waits on a human's review or on work someone else has under way, you are waiting, not blocked: hand back silent, with no new message. When one waits on an answer or a decision (it is blocked, or nobody answered a question on it yet), hand back blocked, naming who and what.",
  decides:
    "wake `assignee`, else `last_worker`, else the parent's agent (kind `assigned`) on the ticket's parent, the first of them with more unfinished sub-tickets of the parent",
  decide(_event, ctx): Proposal[] {
    const parent = ctx.state.parentOf(ctx.ticket!)!;
    const agent = candidates(ctx, parent).find((a) => hasMore(ctx, parent, a));
    if (!agent) {
      return [
        {
          type: "drop",
          reason: `no agent has another unfinished sub-ticket of ${parent}`,
        },
      ];
    }

    const instruction = ctx.render(ctx.instruction!, { person: agent });
    return "skip" in instruction
      ? [{ type: "drop", reason: `the instruction cannot be rendered: ${instruction.skip}` }]
      : [
          {
            type: "wake",
            person: agent,
            kind: "assigned",
            instruction: instruction.value,
            subject: { type: "ticket", ref: parent },
            reason: `${agent} has more sub-tickets of ${parent}`,
          },
        ];
  },
});
