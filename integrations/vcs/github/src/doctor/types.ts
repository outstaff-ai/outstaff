export interface Installation {
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

  /** The person's role changes CI workflow files, so the App needs the Workflows permission. */
  wantWorkflows?: boolean;

  /** The bot login the team file names for this App. */
  login?: string;
}
