import { actorOf } from "./requests.js";
import type {
  FakeState,
  Route,
  StoredCheckRun,
  StoredPull,
  StubReply,
  StubRequest,
} from "../types.js";

/** Whether the request asks for a merge the repository's settings allow. */
function methodAllowed(s: FakeState, r: StubRequest, queue: boolean): boolean {
  return queue
    ? r.json.merge_action === "merge_queue" && s.mergeSettings.queue
    : s.mergeSettings.methods.includes(r.json.merge_method);
}

/** A required check that has not passed (yet). */
const isOpenRequired = (pr: StoredPull, c: StoredCheckRun): boolean =>
  Boolean(pr.required?.has(c.name)) && (c.status !== "completed" || c.conclusion !== "success");

/** Why GitHub refuses to merge the pull request; undefined when it merges. */
function mergeRefusal(
  s: FakeState,
  pr: StoredPull,
  r: StubRequest,
  queue: boolean,
): StubReply | undefined {
  if (pr.state !== "open") {
    return { status: 405, body: { message: "Pull Request is not mergeable" } };
  }

  if (r.json.sha !== pr.head.sha) {
    return {
      status: 409,
      body: { message: "Head branch was modified. Review and try the merge again." },
    };
  }

  if (!methodAllowed(s, r, queue)) {
    return { status: 405, body: { message: "Merge method not allowed" } };
  }

  const open = (s.checks.get(pr.head.sha) ?? []).filter((c) => isOpenRequired(pr, c));
  if (pr.draft || open.length > 0 || pr.mergeable[0] === "conflicting") {
    return { status: 405, body: { message: "Required status check is expected." } };
  }

  return undefined;
}

/** Listing, reading the repository of, merging, opening and editing pull requests. */
export function pullRoutes(s: FakeState): Route[] {
  const { repo, counters: n, prs, emit, rest, touch, prPayload, clockIso } = s;
  return [
    {
      method: "GET",
      path: `/repos/${repo.owner}/private/pulls/:n`,
      handler: () => ({ status: 403, body: { message: "Resource not accessible by integration" } }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      handler: (r) =>
        [...prs.values()]
          .filter((p) => r.query.get("state") === "all" || p.state === "open")
          .map((p) => ({ ...rest(p), mergeable: undefined, mergeable_state: undefined })),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}`,
      handler: () => ({
        default_branch: "main",
        allow_merge_commit: s.mergeSettings.methods.includes("merge"),
        allow_squash_merge: s.mergeSettings.methods.includes("squash"),
      }),
    },
    ...(["merge", "merge-async"] as const).map((kind): Route => ({
      method: "PUT",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/${kind}`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const queue = kind === "merge-async";
        const refusal = mergeRefusal(s, pr, r, queue);
        if (refusal) {
          return refusal;
        }

        if (queue) {
          return { status: 202, body: { status: "enqueued" } };
        }

        Object.assign(pr, { state: "closed", merged: true });
        touch(pr);
        emit("PullRequestEvent", actorOf(r), prPayload(pr, "closed"));
        return { merged: true, sha: pr.head.sha };
      },
    })),
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      handler: (r) => {
        const b = r.json;
        const number = prs.size + 1;
        const pr: StoredPull = {
          number,
          title: b.title,
          body: b.body ?? "",
          login: `${actorOf(r)}[bot]`,
          head: { ref: b.head, sha: (++n.sha).toString(16).padStart(40, "0") },
          base: { ref: b.base },
          state: "open",
          merged: false,
          draft: b.draft === true,
          mergeable: ["clean"],
          updatedAt: clockIso(),
        };

        prs.set(number, pr);
        emit("PullRequestEvent", pr.login, prPayload(pr, "opened"));
        return { status: 201, body: rest(pr) };
      },
    },
    {
      method: "PATCH",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        for (const k of ["title", "body"] as const) {
          if (typeof r.json[k] === "string") {
            pr[k] = r.json[k];
          }
        }

        if (typeof r.json.base === "string") {
          pr.base = { ref: r.json.base };
        }

        touch(pr);
        return rest(pr);
      },
    },
  ];
}
