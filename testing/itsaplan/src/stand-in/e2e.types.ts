import type { ColumnSpec, PullRequestSource, StoredMember, StoredRepository } from "./types.js";

/** The end-to-end run's project. */
export interface ItsaplanE2eOptions {
  projectKey: string;
  teamRef: string;

  /** Status names; they match `workflow.statuses` of the team file. */
  columns: ColumnSpec[];
  members: StoredMember[];

  /** API key to the userId it acts as. An unknown key is refused. */
  keys: Record<string, string>;

  /** The member (by username) the controls act as. */
  human: string;

  /** The code repositories connected to the team, and where their pull requests come from (the code host stand-in). */
  repositories?: StoredRepository[];
  pullRequests?: PullRequestSource;
}
