import {
  PortError,
  type PullRequestLinkOutcome,
  type PullRequestToLink,
  type RepoRef,
} from "@outstaff/core";
import type {
  ApiDevPullRequest,
  ApiDevPullRequestPage,
  ApiDevRepository,
  ApiIssue,
  Itsaplan,
} from "@outstaff/integration.shared.itsaplan";

const fullName = (repo: Pick<RepoRef, "owner" | "name">) =>
  `${repo.owner}/${repo.name}`.toLowerCase();

/** `owner/name` as a repository; a nested owner keeps its slashes. */
function repoOf(r: ApiDevRepository): RepoRef {
  const cut = r.fullName.lastIndexOf("/");
  return { owner: r.fullName.slice(0, cut), name: r.fullName.slice(cut + 1) };
}

/**
 * The issue's "Development" section: the repositories connected to the team (asked per issue), and linking a pull
 * request of one of them. Its a Plan reads the pull requests from the code host and says which are linked already.
 */
export function developmentHelpers(api: Itsaplan, fetchIssue: (key: string) => Promise<ApiIssue>) {
  const repositories = (issueId: number) =>
    api.http.request<ApiDevRepository[]>("GET", `/issues/${issueId}/development/repositories`);

  /** The pull request as the tracker lists it for the issue, page by page; undefined when it does not list it. */
  const listed = async (
    issueId: number,
    repositoryId: number,
    number: number,
  ): Promise<ApiDevPullRequest | undefined> => {
    const path = `/issues/${issueId}/development/repositories/${repositoryId}/pull-requests`;
    let page: number | null = 1;
    while (page !== null) {
      const res: ApiDevPullRequestPage = await api.http.request("GET", path, {
        query: { page, state: "all" },
      });

      const hit = res.pullRequests.find((p) => p.number === number);
      if (hit) {
        return hit;
      }

      page = res.nextPage;
    }

    return undefined;
  };

  return {
    async linkPullRequest(key: string, pr: PullRequestToLink): Promise<PullRequestLinkOutcome> {
      const issue = await fetchIssue(key);
      const name = fullName(pr.repo);
      const repo = (await repositories(issue.id)).find((r) => r.fullName.toLowerCase() === name);
      if (!repo) {
        return "not_connected";
      }

      const found = await listed(issue.id, repo.id, pr.number);
      if (!found) {
        throw new PortError(
          "not_found",
          `The tracker does not list pull request ${name}#${pr.number}.`,
        );
      }

      if (found.linked) {
        return "already_linked";
      }

      await api.http.request("POST", `/issues/${issue.id}/development`, {
        body: { repositoryId: repo.id, number: pr.number },
      });

      return "linked";
    },

    /** Its a Plan lists the team's repositories per issue: any issue of the project tells. */
    async connectedRepositories(): Promise<RepoRef[]> {
      const [any] = await api.http.request<ApiIssue[]>("GET", `${api.projectPath}/issues`, {
        query: { limit: 1 },
      });

      if (!any) {
        throw new PortError(
          "not_found",
          "The tracker lists its connected repositories per issue, and the project has no issue yet.",
        );
      }

      return (await repositories(any.id)).map(repoOf);
    },
  };
}
