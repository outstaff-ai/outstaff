import type { NewSeedPullRequest, VcsSeed } from "@outstaff/core/contracts";
import type { PullRequest, RepoRef, VcsPermission } from "@outstaff/core";
import { createStubFetch, type Route, type StubRequest } from "./http-stub.js";

/** A stateful stand-in for the parts of GitHub the adapter talks to, served through the route-table stub. */

interface Pr {
  number: number;
  title: string;
  body: string;
  login: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  mergeable: PullRequest["mergeable"][];
  updatedAt: string;
}

interface Thread {
  id: string;
  prNumber: number;
  resolved: boolean;
  path: string | undefined;
  line: number | undefined;
  comments: { id: string; author: string; body: string }[];
}

export const OWN_APP = 201;
export const OFFICE_APP = 100;
const installationOf = (appId: number) => appId + 1000;

const appOf = (req: StubRequest): number => {
  const token = req.headers.get("authorization")!.slice("Bearer ".length);
  return Number(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).iss);
};

/** Installation tokens are issued as `tok_<person>`; the office's is `tok_office`. */
const actorOf = (req: StubRequest): string => {
  const token = req.headers.get("authorization")!.slice("Bearer ".length);
  return token.startsWith("tok_") ? token.slice(4) : "unknown";
};

const personOf = (appId: number) => (appId === OWN_APP ? "sam" : undefined);

const toNode = (t: Thread) => ({
  id: t.id,
  isResolved: t.resolved,
  path: t.path ?? null,
  line: t.line ?? null,
  originalLine: null,
  comments: {
    nodes: t.comments.map((c) => ({ id: c.id, body: c.body, author: { login: c.author } })),
  },
});

export function createGithubFake(repo: RepoRef = { owner: "acme", name: "app" }) {
  let tick = 0;
  let eventId = 1000;
  let sha = 0;
  let thread = 0;
  const prs = new Map<number, Pr>();
  const checks = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  const threads = new Map<string, Thread>();
  const perms = new Map<string, VcsPermission>();
  const events: Record<string, unknown>[] = [];
  const clockIso = () => new Date(Date.parse("2026-01-01T00:00:00Z") + ++tick * 1000).toISOString();

  const emit = (type: string, actor: string, payload: Record<string, unknown>) => {
    events.unshift({
      id: String(++eventId),
      type,
      actor: { login: actor },
      created_at: clockIso(),
      payload,
    });
  };

  const need = (n: number): Pr => {
    const pr = prs.get(n);
    if (!pr) {
      throw Object.assign(new Error("not found"), { notFound: true });
    }

    return pr;
  };

  const rest = (pr: Pr) => {
    const next = pr.mergeable.length > 1 ? pr.mergeable.shift()! : (pr.mergeable[0] ?? "unknown");
    return {
      number: pr.number,
      node_id: `PR_${pr.number}`,
      title: pr.title,
      body: pr.body,
      user: { login: pr.login },
      head: pr.head,
      base: pr.base,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? pr.updatedAt : null,
      draft: pr.draft,
      updated_at: pr.updatedAt,
      mergeable:
        pr.state !== "open"
          ? null
          : next === "clean"
            ? true
            : next === "conflicting"
              ? false
              : null,
      mergeable_state:
        pr.state !== "open"
          ? "unknown"
          : next === "clean"
            ? "clean"
            : next === "conflicting"
              ? "dirty"
              : "unknown",
    };
  };

  const domain = (pr: Pr): PullRequest => ({
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: `https://github.example/${repo.owner}/${repo.name}/pull/${pr.number}`,
    author: { login: pr.login, kind: pr.login.endsWith("[bot]") ? "agent" : "human" },
    head: pr.head,
    base: pr.base,
    state: pr.merged ? "merged" : pr.state,
    draft: pr.draft,
    mergeable: "unknown",
    updatedAt: pr.updatedAt,
  });

  const touch = (pr: Pr) => void (pr.updatedAt = clockIso());
  const prPayload = (pr: Pr, action: string) => ({
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      merged: pr.merged,
      head: pr.head,
      base: pr.base,
    },
  });

  const etag = () => `W/"${eventId}"`;

  const routes: Route[] = [
    {
      method: "GET",
      path: "/app/installations",
      handler: (r) => [{ id: installationOf(appOf(r)), account: { login: repo.owner } }],
    },
    {
      method: "POST",
      path: "/app/installations/:id/access_tokens",
      handler: (r) => {
        const person = personOf(Number(r.params["id"]) - 1000);
        // An App with no seeded permission is fully granted; seeding a lower level withdraws it.
        const level = person ? (perms.get(person) ?? "write") : "write";
        const wantsWrite = r.json?.permissions?.contents === "write";
        const allowed = wantsWrite ? level === "write" || level === "admin" : level !== "none";
        if (!allowed) {
          return {
            status: 422,
            body: { message: "The permissions requested are not granted to this installation." },
          };
        }

        return {
          status: 201,
          body: { token: `tok_${person ?? "office"}`, expires_at: "2099-01-01T00:00:00Z" },
        };
      },
    },
    {
      method: "GET",
      path: "/app",
      handler: (r) => ({ slug: personOf(appOf(r)) ?? "acme-office" }),
    },
    {
      method: "GET",
      path: "/users/:login",
      handler: (r) => ({ id: 5000 + r.params["login"]!.length }),
    },
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
      handler: () => ({ default_branch: "main" }),
    },
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/pulls`,
      handler: (r) => {
        const b = r.json;
        const number = prs.size + 1;
        const pr: Pr = {
          number,
          title: b.title,
          body: b.body ?? "",
          login: `${actorOf(r)}[bot]`,
          head: { ref: b.head, sha: (++sha).toString(16).padStart(40, "0") },
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
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const actor = `${actorOf(r)}[bot]`;
        const state = {
          APPROVE: "APPROVED",
          REQUEST_CHANGES: "CHANGES_REQUESTED",
          COMMENT: "COMMENTED",
        }[r.json.event as string];

        if (!state) {
          return { status: 422, body: { message: "Unprocessable: bad event" } };
        }

        for (const c of r.json.comments ?? []) {
          const id = `PRRT_${++thread}`;
          threads.set(id, {
            id,
            prNumber: pr.number,
            resolved: false,
            path: c.path,
            line: c.line,
            comments: [{ id: `${id}_c0`, author: actor, body: c.body }],
          });
        }

        emit("PullRequestReviewEvent", actor, {
          action: "submitted",
          pull_request: { number: pr.number },
          review: { id: eventId, state, body: r.json.body },
        });

        return { status: 200, body: { id: eventId, state } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return r.headers.get("accept") === "application/vnd.github.diff"
          ? {
              text: `diff --git a/${pr.head.ref}.txt b/${pr.head.ref}.txt\n--- a/${pr.head.ref}.txt\n+++ b/${pr.head.ref}.txt\n@@ -1 +1 @@\n-old\n+new\n`,
            }
          : rest(pr);
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/:sha/check-runs`,
      handler: (r) => ({
        check_runs: (checks.get(r.params["sha"]!) ?? []).map((c) => ({
          ...c,
          html_url: `https://github.example/runs/${c.name}`,
        })),
      }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/commits/:sha/status`,
      handler: () => ({ statuses: [] }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/collaborators/:login/permission`,
      handler: (r) => ({ permission: perms.get(r.params["login"]!) ?? "none" }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/events`,
      handler: (r) =>
        r.headers.get("if-none-match") === etag()
          ? { status: 304 }
          : { headers: { etag: etag() }, body: events },
    },
    {
      method: "POST",
      path: "/graphql",
      handler: (r) => {
        const { query, variables } = r.json as { query: string; variables: Record<string, any> }; // oxlint-disable-line no-explicit-any
        if (query.includes("reviewThreads(")) {
          const nodes = [...threads.values()]
            .filter((t) => t.prNumber === variables["number"])
            .map(toNode);

          return {
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
                },
              },
            },
          };
        }

        if (query.includes("addPullRequestReviewThreadReply")) {
          const t = threads.get(variables["id"]);
          if (!t) {
            return {
              data: null,
              errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node" }],
            };
          }

          t.comments.push({
            id: `${t.id}_c${t.comments.length}`,
            author: `${actorOf(r)}[bot]`,
            body: variables["body"],
          });

          return { data: { addPullRequestReviewThreadReply: { comment: { id: t.id } } } };
        }

        if (
          query.includes("PullRequestForReview") ||
          /markPullRequestReadyForReview|convertPullRequestToDraft/.test(query)
        ) {
          const pr = prs.get(Number(String(variables["id"]).slice("PR_".length)));
          if (pr) {
            pr.draft = query.includes("convertPullRequestToDraft");
          }

          return { data: { pullRequest: { id: variables["id"], isDraft: pr?.draft ?? false } } };
        }

        if (query.startsWith("mutation")) {
          const t = threads.get(variables["id"]);
          if (t) {
            t.resolved = true;
          }

          return {
            data: { resolveReviewThread: { thread: { id: variables["id"], isResolved: true } } },
          };
        }

        const t = threads.get(variables["id"]);
        return {
          data: {
            node: t
              ? {
                  ...toNode(t),
                  comments: {
                    nodes: t.comments.slice(-1).map((c) => ({ author: { login: c.author } })),
                  },
                }
              : null,
          },
        };
      },
    },
  ];

  const stub = createStubFetch(routes);

  const seed: VcsSeed = {
    repo,
    selfLogin: "sam",
    async pullRequest(_repo, p: NewSeedPullRequest) {
      const number = prs.size + 1;
      const login = (p.author?.login ?? "sam") + (p.author?.kind === "agent" ? "[bot]" : "");
      const pr: Pr = {
        number,
        title: p.title,
        body: p.body ?? "",
        login,
        head: {
          ref: p.head?.ref ?? `feat/${number}`,
          sha: p.head?.sha ?? (++sha).toString(16).padStart(40, "0"),
        },
        base: { ref: p.base?.ref ?? "main" },
        state: "open",
        merged: false,
        draft: p.draft ?? false,
        mergeable: p.mergeable ?? ["clean"],
        updatedAt: clockIso(),
      };

      prs.set(number, pr);
      emit("PullRequestEvent", login, prPayload(pr, "opened"));
      return domain(pr);
    },
    async push(_repo, number, actor) {
      const pr = need(number);
      pr.head = { ...pr.head, sha: (++sha).toString(16).padStart(40, "0") };
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "synchronize"));
      return domain(pr);
    },
    async merge(_repo, number, actor) {
      const pr = need(number);
      Object.assign(pr, { state: "closed", merged: true });
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "closed"));
      return domain(pr);
    },
    async close(_repo, number, actor) {
      const pr = need(number);
      pr.state = "closed";
      touch(pr);
      emit("PullRequestEvent", actor, prPayload(pr, "closed"));
      return domain(pr);
    },
    async review(_repo, number, actor, state) {
      emit("PullRequestReviewEvent", actor, {
        action: "submitted",
        pull_request: { number },
        review: { id: eventId, state: state.toUpperCase(), body: "" },
      });
    },
    async comment(_repo, number, actor, body) {
      emit("IssueCommentEvent", actor, {
        action: "created",
        issue: { number, pull_request: {} },
        comment: { id: eventId, body },
      });
    },
    async thread(_repo, number, t) {
      const id = `PRRT_${++thread}`;
      threads.set(id, {
        id,
        prNumber: number,
        resolved: false,
        path: t.path,
        line: t.line,
        comments: t.comments.map((c, i) => ({ id: `${id}_c${i}`, ...c })),
      });

      return id;
    },
    async check(_repo, shaValue, c) {
      const list = checks.get(shaValue) ?? [];
      const conclusion =
        c.status === "success"
          ? "success"
          : c.status === "failure"
            ? "failure"
            : c.status === "neutral"
              ? "neutral"
              : null;

      list.push({
        name: c.name,
        status: c.status === "pending" ? "in_progress" : "completed",
        conclusion,
      });

      checks.set(shaValue, list);
    },
    async permission(_repo, login, level) {
      perms.set(login, level);
    },
    forbiddenCall: () => vcsRef.getPullRequest({ owner: repo.owner, name: "private" }, 1),
  };

  // Bound once the adapter exists.
  const vcsRef = {} as { getPullRequest(repo: RepoRef, n: number): Promise<unknown> };

  return {
    fetch: stub.fetch,
    seed,
    bind: (v: { getPullRequest(repo: RepoRef, n: number): Promise<unknown> }) =>
      void Object.assign(vcsRef, v),
  };
}
