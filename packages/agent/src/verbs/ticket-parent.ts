import { PortError, type Tracker } from "@outstaff/core";
import { z } from "zod";
import { requireTracker } from "./support.js";
import { defineVerb, result } from "./define.js";
import { key } from "./ticket-support.js";
import type { ParentCleared } from "./ticket-parent.types.js";

/** Clears one ticket's parent; a ticket without one is left as it is, and a failure is reported, not thrown. */
async function clearOne(tracker: Tracker, ticket: string): Promise<ParentCleared> {
  try {
    const { parent } = await tracker.getIssue(ticket);
    if (!parent) {
      return { key: ticket, outcome: "no_parent" };
    }

    await tracker.setParent!(ticket, null);
    return { key: ticket, outcome: "cleared", parent };
  } catch (e) {
    if (!(e instanceof PortError)) {
      throw e;
    }

    return { key: ticket, outcome: "failed", code: e.code, message: e.message };
  }
}

const lineOf = (d: ParentCleared): string =>
  d.outcome === "cleared"
    ? `${d.key} is no longer a subtask of ${d.parent}.`
    : d.outcome === "no_parent"
      ? `${d.key} has no parent.`
      : `${d.key}: ${d.message}`;

/** Clears the parent of each ticket in turn; fails only when every one failed. */
async function clearAll(tracker: Tracker, tickets: string[]) {
  const done: ParentCleared[] = [];
  for (const ticket of tickets) {
    done.push(await clearOne(tracker, ticket));
  }

  const lines = done.map(lineOf);
  if (done.every((d) => d.outcome === "failed")) {
    throw new PortError(done[0]!.code!, lines.join("\n"));
  }

  return result(
    lines,
    { tickets: done },
    done.map((d) => tracker.links.issue(d.key)),
  );
}

export const ticketParent = defineVerb({
  name: "ticket.parent",
  summary: "Make a ticket a subtask of another ticket, or clear the parent of tickets.",
  description:
    "Sets the parent of an existing ticket in the tracker's own parent field, so it shows as a subtask of the parent: pass the ticket, then its parent. Use it for work that is part of another ticket's scope. With clear, each ticket given loses its parent instead, and each is reported: a ticket without a parent is left as it is, and one that fails does not stop the others (the verb fails only when every one failed). Refused when the tracker has no parent field; link independent follow-ups with a relates link instead.",
  input: z.strictObject({
    tickets: z
      .array(key)
      .min(1)
      .max(100)
      .describe("The ticket, then its parent; with clear, the tickets whose parent to clear."),
    clear: z.boolean().default(false).describe("Clear the parent of each ticket given."),
  }),
  args: ["tickets"],
  examples: ["ost ticket parent ACME-120 ACME-118", "ost ticket parent ACME-120 ACME-121 --clear"],
  async run(env, input) {
    const tracker = requireTracker(env);
    if (!tracker.setParent) {
      throw new PortError("unsupported", "This tracker has no parent field.");
    }

    if (input.clear) {
      return clearAll(tracker, input.tickets);
    }

    const [child, parent, ...rest] = input.tickets;
    if (!parent || rest.length) {
      throw new PortError("invalid", "Pass the ticket, then its parent; or tickets with clear.");
    }

    const issue = await tracker.setParent(child!, parent);
    const url = tracker.links.issue(issue.key);
    return result([`${issue.key} is now a subtask of ${parent}.`, url], { issue }, [url]);
  },
});
