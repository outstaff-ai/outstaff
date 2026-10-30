import type { DecideSpec, OpSpec, PersonSpec, PipelineCondition } from "./policy.types.js";

const code = (s: string) => `\`${s}\``;

/** One person, or a list tried in order. */
export const personText = (p: PersonSpec): string =>
  typeof p === "string" ? code(p) : p.map(code).join(", else ");

const OPS: Record<string, (op: OpSpec) => string> = {
  move: (op) => `move the ticket to ${code((op as { move: string }).move)}`,
  assign: (op) =>
    (op as { assign: string }).assign === "self"
      ? "assign it to the agent acted for"
      : "assign it to the requester",
  comment: () => "comment",
  set_parent: () => "set its parent",
};

const opText = (op: OpSpec): string => OPS[Object.keys(op)[0]!]!(op);

/** A decision spec in words: whom it wakes and with what kind, the changes it makes and for whom, or why it drops. */
export function decisionText(d: DecideSpec): string {
  if ("wake" in d) {
    const { person, kind, subject } = d.wake;
    const next = subject === "next_ready_ticket" ? ", with its next ready ticket" : "";
    return `wake ${personText(person)} (kind ${code(kind)})${next}`;
  }

  if ("act" in d) {
    const { as, ops, wake } = d.act;
    const then = wake ? `, then wake them (kind ${code(wake.kind)})` : "";
    return `act for ${personText(as)}: ${ops.map(opText).join(", ")}${then}`;
  }

  return `drop: ${d.drop.reason}`;
}

const valueText = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v));

const COMBINATORS: Record<string, string> = { all: "all of:", any: "any of:", not: "not:" };

/** A condition as a nested Markdown list, one line per leaf and one per `all`, `any` or `not`. */
export function conditionLines(c: PipelineCondition, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const [key, value] = Object.entries(c)[0]!;
  const label = COMBINATORS[key];
  if (!label) {
    return [`${indent}- ${code(`${key}: ${valueText(value)}`)}`];
  }

  const children = (Array.isArray(value) ? value : [value]) as PipelineCondition[];
  return [`${indent}- ${label}`, ...children.flatMap((child) => conditionLines(child, depth + 1))];
}
