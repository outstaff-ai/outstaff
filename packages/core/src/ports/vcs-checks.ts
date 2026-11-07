/** A check on a commit and the log of its failed steps, as the code host reports them. */
export interface Check {
  name: string;
  status: "pending" | "success" | "failure" | "neutral";
  url: string;

  /** What the check reports about itself (a check run's output summary), when it has one. */
  summary?: string;

  /** Set when the host can show this check's log through `Vcs.checkLog`; pass it back as is. */
  logId?: string;

  /**
   * The workflow the check ran in, when `checks` was asked for it and the host groups checks in workflows. With the
   * name, it tells the same check apart on two commits.
   */
  workflow?: string;
}

/** What `Vcs.checks` reads besides the checks. */
export interface CheckReadOptions {
  /** Name each check's workflow (`Check.workflow`), which may cost the host a read more. */
  workflows?: boolean;
}

/** The log of one failed step of a check. */
export interface CheckLogStep {
  name: string;

  /** The last lines of the step's log, oldest first, timestamps removed. */
  lines: string[];

  /** Lines of the step's log before `lines`. */
  omitted: number;
}

export interface CheckLog {
  /** Steps that failed; empty when the check did not fail or the host reports no failed step. */
  failedSteps: CheckLogStep[];
}
