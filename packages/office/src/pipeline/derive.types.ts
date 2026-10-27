import type { MergeRequirements } from "@outstaff/core";
import type { PrRecord } from "#/workstate/index.js";

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

  /**
   * What the code host requires before a pull request merges into the repository's default branch, as the vcs port's
   * `mergeRequirements` reads it. Only its up-to-date requirement is used, for pull requests into that branch.
   */
  requirements: Pick<MergeRequirements, "branch" | "upToDate">;

  /** When the merge happened (ISO-8601). */
  at: string;
}
