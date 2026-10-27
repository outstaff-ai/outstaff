import type { Route } from "@outstaff/testing.http";
import { NOT_FOUND, UNAUTHORIZED, emit, prPayload, pullOf, rest, touch } from "./model.js";
import type { GithubAuth, GithubStore, StoredPull } from "./types.js";

const DIFF = "application/vnd.github.diff";

/** Listing, opening, reading (or diffing) and editing pull requests, and the repository's settings. */
export function pullRoutes(s: GithubStore, auth: GithubAuth, repo: string): Route[] {
  const pulls = `${repo}/pulls`;
  return [
    {
      method: "GET",
      path: pulls,
      handler: async (r) =>
        Promise.all(
          [...s.prs.values()]
            .filter((p) => r.query.get("state") === "all" || p.state === "open")
            .map(async (p) => ({
              ...(await rest(s, p)),
              mergeable: undefined,
              mergeable_state: undefined,
            })),
        ),
    },
    {
      method: "GET",
      path: repo,
      handler: () => ({
        default_branch: "main",
        allow_merge_commit: s.mergeSettings.methods.includes("merge"),
        allow_squash_merge: s.mergeSettings.methods.includes("squash"),
      }),
    },
    { method: "POST", path: pulls, handler: (r) => open(s, auth.actorOf(r), r.json) },
    {
      method: "PATCH",
      path: `${pulls}/:n`,
      handler: async (r) => {
        const pr = pullOf(s, r.params["n"]);
        return pr ? edit(s, pr, r.json) : NOT_FOUND;
      },
    },
    {
      method: "GET",
      path: `${pulls}/:n`,
      handler: async (r) => {
        const pr = pullOf(s, r.params["n"]);
        if (!pr) {
          return NOT_FOUND;
        }

        return r.headers.get("accept") === DIFF
          ? { text: await s.backend.diff(pr.base.ref, pr.head.ref) }
          : rest(s, pr);
      },
    },
  ];
}

interface NewPull {
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
}

async function open(s: GithubStore, actor: string | undefined, b: NewPull) {
  if (!actor) {
    return UNAUTHORIZED;
  }

  const sha = await s.backend.sha(b.head);
  if (!sha) {
    return { status: 422, body: { message: `Head ref ${b.head} does not exist.` } };
  }

  const pr: StoredPull = {
    number: s.prs.size + 1,
    title: b.title,
    body: b.body ?? "",
    login: actor,
    head: { ref: b.head, sha },
    base: { ref: b.base },
    state: "open",
    merged: false,
    draft: b.draft === true,
    forcePushes: 0,
    updatedAt: s.now(),
  };

  s.prs.set(pr.number, pr);
  emit(s, "PullRequestEvent", actor, await prPayload(s, pr, "opened"));
  return { status: 201, body: await rest(s, pr) };
}

async function edit(s: GithubStore, pr: StoredPull, b: Partial<NewPull>) {
  for (const k of ["title", "body"] as const) {
    if (typeof b[k] === "string") {
      pr[k] = b[k];
    }
  }

  if (typeof b.base === "string") {
    pr.base = { ref: b.base };
  }

  touch(s, pr);
  return rest(s, pr);
}
