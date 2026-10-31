import { definePolicy } from "@outstaff/policy";
import { acts } from "./spec.js";

const linking = acts({ as: "author", ops: [{ link_pr: true }] });

export const policy = definePolicy({
  id: "link_pr_on_ticket",
  summary:
    "An agent's pull request opened for a ticket, or linked to one after it was opened, is shown on the ticket in the tracker (its development section), by the author with its own tracker account. Bookkeeping: it wakes no one.",
  on: ["pr.opened", "pr.linked"],
  decides: `${linking.decides}, when the tracker can link pull requests (\`tracker.development\`)`,
  decide(event, ctx) {
    return ctx.options.capabilities?.includes("tracker.development")
      ? linking.decide(event, ctx)
      : [{ type: "drop", reason: "the tracker cannot link pull requests (tracker.development)" }];
  },
});
