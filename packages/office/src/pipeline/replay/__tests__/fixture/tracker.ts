import type { ReplayScenario, ReplayWorld } from "../../replay.types.js";
import { at, ev, ROLES, ticket } from "./build.js";

const board: ReplayWorld = {
  tickets: {
    "ACME-150": ticket("ready", "sam"),
    "ACME-151": ticket("ready", "sam"),
    "ACME-152": ticket("backlog", "noor"),
    "ACME-153": ticket("ready", "ada.admin"),
    "ACME-154": ticket("review", "ada.admin", { lastWorker: "sam" }),
  },
  roles: ROLES,
};

const working: ReplayWorld = {
  ...board,
  tickets: {
    ...board.tickets,
    "ACME-150": ticket("active", "sam"),
    "ACME-123": ticket("done", "sam"),
  },
};

export const assignments: ReplayScenario = {
  title: "Tickets assigned and moved, by a human and by the agent itself",
  steps: [
    {
      event: ev(
        "s4-assigned-by-human",
        "ticket.assigned",
        "ada.admin",
        { ticket: "ACME-150" },
        at(200),
      ),
      world: board,
    },
    {
      event: ev("s4-self-assigned", "ticket.assigned", "sam", { ticket: "ACME-151" }, at(201)),
      world: board,
    },
    {
      event: ev(
        "s4-created-assigned",
        "ticket.created",
        "ada.admin",
        { ticket: "ACME-152" },
        at(202),
      ),
      world: board,
    },
    {
      event: ev(
        "s4-assigned-to-human",
        "ticket.assigned",
        "ada.admin",
        { ticket: "ACME-153" },
        at(203),
      ),
      world: board,
    },
    {
      event: ev("s4-moved-active", "ticket.moved", "ada.admin", { ticket: "ACME-150" }, at(204), {
        from: "ready",
        to: "active",
      }),
      world: working,
      note: "intended fix: a human moving an agent's ticket to active wakes the agent; today only a ticket a human holds is taken back",
    },
    {
      event: ev("s4-moved-takeback", "ticket.moved", "ada.admin", { ticket: "ACME-154" }, at(205), {
        from: "review",
        to: "active",
      }),
      world: {
        ...working,
        tickets: {
          ...working.tickets,
          "ACME-154": ticket("active", "ada.admin", { lastWorker: "sam" }),
        },
      },
      note: "regression: moving a ticket a human holds to active no longer gives it back to the agent that last worked on it; not in the plan's table",
    },
    {
      event: ev("s4-moved-review", "ticket.moved", "ada.admin", { ticket: "ACME-150" }, at(206), {
        from: "active",
        to: "review",
      }),
      world: { ...working, tickets: { ...working.tickets, "ACME-150": ticket("review", "sam") } },
    },
  ],
};

export const ticketComments: ReplayScenario = {
  title: "Comments on tickets",
  steps: [
    {
      event: ev("s10-comment", "ticket.commented", "ada.admin", { ticket: "ACME-150" }, at(210), {
        body: "The empty state should link to the catalog.",
      }),
      world: working,
    },
    {
      event: ev("s10-mention", "ticket.commented", "ada.admin", { ticket: "ACME-150" }, at(211), {
        body: "@mira can you check the event names first?",
        mentions: ["mira"],
      }),
      world: working,
      note: "regression: a mention wakes mira but no longer hands her the ticket; the plan's table leaves that to the agent",
    },
    {
      event: ev(
        "s10-handed-back-ticket",
        "ticket.commented",
        "ada.admin",
        { ticket: "ACME-154" },
        at(212),
        {
          body: "Still shows the old price after a refresh.",
        },
      ),
      world: working,
      note: "regression: feedback on a ticket the agent handed back to a human no longer goes back to that agent; not in the plan's table",
    },
    {
      event: ev("s10-agent-comment", "ticket.commented", "sam", { ticket: "ACME-150" }, at(213), {
        body: "Started: the catalog link needs the new route.",
      }),
      world: working,
    },
    {
      event: ev(
        "s10-done-ticket",
        "ticket.commented",
        "ada.admin",
        { ticket: "ACME-123" },
        at(214),
        {
          body: "Thanks, works well.",
        },
      ),
      world: working,
    },
  ],
};
