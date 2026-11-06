import type { ActSpec, OpSpec, PersonSpec, PolicyDefinition, WakeSpec } from "@outstaff/policy";

/** The agent a pull request's ticket belongs to: its author, or, for a human's pull request, the ticket's agent. */
export const TICKET_AGENT: PersonSpec = ["author", "assignee", "last_worker"];

const code = (s: string) => `\`${s}\``;

/**
 * The ticket's status now, for a comment's wake: the comment is judged by the status when it was written, and the
 * ticket may have closed since.
 */
export const STATUS_NOW =
  "{{ticket}}'s status now: {{status}}. A done or canceled ticket stays closed unless the comment asks to reopen it.";

/** One person, or a list tried in order. */
export const personText = (p: PersonSpec): string =>
  typeof p === "string" ? code(p) : p.map(code).join(", else ");

function opText(op: OpSpec): string {
  if ("move" in op) {
    return `move the ticket to ${code(op.move)}`;
  }

  if ("assign" in op) {
    if (op.assign === "self") {
      return "assign it to the agent acted for";
    }

    return op.assign === "requester"
      ? "assign it to the requester"
      : `assign it to ${code(op.assign)}`;
  }

  if ("link_doc" in op) {
    return "link the document on the ticket";
  }

  return "link_pr" in op ? "link the pull request on the ticket" : "set its parent";
}

type Decides = Pick<PolicyDefinition, "decides" | "decide">;

/** What a wake's subject adds to its words: nothing for the event's own. */
const SUBJECT_TEXT: Record<NonNullable<WakeSpec["subject"]>, string> = {
  event: "",
  next_ready_ticket: ", with its next ready ticket (for a sub-ticket, on its parent)",
  parent: ", on the ticket's parent",
};

/** A policy that wakes one person: its `decide`, and the same in words for the reference. */
export function wakes(spec: WakeSpec): Decides {
  const next = SUBJECT_TEXT[spec.subject ?? "event"];
  return {
    decides: `wake ${personText(spec.person)} (kind ${code(spec.kind)})${next}`,
    decide: (_event, ctx) => ctx.wake(spec),
  };
}

/** A policy that makes bookkeeping changes for an agent, and maybe wakes them after. */
export function acts(spec: ActSpec): Decides {
  const then = spec.wake ? `, then wake them (kind ${code(spec.wake.kind)})` : "";
  return {
    decides: `act for ${personText(spec.as)}: ${spec.ops.map(opText).join(", ")}${then}`,
    decide: (_event, ctx) => ctx.act(spec),
  };
}
