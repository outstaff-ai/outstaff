import type { GitMode, Layout, Logger, Profile, RepoRef, TeamConfig, Vcs } from "@outstaff/core";
import type { Offer } from "#/office-client/index.js";

/** Runs git with the given arguments and resolves to its stdout. Rejects with git's message when it fails. */
export type RunGit = (args: string[], opts?: { cwd?: string }) => Promise<string>;

export type CredentialOperation = "get" | "store" | "erase";

export interface CredentialHelperOptions {
  team: Pick<TeamConfig, "repos" | "people">;

  /** Handle of the person the container runs as. */
  person: string;
  vcs: Vcs;

  /** The person's role profile; it caps the access a write grant gives. */
  profile: Profile;
}

export interface CredentialHelper {
  /** Output for git on stdout. Empty when the request is not for a repo the person has a grant on. */
  run(operation: CredentialOperation, input: string): Promise<string>;
}

export interface ClonedRepo {
  /** The repo's short name in team.yaml. */
  name: string;
  dir: string;
  ref: Required<RepoRef>;
  defaultBranch: string;
  access: GitMode;
  kind: string;

  /** Extra files from team.yaml `repos[].instructions` that the agent reads first. */
  instructions: string[];

  /** Ticket labels from team.yaml `repos[].tracker.labels` that mean work belongs in this repo. */
  trackerLabels: string[];
}

export interface SyncRepositoriesOptions {
  team: TeamConfig;
  person: string;
  vcs: Vcs;

  /** The person's role profile; it caps the access a write grant gives. */
  profile: Profile;
  reposDir: string;
  git?: RunGit;
  log?: Logger;

  /** Where to clone from; default `https://<host>/<owner>/<name>.git`. */
  remoteUrl?: (repo: Required<RepoRef>) => string;

  /** The git credential helper command; default {@link CREDENTIAL_HELPER}. */
  helper?: string;
}

/** Where a base clone is checked out. */
export interface RepoHead {
  /** The repo's short name in team.yaml. */
  name: string;

  /** The commit the clone's working tree is at; undefined when it could not be read. */
  commit: string | undefined;

  /** Whether the clone is at the fetched `origin/<default branch>`. False when it has local changes or could not move. */
  atDefault: boolean;
}

/** What a refresh needs of a clone. */
export type BaseClone = Pick<ClonedRepo, "name" | "dir" | "defaultBranch">;

export interface CloneRefresherOptions {
  git: RunGit;
  log: Logger;

  /** Least time between two throttled fetches of one clone. Default 60000. */
  minFetchGapMs?: number;
  now?: () => number;
}

export interface CloneRefresher {
  /** Runs `fn` once every earlier task on the same clone has ended, so two of them never share a clone. */
  exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Fetches the clone and moves it to the fetched default branch, without taking the clone: call it inside
   * {@link exclusive}. A throttled update skips the fetch when the clone was fetched less than `minFetchGapMs` ago.
   * Rejects when the fetch fails.
   */
  update(repo: BaseClone, opts?: { throttled?: boolean }): Promise<RepoHead>;

  /** {@link update} inside {@link exclusive}. */
  refresh(repo: BaseClone, opts?: { throttled?: boolean }): Promise<RepoHead>;
}

/** The places one work item works in. */
export interface Workspace {
  repo: string;
  worktree: string;

  /** The branch checked out. Undefined while HEAD is detached: new work starts that way and the agent creates its branch. */
  branch: string | undefined;
  scratch: string;

  /** Convention files found in the worktree, relative to it, plus the `instructions` files team.yaml lists that exist. */
  conventionFiles: string[];
}

export interface Workspaces {
  /** Fetches, then returns the item's worktree and scratch directory, creating them on the first round. Undefined when no repo fits. */
  prepare(offer: Offer): Promise<Workspace | undefined>;

  /**
   * Fetches every base clone, at most once a minute each, and moves it to the fetched default branch, for a session
   * that reads the clones. A clone that cannot be fetched is logged and reported where it is.
   */
  refresh(): Promise<RepoHead[]>;

  /** Removes the item's worktree and scratch directory. The branch stays, so unmerged commits are not lost. */
  release(workItemId: string): Promise<void>;

  /** The ids of the items that have a worktree or a scratch directory now. */
  held(): string[];
}

export interface WorkspacesOptions {
  layout: Pick<Layout, "worktreesDir" | "scratchDir">;
  repos: ClonedRepo[];
  git?: RunGit;
  log?: Logger;

  /** Least time between two fetches of one clone for a session that only reads it. Default 60000. */
  minFetchGapMs?: number;
  now?: () => number;
}
