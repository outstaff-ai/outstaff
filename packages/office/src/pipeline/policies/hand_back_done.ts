import { definePolicy } from "@outstaff/policy";
import { acts } from "./spec.js";

export const policy = definePolicy({
  id: "hand_back_done",
  summary:
    "A hand-back as done moves the ticket to review and gives it to the requester, for the agent.",
  on: ["agent.handed_back"],
  when: {
    all: [
      { hand_back_status: ["done"] },
      { not: { ticket_status: ["blocked", "done", "canceled"] } },
    ],
  },
  instruction: "Moved to review and assigned to the requester: I handed the work back as done.",
  ...acts({ as: "actor", ops: [{ move: "review" }, { assign: "requester" }] }),
});
