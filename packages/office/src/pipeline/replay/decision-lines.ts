import type { Decision } from "#/pipeline/decisions.types.js";
import { describeOp } from "#/pipeline/describe.js";
import type { Trace } from "#/pipeline/trace.types.js";

function linesOf(d: Decision): string[] {
  switch (d.type) {
    case "wake":
      return [`wake ${d.person} (${d.kind}): _${d.instruction}_`];
    case "act":
      return d.ops.map((op) => `${describeOp(op)} (for ${d.as})`);
    case "stop":
      return [`stop the work on ${d.ticket}: _${d.notice}_`];
    case "drop":
      return [`(drop: ${d.reason})`];
  }
}

/**
 * The pipeline's decisions as a person reads them: each wake, each tracker change and who it is for, each stop, each
 * drop.
 */
export function decisionLines(trace: Trace): string[] {
  return trace.decisions.flatMap(linesOf);
}
