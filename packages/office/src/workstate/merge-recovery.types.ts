import type { Check } from "@outstaff/core";
import type { BlockNudges } from "./block-nudges.types.js";
import type { RefreshCtx } from "./core.types.js";
import type { MergeChecks, PrRecord } from "./types.js";

/** What the merge checks give the recovery: reading checks, deciding a merge, and saving what was looked at. */
export interface RecoveryDeps {
  read(rec: PrRecord, sha: string): Promise<Check[] | undefined>;
  decide(ctx: RefreshCtx, rec: PrRecord, from: MergeChecks, d: Partial<MergeChecks>): Promise<void>;
  save(rec: PrRecord, mergeChecks: MergeChecks): Promise<unknown>;
  nudges: Pick<BlockNudges, "nudge">;
}
