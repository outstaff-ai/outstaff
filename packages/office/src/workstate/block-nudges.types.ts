import type { WorkflowEvent } from "@outstaff/core";
import type { RefreshCtx } from "./core.types.js";

/** What happened that a blocked ticket may have waited on: its kind, what it names, and the facts in a line. */
export interface BlockCause {
  kind: "check" | "blocker" | "comment";
  ref: string;
  why: string;
}

/** Wakes the PM, through `ticket.block_maybe_resolved`, on a blocked ticket something it may wait on happened to. */
export interface BlockNudges {
  /** Raises it on a blocked ticket, at most once per ticket and cause in 24 hours. */
  nudge(ctx: RefreshCtx, key: string, cause: BlockCause): Promise<void>;

  /** A trusted human's comment on one ticket that names a blocked ticket assigned to them. */
  onComment(ctx: RefreshCtx, event: WorkflowEvent): Promise<void>;
}
