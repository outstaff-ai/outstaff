/** A check on a merge commit that did not pass, as a `pr.merge_checks_failed` names it. */
export interface MergeCheck {
  name: string;
  url?: string;

  /** Set when the code host can show the check's log (`Vcs.checkLog`). */
  logId?: string;

  /** The workflow it ran in, when the code host groups checks in workflows: with the name, the same check. */
  workflow?: string;
}

/** The checks on the commit a merge made on the default branch, followed from the merge until they are decided. */
export interface MergeChecks {
  /** The merge commit; absent when the code host does not say, which counts as passed. */
  sha?: string;

  /** When the office saw the merge (ISO-8601); the waits count from here. */
  since: string;
  state: "pending" | "passed" | "failed";

  /** For a failed merge: the checks that failed, or the ones still running at the timeout. */
  failing?: MergeCheck[];

  /** The merge failed because a check was still running after `policies.merge_checks.timeout_minutes`. */
  timedOut?: boolean;

  /**
   * Since when every check seen has finished without failing, and which they were. The merge passes once no new check
   * appears for `policies.merge_checks.settle_minutes`; a check that starts ends the quiet.
   */
  quiet?: { since: string; checks: string[] };

  /**
   * For a failed merge: the last head of the default branch looked at that did not make up for it, so it is not read
   * again.
   */
  seenHead?: string;

  /**
   * The failed merge passed later: every check that failed passed on this commit of the default branch, which contains
   * the merge commit.
   */
  recoveredOn?: string;
}
