import type { RestGitCommit } from "@outstaff/integration.vcs.github";

/** A commit the git data API made: its tree and parents by sha. */
export type StoredGitCommit = Pick<RestGitCommit, "message"> & {
  tree: RestGitCommit["tree"]["sha"];
  parents: NonNullable<RestGitCommit["parents"]>[number]["sha"][];
};

/**
 * The objects and branches of the git data API (blobs, trees, commits, refs), kept apart from the repository the
 * pull requests use: a branch made here exists only once it is created, as an orphan or on top of another commit.
 */
export interface GitData {
  /** Blob sha to its content, base64. */
  blobs: Map<string, string>;

  /** Tree sha to its files: full path to blob sha. */
  trees: Map<string, Map<string, string>>;
  commits: Map<string, StoredGitCommit>;

  /** Branch name to commit sha. */
  refs: Map<string, string>;
}
