import { subjectLabel } from "../log.js";
import type { ActOp, Decision } from "./decisions.types.js";
import type { PipelineEvent } from "./events.types.js";
import type { Trace } from "./trace.types.js";

/** One tracker change, in words. */
export function describeOp(op: ActOp): string {
  switch (op.op) {
    case "move":
      return `move ${op.ticket} to ${op.to}`;
    case "assign":
      return op.to ? `assign ${op.ticket} to ${op.to.kind} ${op.to.id}` : `unassign ${op.ticket}`;
    case "comment":
      return `comment on ${"ticket" in op.on ? op.on.ticket : `doc ${op.on.doc}`}`;
    case "set_parent":
      return `set the parent of ${op.ticket} to ${op.parent}`;
  }
}

/** What an event is about, in words: a pull request, ticket, document or chat channel. */
export function subjectOf(event: PipelineEvent): string {
  const { chat } = event.subject;
  if (chat && !event.subject.pr && !event.subject.ticket && !event.subject.doc) {
    return `chat ${chat.channel}${chat.thread ? `/${chat.thread}` : ""}`;
  }

  return subjectLabel(event.subject);
}

/** One line per decision, for `ost explain` and the replay report. */
export function describeDecision(d: Decision): string {
  switch (d.type) {
    case "wake":
      return `wake ${d.person} (${d.kind}) on ${d.subject.type} ${d.subject.ref}`;
    case "act":
      return `act as ${d.as}: ${d.ops.map(describeOp).join(", ")}`;
    case "drop":
      return `drop: ${d.reason}`;
  }
}

/** A trace as text: the event, each policy that listens to it with why it matched or not, and the decisions. */
export function formatTrace(trace: Trace): string {
  const { event } = trace;
  const lines = [
    `${event.type} on ${subjectOf(event)} by ${event.actor.kind} ${event.actor.id} at ${event.at}`,
    `event ${event.id}`,
    "",
  ];

  const deaf = trace.policies.filter((p) => !p.matched && p.reason.startsWith("listens to "));
  const judged = trace.policies.filter((p) => !deaf.includes(p));
  if (judged.length > 0) {
    lines.push("Policies:");
    for (const p of judged) {
      lines.push(`  ${p.matched ? "matched" : "no     "}  ${p.policy}: ${p.reason}`);
      if (p.failed) {
        lines.push(`           failing condition: ${JSON.stringify(p.failed)}`);
      }

      for (const d of p.decisions) {
        lines.push(`           -> ${describeDecision(d)}`);
      }
    }

    lines.push("");
  }

  if (deaf.length > 0) {
    lines.push(`Not listening to ${event.type}: ${deaf.map((p) => p.policy).join(", ")}`, "");
  }

  lines.push("Decisions:");
  for (const d of trace.decisions) {
    lines.push(`  ${describeDecision(d)}`);
    if (d.type === "wake") {
      lines.push(`    instruction: ${d.instruction}`);
    }
  }

  return lines.join("\n");
}
