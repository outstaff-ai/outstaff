import type { PrRecord } from "../workstate/index.js";

/** What deriving needs of a pull request in the work state. */
export type PrSnapshot = Pick<
  PrRecord,
  "ref" | "title" | "url" | "headRef" | "baseRef" | "state" | "mergeable" | "ticket"
>;

export interface MergeChange {
  /** The pull request that merged, as the work state has it after the merge. */
  merged: PrSnapshot;

  /** The repository's pull requests before the merge and after the work state re-checked them. */
  before: readonly PrSnapshot[];
  after: readonly PrSnapshot[];

  /** The repository requires a branch to be up to date with its base before it merges (read from the code host). */
  requiresUpToDate: boolean;

  /** When the merge happened (ISO-8601). */
  at: string;
}
