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

/** Runs a program with inherited standard streams and resolves to its exit code. */
export type ExecProgram = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<number>;

export interface HostCliRunnerOptions extends CredentialHelperOptions {
  /** The environment the command inherits, before its token is added. */
  env: NodeJS.ProcessEnv;

  /** The origin URL of the repository at a directory, or undefined outside one. */
  origin: (cwd: string) => string | undefined;

  /** The path of the real program, past the wrapper; undefined when it is not installed. */
  which: (command: string) => string | undefined;
  exec: ExecProgram;

  /** Where the runner says why it did not run the command. */
  err: (text: string) => void;
}

export interface HostCliRunner {
  /**
   * Runs the code host's CLI with `args` in `cwd`, with a fresh token, and resolves to its exit code. The token is for
   * `repo` (`owner/name`) when given, else for the repository `-R` names, else for the working directory's.
   */
  run(args: string[], cwd: string, repo?: string): Promise<number>;
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

/** A repository the person has a grant on that could not be prepared (cloned or fetched), with why. */
export interface UnpreparedRepo {
  /** The repo's short name in team.yaml. */
  name: string;
  dir: string;
  ref: Required<RepoRef>;
  access: GitMode;
  kind: string;

  /** Why the last attempt failed. */
  error: string;
}

/** The person's repositories: the ones prepared, and the ones that could not be, which are tried again on demand. */
export interface Repositories {
  /** The prepared clones. One list for the agent's life: a repository prepared on a retry is added to it. */
  ready: ClonedRepo[];

  /** The repositories with a grant that could not be prepared, each with the error of its last attempt. */
  unprepared(): UnpreparedRepo[];

  /**
   * Prepares the unprepared repository `name` again and adds it to {@link ready}; resolves to it, or to the clone
   * when it is ready already. Rejects with the cause when it still fails, and records it.
   */
  retry(name: string): Promise<ClonedRepo>;
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

  /** The item's worktrees in other repositories, added with `ost worktree add` in an earlier round. */
  others?: { repo: string; worktree: string }[];
}

/**
 * What adding a worktree to an item did: added it, found it already there, or found the branch checked out in another
 * worktree (`heldBy`, its path), where git refuses a second checkout.
 */
export type AddedWorktree =
  | { repo: string; worktree: string; branch: string | undefined; existed: boolean }
  | { repo: string; heldBy: string };

export interface Workspaces {
  /**
   * Fetches, then returns the item's worktree and scratch directory, creating them on the first round. Undefined when
   * no repo fits. An unprepared repository the item may need is tried again first, at most once a minute.
   */
  prepare(offer: Offer): Promise<Workspace | undefined>;

  /**
   * Fetches every base clone, at most once a minute each, and moves it to the fetched default branch, for a session
   * that reads the clones. A clone that cannot be fetched is logged and reported where it is. Unprepared repositories
   * are tried again first, at most once a minute each.
   */
  refresh(): Promise<RepoHead[]>;

  /**
   * Adds a worktree of another repository to the item, at `<worktreesDir>/<repo>/<item>`, so later rounds find it as
   * one of {@link Workspace.others}. A repository that could not be prepared is tried again first. Refuses a
   * repository the person cannot write (`forbidden`), and one that still cannot be prepared (`unavailable`).
   */
  add(workItemId: string, repo: string, branch?: string): Promise<AddedWorktree>;

  /** The item directories under each repository's worktree folder, with their root. */
  worktrees(): { repo: string; dir: string; root: string }[];

  /** Removes the item's worktree and scratch directory. The branch stays, so unmerged commits are not lost. */
  release(workItemId: string): Promise<void>;

  /** The ids of the items that have a worktree or a scratch directory now. */
  held(): string[];
}

export interface WorkspacesOptions {
  layout: Pick<Layout, "worktreesDir" | "scratchDir">;

  /** The prepared clones; the list may grow while the workspaces are in use. */
  repos: ClonedRepo[];

  /** The repositories that could not be prepared and how to try one again; none without it. */
  unprepared?: Pick<Repositories, "unprepared" | "retry">;
  git?: RunGit;
  log?: Logger;

  /** Least time between two fetches of one clone for a session that only reads it. Default 60000. */
  minFetchGapMs?: number;
  now?: () => number;
}
