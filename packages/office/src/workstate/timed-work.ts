import type { BlockNudges } from "./block-nudges.types.js";
import type { MergeCheckOps, WorkstateCore } from "./core.types.js";
import { createMergeChecks } from "./merge-checks.js";
import { createSweep } from "./sweep.js";

/** What the work state does on the office's poll: follow the merges' checks, then sweep the board when it is due. */
export function createTimedWork(core: WorkstateCore, nudges: Pick<BlockNudges, "nudge">): MergeCheckOps {
  const merges = createMergeChecks(core, nudges);
  const sweep = createSweep(core);
  return {
    async followMerges(ctx) {
      await merges.followMerges(ctx);
      await sweep.sweepIfDue(ctx);
    },
  };
}
