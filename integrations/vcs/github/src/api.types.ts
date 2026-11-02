// The shapes of the GitHub REST and GraphQL responses the adapter reads.

/** One file of `GET /pulls/{n}/files`. */
export interface RestPullFile {
  filename: string;

  /** The file's earlier path, for a rename. */
  previous_filename?: string;
}

export interface RestPull {
  number: number;
  node_id?: string;
  title: string;
  body: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;

  /** For a merged pull request, the commit the merge made; GitHub also fills it with a test merge while it is open. */
  merge_commit_sha?: string | null;
  draft?: boolean;
  requested_reviewers?: { login: string }[] | null;
  mergeable?: boolean | null;
  mergeable_state?: string;

  /** Set while auto-merge is on: who turned it on and how it merges. */
  auto_merge?: { merge_method?: string } | null;
  updated_at: string;
}

export interface RestCheckRun {
  id?: number;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

export interface RestEvent {
  id: string;
  type: string;
  actor?: { login: string } | null;
  created_at: string;
  payload: Record<string, any>; // oxlint-disable-line no-explicit-any
}

/** One status check context of a commit's rollup: a check run or a commit status. */
export type RollupContext =
  | {
      __typename: "CheckRun";
      name: string;
      status: string;
      conclusion: string | null;
      detailsUrl: string | null;
      isRequired: boolean;
    }
  | {
      __typename: "StatusContext";
      context: string;
      state: string;
      targetUrl: string | null;
      isRequired: boolean;
    };

/** One page of a commit's status check rollup. */
export interface RollupContexts {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RollupContext[];
}

export interface RequiredChecksData {
  repository: {
    pullRequest: {
      commits: {
        nodes: {
          commit: {
            statusCheckRollup: { contexts: RollupContexts } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

/** Where the direct comment and review lists of a repository were left off. */
export interface DirectCursor {
  /** The newest `updated_at` (or `submitted_at`) read from the lists. */
  since: string;

  /** Where the lists started: what is at or before it is history, or the feed's (read under its event ids). */
  after?: string;

  /** ETag per list path, for `If-None-Match`. */
  etags?: Record<string, string>;

  /** Pull request number to the `updated_at` at which its reviews were last read. */
  reviewed?: Record<string, string>;
}

export interface Cursor {
  [repo: string]: { etag?: string; since?: string; seen?: string[]; direct?: DirectCursor };
}

export type ThreadNode = {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  comments: {
    nodes: {
      id: string;
      databaseId: number | null;
      body: string;
      createdAt: string;
      url: string;

      /** `Bot` for an App, which GraphQL names without the `[bot]` suffix REST adds. */
      author: { login: string; __typename: string } | null;
    }[];
  };
};

export type ThreadsData = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ThreadNode[];
      };
    } | null;
  } | null;
};

export interface RestReviewComment {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
  html_url?: string;
}

/** One review comment of `GET /repos/{owner}/{repo}/pulls/comments`, the repository-wide list. */
export interface RestRepoReviewComment extends RestReviewComment {
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  pull_request_review_id?: number | null;

  /** The API URL of the pull request, ending in its number. */
  pull_request_url: string;
}

export interface RestIssueComment {
  id: number;
  user: { login: string } | null;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  html_url: string;
}

export interface RestReview {
  id: number;
  user: { login: string } | null;
  body?: string | null;
  state: string;
  submitted_at?: string | null;
  commit_id?: string | null;
  html_url: string;
}

/** The parts of `GET /repos/{owner}/{repo}` the adapter reads. */
export interface RestRepo {
  default_branch: string;
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

/** Required status checks of classic branch protection. */
export interface RestRequiredStatusChecks {
  strict?: boolean;
  contexts: string[];
}

/** `GET /repos/{owner}/{repo}/branches/{branch}`: readable with Contents: read, so only a summary of protection. */
export interface RestBranch {
  name: string;
  protected: boolean;
  protection?: { enabled?: boolean; required_status_checks?: RestRequiredStatusChecks };
}

/** `GET /repos/{owner}/{repo}/branches/{branch}/protection`, which needs Administration: read. */
export interface RestBranchProtection {
  required_status_checks?: RestRequiredStatusChecks | null;
  required_pull_request_reviews?: { required_approving_review_count?: number } | null;
}

/** One rule of `GET /repos/{owner}/{repo}/rules/branches/{branch}`: what the rulesets that apply to a branch ask. */
export interface RestRule {
  type: string;
  parameters?: {
    required_approving_review_count?: number;
    required_status_checks?: { context: string }[];
    strict_required_status_checks_policy?: boolean;
  };
}
