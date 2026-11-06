import type { DoctorCheck } from "@outstaff/core";

export interface Installation {
  id?: number;
  account?: { login: string } | null;
  repository_selection?: "all" | "selected";
  permissions?: Record<string, string>;
}

export type Reply<T> = { ok: true; data: T } | { ok: false; status: number };

export interface AppExpectation {
  prefix: "GH_APP_" | "GH_OFFICE_APP_";
  label: string;

  /** Lower-case `owner/name` the installation has to cover. */
  repos: string[];

  /** Repositories beyond `repos` are a finding only when the App is meant to be narrow. */
  exact: boolean;

  /** Names the risk of extra repositories: the person's own App can write there. */
  extraCanWrite?: boolean;
  readOnly: boolean;
  wantWrite: boolean;

  /**
   * The App reads the logs of Actions jobs, so it needs Actions: read: a writer's own App for `ost pr checks`, the
   * office App for the log of a check that failed after a merge (the wake and `ost ci log`).
   */
  wantActions?: boolean;

  /** The person's role changes CI workflow files, so the App needs the Workflows permission. */
  wantWorkflows?: boolean;

  /**
   * Repositories of `repos` that have a `.github/workflows/` directory. GitHub refuses a push from the App that changes
   * a file there without the Workflows permission, so the App needs it there too, even when the role does not.
   */
  workflowRepos?: string[];

  /** The bot login the team file names for this App. */
  login?: string;
}

/** The App's installation on one account that owns repositories of the expectation, narrowed to those. */
export interface AccountInstallation {
  /** Lower-case login of the account. */
  account: string;
  id: string;
  data: Installation;

  /** The expectation for this account alone: its repositories, and a label naming it when there are several. */
  want: AppExpectation;
}

/** The installations the doctor checks, and the findings from finding them. */
export interface Resolved {
  accounts: AccountInstallation[];
  findings: DoctorCheck[];
}
