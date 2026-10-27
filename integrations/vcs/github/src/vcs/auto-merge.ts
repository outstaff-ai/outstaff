import { PortError, type RepoRef, type Vcs } from "@outstaff/core";
import type { RestPull, RestRepo } from "#/api.types.js";
import { PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

const AUTO_MERGE_MUTATION = `mutation($id:ID!,$method:PullRequestMergeMethod){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){pullRequest{id}}}`;

/**
 * The repository's own merge method for auto-merge: GitHub defaults to a merge commit, which a repository may forbid.
 * A merge queue ignores it and uses its own.
 */
function repositoryMethod(info: RestRepo): "MERGE" | "SQUASH" | "REBASE" {
  if (info.allow_merge_commit !== false) {
    return "MERGE";
  }

  return info.allow_squash_merge === false ? "REBASE" : "SQUASH";
}

/** Turning on GitHub's auto-merge and joining the merge queue, as this container's own App. */
export function autoMergeOperations(c: GithubContext): Pick<Vcs, "enableAutoMerge" | "enqueue"> {
  const { http, actingToken } = c;

  const pull = async (repo: RepoRef, number: number, token: string) =>
    (await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token })).data;

  return {
    async enableAutoMerge(repo, number) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const [pr, info] = await Promise.all([
        pull(repo, number, token),
        http.request<RestRepo>("GET", repoPath(repo), { token }),
      ]);

      if (!pr.node_id) {
        throw new PortError("unavailable", "GitHub returned no node id for the pull request.");
      }

      await http.graphql(token, AUTO_MERGE_MUTATION, {
        id: pr.node_id,
        method: repositoryMethod(info.data),
      });
    },

    // The async endpoint queues what the GraphQL mutation refuses: the pull requests of a stack.
    async enqueue(repo, number) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const pr = await pull(repo, number, token);
      await http.request("PUT", `${repoPath(repo)}/pulls/${number}/merge-async`, {
        token,
        body: { merge_action: "merge_queue", sha: pr.head.sha },
      });
    },
  };
}
