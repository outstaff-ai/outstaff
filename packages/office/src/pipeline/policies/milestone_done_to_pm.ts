import { definePolicy, type PolicyContext, type Proposal } from "@outstaff/policy";
import { UNFINISHED } from "./conditions.js";

const OPEN: ReadonlySet<string | undefined> = new Set(UNFINISHED);

/** The milestone's other tickets the office knows that are not finished; one in the backlog is still work in it. */
const stillOpen = (ctx: PolicyContext, initiative: string) =>
  ctx.state
    .initiativeTickets(initiative)
    .filter((t) => t !== ctx.ticket && OPEN.has(ctx.state.ticketStatus(t)));

export const policy = definePolicy({
  id: "milestone_done_to_pm",
  summary:
    "The last unfinished ticket of a milestone (a tracker initiative) closing wakes the team's PM, to close the milestone, propose the next one and ask a trusted human to confirm it. The office counts the milestone's tickets it knows; the PM checks the milestone in the tracker first.",
  on: ["ticket.closed"],
  when: { all: [{ ticket_status: ["done", "canceled"] }, { in_milestone: true }] },
  instruction:
    '{{ticket}} was {{closed}}, and it was the last open ticket of milestone "{{milestone}}" ({{milestone.id}}) that the office knows. Check with `ost milestone show {{milestone.id}}` that nothing in it is left. If it is finished, close it (`ost milestone status {{milestone.id}} done`), update the roadmap, propose the next milestone with what it will deliver, and ask a trusted human to confirm it. File its tickets only once they confirm.',
  decides:
    "wake the PM (`role:pm`, kind `milestone`) on the closed ticket, when every other ticket of its milestone the office knows is done or canceled",
  decide(_event, ctx): Proposal[] {
    const milestone = ctx.state.initiativeOf(ctx.ticket!)!;
    const open = stillOpen(ctx, milestone.id);
    if (open.length > 0) {
      return [
        {
          type: "drop",
          reason: `milestone ${milestone.title} still has open tickets: ${open.join(", ")}`,
        },
      ];
    }

    return ctx.wake(
      { person: "role:pm", kind: "milestone" },
      `the last open ticket of milestone ${milestone.title} closed`,
    );
  },
});
