import type { ActSpec, OpSpec, PersonSpec, PolicyDefinition, WakeSpec } from "@outstaff/policy";

/** The agent a pull request's ticket belongs to: its author, or, for a human's pull request, the ticket's agent. */
export const TICKET_AGENT: PersonSpec = ["author", "assignee", "last_worker"];

const code = (s: string) => `\`${s}\``;

/** One person, or a list tried in order. */
export const personText = (p: PersonSpec): string =>
  typeof p === "string" ? code(p) : p.map(code).join(", else ");

function opText(op: OpSpec): string {
  if ("move" in op) {
    return `move the ticket to ${code(op.move)}`;
  }

  if ("assign" in op) {
    return op.assign === "self" ? "assign it to the agent acted for" : "assign it to the requester";
  }

  return "set its parent";
}

type Decides = Pick<PolicyDefinition, "decides" | "decide">;

/** A policy that wakes one person: its `decide`, and the same in words for the reference. */
export function wakes(spec: WakeSpec): Decides {
  const next = spec.subject === "next_ready_ticket" ? ", with its next ready ticket" : "";
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
