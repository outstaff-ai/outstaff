import type { ReplayScenario, ReplayWorld } from "#/pipeline/replay/replay.types.js";
import { at, ev, ROLES, ticket } from "./build.js";

const PARENT = "ACME-200";
const DESIGN = "ACME-201";
const ASKED_AT = at(270);

/** The parent the PM is blocked on, waiting for the design; the design sub-ticket in `status`, the designer's. */
const tickets = (status: "review" | "done") => ({
  [PARENT]: ticket("blocked", "ada.admin", { lastWorker: "priya", blockedAgent: "priya" }),
  [DESIGN]: ticket(status, status === "done" ? "leo" : "ada.admin", {
    lastWorker: "leo",
    parent: PARENT,
  }),
});

/** The PM waits on the human on the design ticket: she asked there, and the human has not answered since. */
const waiting = (status: "review" | "done"): ReplayWorld => ({
  tickets: tickets(status),
  roles: ROLES,
  waiting: {
    [DESIGN]: {
      "ada.admin": [
        { agent: "priya", at: ASKED_AT, url: `https://plan.acme.example/${DESIGN}#comment-1` },
      ],
    },
  },
});

const on = (id: string, by: string, minute: number, data: Record<string, unknown>) =>
  ev(id, "ticket.commented", by, { ticket: DESIGN }, at(minute), data);

/**
 * A human's answer on a ticket wakes the agent that asked them there. The PM, blocked on a parent until its design is
 * approved, asks the human on the design sub-ticket; the designer closes it, and her mention of the PM on the closed
 * ticket wakes no one. The human's approval there wakes the PM, not only the designer; a later comment of theirs
 * answers nothing the PM asked since.
 */
export const answerToAsker: ReplayScenario = {
  title: "A human's answer wakes the agent that asked them",
  steps: [
    {
      event: on("s11-ask", "priya", 270, {
        body: `@ada.admin please confirm that revision; then I split ${PARENT} into build tickets.`,
        mentionedHumans: ["ada.admin"],
      }),
      world: { tickets: tickets("review"), roles: ROLES },
    },
    {
      event: ev("s11-close", "ticket.moved", "leo", { ticket: DESIGN }, at(271), {
        from: "review",
        to: "done",
      }),
      world: waiting("done"),
    },
    {
      event: on("s11-designer", "leo", 272, {
        body: "@priya the design is final, the parent can now be split.",
        mentions: ["priya"],
      }),
      world: waiting("done"),
    },
    {
      event: on("s11-approve", "ada.admin", 273, {
        body: "All good, let's build with this version.",
      }),
      world: waiting("done"),
    },
    {
      event: on("s11-thanks", "ada.admin", 274, { body: "Thanks!" }),
      world: { tickets: tickets("done"), roles: ROLES },
    },
  ],
};
