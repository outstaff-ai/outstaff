import { describeOp } from "#/pipeline/describe.js";
import type { Trace } from "#/pipeline/trace.types.js";

/** The pipeline's decisions as a person reads them: each wake, each tracker change and who it is for, each drop. */
export function decisionLines(trace: Trace): string[] {
  return trace.decisions.flatMap((d) =>
    d.type === "wake"
      ? [`wake ${d.person} (${d.kind}): _${d.instruction}_`]
      : d.type === "act"
        ? d.ops.map((op) => `${describeOp(op)} (for ${d.as})`)
        : [`(drop: ${d.reason})`],
  );
}
