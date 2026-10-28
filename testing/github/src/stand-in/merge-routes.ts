import type { Route, StandInRequest } from "@outstaff/testing.http";
import { requiredApprovals } from "./branch-routes.js";
import { NOT_FOUND, enqueue, headSha, mergePull, pullOf } from "./model.js";
import type { GithubAuth, GithubStore, StoredPull } from "./types.js";

type Kind = "merge" | "merge-async";

const refused = (message: string) => ({ status: 405, body: { message } });

/** Required checks that have not passed on the head. */
const pendingChecks = (s: GithubStore, pr: StoredPull, sha: string) =>
  (s.checks.get(sha) ?? []).filter(
    (c) => pr.required?.has(c.name) && (c.status !== "completed" || c.conclusion !== "success"),
  );

const allowed = (s: GithubStore, kind: Kind, r: StandInRequest) =>
  kind === "merge-async"
    ? r.json.merge_action === "merge_queue" && s.mergeSettings.queue
    : s.mergeSettings.methods.includes(r.json.merge_method);

/** Why a pull request cannot be merged at `sha` the way the request asks; undefined when it can. */
async function blocker(s: GithubStore, pr: StoredPull, kind: Kind, r: StandInRequest) {
  if (pr.state !== "open" || pr.draft) {
    return refused("Pull Request is not mergeable");
  }

  const sha = await headSha(s, pr);
  if (r.json.sha !== sha) {
    return {
      status: 409,
      body: { message: "Head branch was modified. Review and try the merge again." },
    };
  }

  if (!allowed(s, kind, r)) {
    return refused("Merge method not allowed");
  }

  const conflicts = await s.backend.conflicts(pr.base.ref, pr.head.ref);
  return conflicts || pendingChecks(s, pr, sha).length > 0
    ? refused("Required status check is expected.")
    : undefined;
}

const approvals = (s: GithubStore, pr: StoredPull) =>
  [...s.reviews.values()].filter((r) => r.prNumber === pr.number && r.state === "APPROVED").length;

/** Queues a pull request once the branch's rules have the approvals they ask for, and turns on its auto-merge. */
function enqueueRoute(s: GithubStore, pr: StoredPull, actor: string) {
  if (approvals(s, pr) < requiredApprovals(s.branch)) {
    return refused("The ruleset requires an approving review first.");
  }

  pr.auto_merge = { merge_method: "merge" };
  enqueue(s, pr, actor);
  return { status: 202, body: { status: "enqueued" } };
}

/** Merging a pull request directly, or through the merge queue. */
export function mergeRoutes(s: GithubStore, auth: GithubAuth, repo: string): Route[] {
  return (["merge", "merge-async"] as const).map((kind): Route => ({
    method: "PUT",
    path: `${repo}/pulls/:n/${kind}`,
    handler: async (r) => {
      const pr = pullOf(s, r.params["n"]);
      if (!pr) {
        return NOT_FOUND;
      }

      const blocked = await blocker(s, pr, kind, r);
      if (blocked) {
        return blocked;
      }

      const actor = auth.actorOf(r) ?? "unknown";
      if (kind === "merge-async") {
        return enqueueRoute(s, pr, actor);
      }

      const sha = await headSha(s, pr);
      await mergePull(s, pr, actor, `Merge pull request #${pr.number}`);
      return { merged: true, sha };
    },
  }));
}
