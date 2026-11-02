import { definePolicy } from "@outstaff/policy";
import { acts } from "./spec.js";

const linking = acts({ as: ["doc_author", "actor"], ops: [{ link_doc: true }] });

export const policy = definePolicy({
  id: "link_doc_on_ticket",
  summary:
    "A document an agent wrote for a ticket, in a round on the ticket or attached to it later, is shown on the ticket in the tracker, by its author with its own account. Bookkeeping: it wakes no one.",
  on: ["doc.linked"],
  decides: `${linking.decides}, when the knowledge base can link documents on tickets (\`knowledge.issueLinks\`)`,
  decide(event, ctx) {
    return ctx.options.capabilities?.includes("knowledge.issueLinks")
      ? linking.decide(event, ctx)
      : [
          {
            type: "drop",
            reason: "the knowledge base cannot link documents on tickets (knowledge.issueLinks)",
          },
        ];
  },
});
