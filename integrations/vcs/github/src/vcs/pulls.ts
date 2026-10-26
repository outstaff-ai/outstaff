import {
  PortError,
  type MergeOptions,
  type PullRequest,
  type RepoRef,
  type Vcs,
} from "@outstaff/core";
import { toPullRequest } from "../mapping.js";
import type { RestPull } from "../api.types.js";
import { PERMISSIONS, repoPath } from "./context.js";
import type { GithubContext } from "./types.js";

const MERGEABLE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000];
const MERGE_QUEUE_QUERY = `query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}`;
const READY_MUTATION = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`;
const DRAFT_MUTATION = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`;

type PullOperations =
  | "listPullRequests"
  | "getPullRequest"
  | "openPullRequest"
  | "updatePullRequest"
  | "commentOnPullRequest"
  | "mergeOptions"
  | "mergePullRequest"
  | "diff";

/** Reading, opening, updating and merging pull requests. */
export function pullOperations(c: GithubContext): Pick<Vcs, PullOperations> {
  const { http, self, sleep, links, grantOf, isAgentLogin, apiToken, actingToken } = c;

  async function fetchPull(repo: RepoRef, number: number, token: string): Promise<PullRequest> {
    const res = await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token });
    return toPullRequest(repo, res.data, links.pr(repo, number), isAgentLogin);
  }

  return {
    async listPullRequests(repo, filter = {}) {
      const token = await apiToken(repo);
      const pulls = await http.paginate<RestPull[], RestPull>(
        `${repoPath(repo)}/pulls`,
        {
          token,
          query: {
            state: filter.state ?? "open",
            per_page: 100,
            sort: "updated",
            direction: "desc",
          },
        },
        (d) => d,
      );

      const author = filter.author?.toLowerCase();
      return pulls
        .filter(
          (p) =>
            !author || [author, `${author}[bot]`].includes((p.user?.login ?? "").toLowerCase()),
        )
        .map((p) => toPullRequest(repo, p, links.pr(repo, p.number), isAgentLogin));
    },

    async getPullRequest(repo, number, opts) {
      const token = await apiToken(repo);
      let pr = await fetchPull(repo, number, token);
      // GitHub computes mergeability lazily: the first read of a fresh head answers null.
      for (const delay of opts?.waitForMergeable ? MERGEABLE_BACKOFF_MS : []) {
        if (pr.mergeable !== "unknown" || pr.state !== "open") {
          break;
        }

        await sleep(delay);
        pr = await fetchPull(repo, number, token);
      }

      return pr;
    },

    async openPullRequest(repo, input) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const defaultBranch = (
        await http.request<{ default_branch: string }>("GET", repoPath(repo), { token })
      ).data.default_branch;

      if (input.head.replace(/^[^:]+:/, "") === defaultBranch) {
        throw new PortError(
          "invalid",
          `Refusing to open a pull request from the default branch ${defaultBranch}; use a feature branch.`,
        );
      }

      const res = await http.request<RestPull>("POST", `${repoPath(repo)}/pulls`, {
        token,
        body: {
          head: input.head,
          base: input.base ?? defaultBranch,
          title: input.title,
          body: input.body,
          draft: input.draft ?? false,
        },
      });

      return toPullRequest(repo, res.data, links.pr(repo, res.data.number), isAgentLogin);
    },

    async updatePullRequest(repo, number, patch) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const current = (
        await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token })
      ).data;

      const fields: Record<string, unknown> = {};
      for (const k of ["title", "body", "base"] as const) {
        if (patch[k] !== undefined) {
          fields[k] = patch[k];
        }
      }

      let latest = current;
      if (Object.keys(fields).length) {
        latest = (
          await http.request<RestPull>("PATCH", `${repoPath(repo)}/pulls/${number}`, {
            token,
            body: fields,
          })
        ).data;
      }

      // The REST API cannot change draft state; only GraphQL can.
      if (patch.draft !== undefined && patch.draft !== (current.draft === true)) {
        if (!current.node_id) {
          throw new PortError("unavailable", "GitHub returned no node id for the pull request.");
        }

        await http.graphql(token, patch.draft ? DRAFT_MUTATION : READY_MUTATION, {
          id: current.node_id,
        });

        latest = { ...latest, draft: patch.draft };
      }

      return toPullRequest(repo, latest, links.pr(repo, number), isAgentLogin);
    },

    async commentOnPullRequest(repo, number, body) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const made = await http.request<{ html_url?: string }>(
        "POST",
        `${repoPath(repo)}/issues/${number}/comments`,
        { token, body: { body } },
      );

      return { url: made.data?.html_url ?? links.pr(repo, number) };
    },

    async mergeOptions(repo, base): Promise<MergeOptions> {
      const token = await apiToken(repo);
      const [info, queue] = await Promise.all([
        http.request<{ allow_merge_commit?: boolean; allow_squash_merge?: boolean }>(
          "GET",
          repoPath(repo),
          { token },
        ),
        http.graphql<{ repository: { mergeQueue: { id: string } | null } | null }>(
          token,
          MERGE_QUEUE_QUERY,
          { owner: repo.owner, name: repo.name, branch: base },
        ),
      ]);

      return {
        queue: !!queue.repository?.mergeQueue,
        methods: [
          ...(info.data.allow_merge_commit === false ? [] : (["merge"] as const)),
          ...(info.data.allow_squash_merge === false ? [] : (["squash"] as const)),
        ],
      };
    },

    async mergePullRequest(repo, number, input) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      if (input.method === "queue") {
        // The async endpoint also queues what the GraphQL mutation refuses (pull requests of a stack).
        await http.request("PUT", `${repoPath(repo)}/pulls/${number}/merge-async`, {
          token,
          body: { merge_action: "merge_queue", sha: input.sha },
        });

        return { outcome: "queued" };
      }

      await http.request("PUT", `${repoPath(repo)}/pulls/${number}/merge`, {
        token,
        body: { merge_method: input.method, sha: input.sha },
      });

      return { outcome: "merged" };
    },

    async diff(repo, number) {
      if (!(self && grantOf(self, repo))) {
        throw new PortError(
          "forbidden",
          `"${self ?? "this container"}" has no grant on ${repo.owner}/${repo.name}.`,
        );
      }

      const res = await http.request<unknown>("GET", `${repoPath(repo)}/pulls/${number}`, {
        token: await apiToken(repo),
        headers: { accept: "application/vnd.github.diff" },
      });

      return res.text;
    },
  };
}
