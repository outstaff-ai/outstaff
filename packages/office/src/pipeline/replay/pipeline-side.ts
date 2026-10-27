import { fromDecisions } from "../compare/outcomes.js";
import { describeOp } from "../describe.js";
import type { Trace } from "../trace.types.js";
import type { Side } from "./replay.types.js";

/** The pipeline's decisions as shown and as compared; drops are shown but never compared. */
export function pipelineSide(trace: Trace): Side {
  const shown = trace.decisions.flatMap((d) =>
    d.type === "wake"
      ? [`wake ${d.person} (${d.kind}): _${d.instruction}_`]
      : d.type === "act"
        ? d.ops.map((op) => `${describeOp(op)} (for ${d.as})`)
        : [`(drop: ${d.reason})`],
  );

  return { shown, outcomes: fromDecisions(trace.decisions) };
}
