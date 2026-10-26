import { describeOp } from "../describe.js";
import type { Trace } from "../trace.types.js";
import type { Side } from "./replay.types.js";

/** The pipeline's decisions, keyed like today's effects; drops are shown but never compared. */
export function pipelineSide(trace: Trace): Side {
  const shown: string[] = [];
  const keys: string[] = [];
  for (const d of trace.decisions) {
    if (d.type === "wake") {
      const key = `wake ${d.person} (${d.kind})`;
      keys.push(key);
      shown.push(`${key}: _${d.instruction}_`);
    } else if (d.type === "act") {
      for (const op of d.ops) {
        const key = describeOp(op);
        keys.push(key);
        shown.push(`${key} (for ${d.as})`);
      }
    } else {
      shown.push(`(drop: ${d.reason})`);
    }
  }

  return { shown, keys };
}
