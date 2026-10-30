import { definePolicy } from "@outstaff/policy";
import { NOT_CLOSED } from "./conditions.js";
import { acts } from "./spec.js";

export const policy = definePolicy({
  id: "hand_back_blocked",
  summary:
    "A hand-back as blocked, or as done on a ticket the agent moved to blocked, moves the ticket to blocked and gives it to the requester, for the agent.",
  on: ["agent.handed_back"],
  when: {
    all: [
      {
        any: [
          { hand_back_status: ["blocked"] },
          { all: [{ hand_back_status: ["done"] }, { ticket_status: ["blocked"] }] },
        ],
      },
      NOT_CLOSED,
    ],
  },
  instruction: "Moved to blocked and assigned to the requester: I handed the work back as blocked.",
  ...acts({ as: "actor", ops: [{ move: "blocked" }, { assign: "requester" }] }),
});
