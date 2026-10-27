/** How a repository lets a pull request into a branch. */
export interface MergeOptions {
  /** The branch has a merge queue. */
  queue: boolean;

  /** The direct methods the repository's settings allow. */
  methods: ("merge" | "squash")[];
}

export type MergeMethod = "queue" | "merge" | "squash";

export interface MergeResult {
  /** `merged` when the pull request is in, `queued` when the host's queue took it and will merge it. */
  outcome: "merged" | "queued";
}

/** What a code host requires before a pull request merges into a branch. */
export interface MergeRequirements {
  /** The branch the requirements are for: the repository's default branch. */
  branch: string;

  /** Names of the status checks that must pass, from every rule that applies; empty when none is required. */
  requiredChecks: string[];

  /** Approving reviews required, the highest any rule asks for; 0 when none is required. */
  requiredApprovals: number;

  /** A branch must be up to date with the base before it merges. */
  upToDate: boolean;

  /** Set when some of the host's rules could not be read: what is missing and why. The rest is still reported. */
  partial?: string;
}

/** What one protection rule of a branch requires. */
export type BranchRule = Omit<MergeRequirements, "branch" | "partial">;
