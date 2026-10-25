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
  comments: { id: string; databaseId: number; author: string; body: string }[];
}

interface StoredReview {
  prNumber: number;
  author: string;
  state: string;
  body: string;
  at: string;
  comments: { databaseId: number; path: string; line: number; body: string }[];
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
    nodes: t.comments.map((c) => ({
      id: c.id,
      databaseId: c.databaseId,
      body: c.body,
      author: { login: c.author },
    })),
  },
});

const LOG_ORIGIN = "https://logs.github.test";

export function createGithubFake(repo: RepoRef = { owner: "acme", name: "app" }) {
  let tick = 0;
  let eventId = 1000;
  let sha = 0;
  let thread = 0;
  let reviewCounter = 0;
  let commentCounter = 0;
  const prs = new Map<number, Pr>();
  const checks = new Map<
    string,
    { id: number; name: string; status: string; conclusion: string | null; job?: boolean }[]
  >();

  // Actions jobs by id (the id of their check run): steps with their conclusion, and the raw log text.
  const jobs = new Map<number, { steps: { name: string; conclusion: string }[]; log: string }>();
  let checkId = 5000;
  const threads = new Map<string, Thread>();
  const reviews = new Map<number, StoredReview>();
  const perms = new Map<string, VcsPermission>();

  // Conversation comment ids, and the reactions on a comment (`<endpoint>:<id>` -> `<login>:<content>`).
  const issueComments = new Map<
    number,
    { prNumber: number; author: string; body: string; at: string }
  >();

  const reactions = new Map<string, Set<string>>();
  const inlineIds = () =>
    new Set([
      ...[...threads.values()].flatMap((t) => t.comments.map((c) => c.databaseId)),
      ...[...reviews.values()].flatMap((r) => r.comments.map((c) => c.databaseId)),
    ]);

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

  /** A batch review the way the host reports it: each inline comment is announced while it is pending, then the review. */
  const submitReview = (
    prNumber: number,
    actor: string,
    state: string,
    body: string,
    inline: { path: string; line: number; body: string }[],
  ): number => {
    const id = ++reviewCounter;
    const stored: StoredReview = {
      prNumber,
      author: actor,
      state,
      body,
      at: clockIso(),
      comments: [],
    };

    reviews.set(id, stored);
    for (const c of inline) {
      const threadId = `PRRT_${++thread}`;
      const databaseId = ++commentCounter;
      threads.set(threadId, {
        id: threadId,
        prNumber,
        resolved: false,
        path: c.path,
        line: c.line,
        comments: [{ id: `${threadId}_c0`, databaseId, author: actor, body: c.body }],
      });

      stored.comments.push({ databaseId, ...c });
      emit("PullRequestReviewCommentEvent", actor, {
        action: "created",
        pull_request: { number: prNumber },
        comment: {
          id: databaseId,
          body: c.body,
          path: c.path,
          pull_request_review_id: id,
          html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${prNumber}#discussion_r${databaseId}`,
        },
      });
    }

    emit("PullRequestReviewEvent", actor, {
      action: "submitted",
      pull_request: { number: prNumber },
      review: { id, state, body },
    });

    return id;
  };

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

        const id = submitReview(pr.number, actor, state, r.json.body, r.json.comments ?? []);

        return { status: 200, body: { id, state } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews/:id/comments`,
      handler: (r) => {
        const review = reviews.get(Number(r.params["id"]));
        if (!review || review.prNumber !== Number(r.params["n"])) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return review.comments.map((c) => ({
          id: c.databaseId,
          path: c.path,
          line: c.line,
          body: c.body,
          html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${review.prNumber}#discussion_r${c.databaseId}`,
        }));
      },
    },
    {
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/issues/:n/comments`,
      handler: (r) => {
        const pr = prs.get(Number(r.params["n"]));
        if (!pr) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const id = ++commentCounter;
        issueComments.set(id, {
          prNumber: pr.number,
          author: `${actorOf(r)}[bot]`,
          body: r.json.body,
          at: clockIso(),
        });

        emit("IssueCommentEvent", `${actorOf(r)}[bot]`, {
          action: "created",
          issue: { number: pr.number, pull_request: {} },
          comment: { id, body: r.json.body },
        });

        return { status: 201, body: { id } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/issues/:n/comments`,
      handler: (r) => {
        const n = Number(r.params["n"]);
        if (!prs.has(n)) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return [...issueComments]
          .filter(([, c]) => c.prNumber === n)
          .map(([id, c]) => ({
            id,
            user: { login: c.author },
            body: c.body,
            created_at: c.at,
            updated_at: c.at,
            html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${n}#issuecomment-${id}`,
          }));
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/pulls/:n/reviews`,
      handler: (r) => {
        const n = Number(r.params["n"]);
        if (!prs.has(n)) {
          return { status: 404, body: { message: "Not Found" } };
        }

        return [...reviews]
          .filter(([, v]) => v.prNumber === n)
          .map(([id, v]) => ({
            id,
            user: { login: v.author },
            body: v.body,
            state: v.state,
            submitted_at: v.at,
            html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${n}#pullrequestreview-${id}`,
          }));
      },
    },
    ...(["issues", "pulls"] as const).map((kind): Route => ({
      method: "POST",
      path: `/repos/${repo.owner}/${repo.name}/${kind}/comments/:id/reactions`,
      handler: (r) => {
        const id = Number(r.params["id"]);
        const known = kind === "issues" ? issueComments.has(id) : inlineIds().has(id);
        if (!known) {
          return { status: 404, body: { message: "Not Found" } };
        }

        const key = `${kind}:${id}`;
        const set = reactions.get(key) ?? new Set<string>();
        const entry = `${actorOf(r)}[bot]:${r.json.content}`;
        const created = !set.has(entry);
        set.add(entry);
        reactions.set(key, set);
        return { status: created ? 201 : 200, body: { id, content: r.json.content } };
      },
    })),
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
          details_url: c.job ? `https://github.example/acme/app/actions/runs/9/job/${c.id}` : null,
          app: { slug: c.job ? "github-actions" : "other-ci" },
        })),
      }),
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/actions/jobs/:id`,
      handler: (r) => {
        const job = jobs.get(Number(r.params["id"]));
        return job ? { steps: job.steps } : { status: 404, body: { message: "Not Found" } };
      },
    },
    {
      method: "GET",
      path: `/repos/${repo.owner}/${repo.name}/actions/jobs/:id/logs`,
      handler: (r) =>
        jobs.has(Number(r.params["id"]))
          ? { status: 302, headers: { location: `${LOG_ORIGIN}/logs/${r.params["id"]}?sig=abc` } }
          : { status: 404, body: { message: "Not Found" } },
    },
    {
      method: "GET",
      path: `${LOG_ORIGIN}/logs/:id`,
      handler: (r) => ({ text: jobs.get(Number(r.params["id"]))?.log ?? "" }),
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
            databaseId: ++commentCounter,
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
    async review(_repo, number, actor, state, body = "", comments = []) {
      return String(submitReview(number, actor, state.toUpperCase(), body, comments));
    },
    async comment(_repo, number, actor, body) {
      const id = ++commentCounter;
      issueComments.set(id, { prNumber: number, author: actor, body, at: clockIso() });
      emit("IssueCommentEvent", actor, {
        action: "created",
        issue: { number, pull_request: {} },
        comment: { id, body },
      });

      return String(id);
    },
    async reactions(_repo, target) {
      const kind = target.kind === "conversation_comment" ? "issues" : "pulls";
      return [...(reactions.get(`${kind}:${target.id}`) ?? [])].map((r) => {
        const [user, reaction] = r.split(":") as [string, string];
        return { user, reaction };
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
        comments: t.comments.map((c, i) => ({
          id: `${id}_c${i}`,
          databaseId: ++commentCounter,
          ...c,
        })),
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

      const id = ++checkId;
      list.push({
        id,
        name: c.name,
        status: c.status === "pending" ? "in_progress" : "completed",
        conclusion,
        ...(c.log ? { job: true } : {}),
      });

      if (c.log) {
        jobs.set(id, {
          steps: c.log.steps.map((st) => ({
            name: st.name,
            conclusion: st.failed ? "failure" : "success",
          })),
          log: c.log.steps
            .flatMap((st, i) => [
              `2026-01-01T00:00:0${i}.0000000Z ##[group]${st.name}`,
              `2026-01-01T00:00:0${i}.0000000Z ##[endgroup]`,
              ...st.lines.map((l) => `2026-01-01T00:00:0${i}.1000000Z ${l}`),
              ...(st.failed
                ? [`2026-01-01T00:00:0${i}.2000000Z ##[error]Process completed with exit code 1.`]
                : []),
            ])
            .join("\n"),
        });
      }

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
