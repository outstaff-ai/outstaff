// The shapes of the GitHub REST and GraphQL responses the adapter reads.

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
  draft?: boolean;
  requested_reviewers?: { login: string }[] | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
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

export interface RequiredChecksData {
  repository: {
    pullRequest: {
      commits: {
        nodes: {
          commit: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
                nodes: (
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
                    }
                )[];
              };
            } | null;
          };
        }[];
      };
    } | null;
  } | null;
}

export interface Cursor {
  [repo: string]: { etag?: string; since?: string; seen?: string[] };
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
      author: { login: string } | null;
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
