import { createPublicKey, verify } from "node:crypto";
import { BareRepo } from "./git.ts";
import type { Req, Route } from "./http.ts";
import type {
  RequiredChecksData,
  RestCheckRun,
  RestEvent,
  RestIssueComment,
  RestPull,
  RestReview,
  RestReviewComment,
  ThreadNode,
  ThreadsData,
} from "@outstaff/integration.vcs.github";
import type {
  StoredIssueComment,
  StoredReview,
  StoredThread as FakeStoredThread,
  StoredThreadComment,
} from "@outstaff/testing.github";

/**
 * The parts of GitHub the vcs adapter and git use: the App and installation endpoints, pull requests, reviews,
 * review threads (GraphQL), the events feed, and a smart-HTTP git remote. State is in memory; the repository is real.
 */

/** A pull request: `head` and `base` are branch names, the head commit is read from the repository. */
type StoredPull = Pick<RestPull, "number" | "title" | "state"> &
  Required<Pick<RestPull, "merged" | "draft">> & {
    body: NonNullable<RestPull["body"]>;
    login: NonNullable<RestPull["user"]>["login"];
    head: RestPull["head"]["ref"];
    base: RestPull["base"]["ref"];
    lastSha: RestPull["head"]["sha"];

    /** Pushes that did not build on the previous head. */
    forcePushes: number;

    /** Top-level comments on the conversation. */
    conversation: (Pick<RestIssueComment, "id"> &
      Omit<StoredIssueComment, "prNumber"> & { seq: number })[];
    updatedAt: RestPull["updated_at"];

    /** Taken into the merge queue by `merge-async`; the stub then merges it as the host's queue would. */
    queued?: boolean;
  };

type StoredThread = Omit<FakeStoredThread, "comments"> & {
  comments: (StoredThreadComment & { seq: number })[];
};

type Json = Record<string, any>; // oxlint-disable-line no-explicit-any

export interface GithubOptions {
  repo: BareRepo;

  /** Further repositories of the same owner, served over git only (clone, fetch, push). */
  more?: BareRepo[];

  /** App id to slug. The slug is what `GET /app` answers and the login of its pull requests, plus `[bot]`. */
  apps: Record<string, string>;

  /** PEM public half of the key the Apps sign their JWTs with. */
  publicKey: string;

  /** Login to permission level, for `collaborators/:login/permission`. */
  permissions: Record<string, string>;
}

const API = "/api/v3";
// Strictly increasing, so that two things written one after the other are told apart by time alone.
let lastMs = 0;
const now = () => new Date((lastMs = Math.max(Date.now(), lastMs + 1))).toISOString();
const bearer = (req: Req): string =>
  String(req.headers["authorization"] ?? "").replace(/^[Bb]earer /, "");

export function createGithub(opts: GithubOptions) {
  const { repo } = opts;
  const full = `${repo.owner}/${repo.name}`;
  const key = createPublicKey(opts.publicKey);
  const prs = new Map<number, StoredPull>();
  const threads = new Map<string, StoredThread>();
  const reviews = new Map<number, StoredReview>();
  const events: RestEvent[] = [];
  const tokens = new Map<string, { slug: string; write: boolean }>();
  let eventId = 1000;
  let threadId = 0;
  let reviewId = 0;
  let commentId = 0;
  // Orders what the agent does on GitHub, so a test can tell a reaction from the reply that follows it.
  let seq = 0;
  const reactions: {
    kind: "conversation_comment" | "inline_comment";
    commentId: number;
    user: string;
    content: string;
    seq: number;
  }[] = [];

  let tokenId = 0;
  const etag = () => `W/"${eventId}"`;

  const emit = (type: string, actor: string, payload: Json) => {
    events.unshift({
      id: String(++eventId),
      type,
      actor: { login: actor },
      created_at: now(),
      payload,
    });
  };

  /** The App behind a JWT signed with the test key; undefined when it is not one. */
  const appOf = (token: string): string | undefined => {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) {
      return undefined;
    }

    try {
      if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) {
        return undefined;
      }

      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Json;
      return opts.apps[String(claims["iss"])] === undefined ? undefined : String(claims["iss"]);
    } catch {
      return undefined;
    }
  };

  const unauthorized = { status: 401, body: { message: "Bad credentials" } };

  /** The login behind an installation token, with `[bot]`. */
  const botOf = (req: Req): string | undefined => {
    const t = tokens.get(bearer(req));
    return t ? `${t.slug}[bot]` : undefined;
  };

  const rest = async (pr: StoredPull) => {
    const sha = (await repo.sha(pr.head)) ?? pr.lastSha;
    const open = pr.state === "open";
    const clean = open ? await repo.mergeable(pr.base, pr.head) : undefined;
    return {
      number: pr.number,
      node_id: `PR_${pr.number}`,
      title: pr.title,
      body: pr.body,
      user: { login: pr.login },
      head: { ref: pr.head, sha },
      base: { ref: pr.base },
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? pr.updatedAt : null,
      draft: pr.draft,
      requested_reviewers: [],
      updated_at: pr.updatedAt,
      mergeable: open ? clean : null,
      mergeable_state: open ? (clean ? "clean" : "dirty") : "unknown",
    };
  };

  const prPayload = async (pr: StoredPull, action: string) => {
    const r = await rest(pr);
    return {
      action,
      number: pr.number,
      pull_request: {
        number: pr.number,
        title: pr.title,
        merged: pr.merged,
        head: r.head,
        base: r.base,
      },
    };
  };

  const toNode = (t: StoredThread): ThreadNode => ({
    id: t.id,
    isResolved: t.resolved,
    path: t.path ?? null,
    line: t.line ?? null,
    originalLine: null,
    // GraphQL names an App without the `[bot]` suffix REST adds.
    comments: {
      nodes: t.comments.map((c) => ({
        id: c.id,
        databaseId: c.databaseId,
        body: c.body,
        author: { login: c.author.replace(/\[bot\]$/, "") },
      })),
    },
  });

  const REVIEW_STATE: Record<string, string> = {
    APPROVE: "APPROVED",
    REQUEST_CHANGES: "CHANGES_REQUESTED",
    COMMENT: "COMMENTED",
  };

  /**
   * A review the way GitHub reports it: each inline comment is announced when it is written, while the review is
   * still pending, and the review itself only when it is submitted.
   */
  async function submitReview(
    pr: StoredPull,
    actor: string,
    event: string,
    body: string,
    comments?: Json[],
  ): Promise<number> {
    const id = ++reviewId;
    const review: StoredReview = {
      prNumber: pr.number,
      author: actor,
      state: REVIEW_STATE[event] ?? event,
      body,
      at: now(),
      commitId: (await repo.sha(pr.head)) ?? pr.lastSha,
      comments: [],
    };

    reviews.set(id, review);

    for (const c of comments ?? []) {
      const thread = `PRRT_${++threadId}`;
      const databaseId = ++commentId;
      threads.set(thread, {
        id: thread,
        prNumber: pr.number,
        resolved: false,
        path: c.path,
        line: c.line,
        comments: [{ id: `${thread}_c0`, databaseId, seq: ++seq, author: actor, body: c.body }],
      });

      review.comments.push({ databaseId, path: c.path, line: c.line, body: c.body });
      pr.updatedAt = now();
      emit("PullRequestReviewCommentEvent", actor, {
        action: "created",
        pull_request: { number: pr.number },
        comment: {
          id: databaseId,
          body: c.body,
          path: c.path,
          pull_request_review_id: id,
          html_url: `https://github.example/${full}/pull/${pr.number}#discussion_r${databaseId}`,
        },
      });
    }

    pr.updatedAt = now();
    emit("PullRequestReviewEvent", actor, {
      action: "submitted",
      pull_request: { number: pr.number },
      review: {
        id,
        state: REVIEW_STATE[event],
        body,
        html_url: `https://github.example/${full}/pull/${pr.number}#pullrequestreview-${id}`,
      },
    });

    return id;
  }

  /** After a push: a pull request whose branch moved gets a `synchronize` event, as on GitHub. */
  async function syncHeads(actor: string): Promise<void> {
    for (const pr of prs.values()) {
      const sha = await repo.sha(pr.head);
      if (pr.state === "open" && sha && sha !== pr.lastSha) {
        if (!(await repo.isAncestor(pr.lastSha, sha))) {
          pr.forcePushes += 1;
        }

        pr.lastSha = sha;
        pr.updatedAt = now();
        emit("PullRequestEvent", actor, await prPayload(pr, "synchronize"));
      }
    }
  }

  const need = (n: string | number): StoredPull | undefined => prs.get(Number(n));
  const notFound = { status: 404, body: { message: "Not Found" } };

  const graphql = (req: Req) => {
    const { query, variables } = req.json as { query: string; variables: Json };
    const actor = botOf(req) ?? "unknown";
    if (query.includes("reviewThreads(")) {
      const nodes = [...threads.values()]
        .filter((t) => t.prNumber === variables["number"])
        .map(toNode);

      const data: ThreadsData = {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      };

      return { data };
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
        databaseId: ++commentId,
        seq: ++seq,
        author: actor,
        body: variables["body"],
      });

      return { data: { addPullRequestReviewThreadReply: { comment: { id: t.id } } } };
    }

    if (/markPullRequestReadyForReview|convertPullRequestToDraft/.test(query)) {
      const pr = need(String(variables["id"]).slice("PR_".length));
      if (pr) {
        pr.draft = query.includes("convertPullRequestToDraft");
      }

      return { data: { pullRequest: { id: variables["id"], isDraft: pr?.draft ?? false } } };
    }

    if (query.includes("statusCheckRollup")) {
      // No check is required in this repository.
      const data: RequiredChecksData = {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                    },
                  },
                },
              ],
            },
          },
        },
      };

      return { data };
    }

    if (query.includes("mergeQueue(")) {
      return { data: { repository: { mergeQueue: { id: "MQ_1" } } } };
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
        node: t ? { ...toNode(t), comments: { nodes: toNode(t).comments.nodes.slice(-1) } } : null,
      },
    };
  };

  const pulls = `${API}/repos/${full}/pulls`;
  const checkRuns = new Map<string, RestCheckRun[]>();
  const routes: Route[] = [
    {
      method: "GET",
      path: `${API}/app/installations`,
      handler: (r) => {
        const id = appOf(bearer(r));
        return id ? [{ id: Number(id) + 1000, account: { login: repo.owner } }] : unauthorized;
      },
    },
    {
      method: "POST",
      path: `${API}/app/installations/:id/access_tokens`,
      handler: (r) => {
        const app = String(Number(r.params["id"]) - 1000);
        if (appOf(bearer(r)) !== app) {
          return unauthorized;
        }

        const token = `ghs_${opts.apps[app]}_${++tokenId}`;
        tokens.set(token, {
          slug: opts.apps[app]!,
          write: r.json?.permissions?.contents === "write",
        });

        return {
          status: 201,
          body: { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        };
      },
    },
    {
      method: "GET",
      path: `${API}/app`,
      handler: (r) => {
        const id = appOf(bearer(r));
        return id ? { slug: opts.apps[id] } : unauthorized;
      },
    },
    {
      method: "GET",
      path: `${API}/users/:login`,
      handler: (r) => ({ id: 5000 + r.params["login"]!.length }),
    },
    {
      method: "GET",
      path: `${API}/repos/${full}`,
      handler: () => ({
        default_branch: "main",
        allow_merge_commit: true,
        allow_squash_merge: true,
      }),
    },
    ...(["merge", "merge-async"] as const).map((kind): Route => ({
      method: "PUT",
      path: `${pulls}/:n/${kind}`,
      handler: async (r) => {
        const pr = need(r.params["n"]!);
        if (!pr) {
          return notFound;
        }

        if (pr.state !== "open" || pr.draft) {
          return { status: 405, body: { message: "Pull Request is not mergeable" } };
        }

        const sha = (await repo.sha(pr.head)) ?? pr.lastSha;
        if (r.json.sha !== sha) {
          return { status: 409, body: { message: "Head branch was modified." } };
        }

        const actor = botOf(r) ?? "unknown";
        if (kind === "merge-async") {
          if (r.json.merge_action !== "merge_queue") {
            return { status: 422, body: { message: "merge_action must be merge_queue" } };
          }

          pr.queued = true;
          // The queue passes a moment later and the host merges the pull request.
          setTimeout(() => {
            void (async () => {
              await repo.merge(pr.base, pr.head, `Merge pull request #${pr.number} (queue)`);
              Object.assign(pr, { state: "closed", merged: true, updatedAt: now() });
              emit("PullRequestEvent", actor, await prPayload(pr, "closed"));
            })();
          }, 1500);

          return { status: 202, body: { status: "enqueued" } };
        }

        await repo.merge(pr.base, pr.head, `Merge pull request #${pr.number}`);
        Object.assign(pr, { state: "closed", merged: true, updatedAt: now() });
        emit("PullRequestEvent", actor, await prPayload(pr, "closed"));
        return { merged: true, sha };
      },
    })),
    {
      method: "GET",
      path: pulls,
      handler: async (r) =>
        Promise.all(
          [...prs.values()]
            .filter((p) => r.query.get("state") === "all" || p.state === "open")
            .map(async (p) => ({
              ...(await rest(p)),
              mergeable: undefined,
              mergeable_state: undefined,
            })),
        ),
    },
    {
      method: "POST",
      path: pulls,
      handler: async (r) => {
        const actor = botOf(r);
        if (!actor) {
          return unauthorized;
        }

        const b = r.json;
        const sha = await repo.sha(b.head);
        if (!sha) {
          return { status: 422, body: { message: `Head ref ${b.head} does not exist.` } };
        }

        const pr: StoredPull = {
          number: prs.size + 1,
          title: b.title,
          body: b.body ?? "",
          login: actor,
          head: b.head,
          base: b.base,
          lastSha: sha,
          forcePushes: 0,
          conversation: [],
          state: "open",
          merged: false,
          draft: b.draft === true,
          updatedAt: now(),
        };

        prs.set(pr.number, pr);
        emit("PullRequestEvent", actor, await prPayload(pr, "opened"));
        return { status: 201, body: await rest(pr) };
      },
    },
    {
      method: "PATCH",
      path: `${pulls}/:n`,
      handler: async (r) => {
        const pr = need(r.params["n"]!);
        if (!pr) {
          return notFound;
        }

        for (const k of ["title", "body"] as const) {
          if (typeof r.json[k] === "string") {
            pr[k] = r.json[k];
          }
        }

        if (typeof r.json.base === "string") {
          pr.base = r.json.base;
        }

        pr.updatedAt = now();
        return rest(pr);
      },
    },
    {
      method: "GET",
      path: `${pulls}/:n`,
      handler: async (r) => {
        const pr = need(r.params["n"]!);
        if (!pr) {
          return notFound;
        }

        if (r.headers["accept"] === "application/vnd.github.diff") {
          return {
            headers: { "content-type": "text/plain" },
            buffer: Buffer.from(`${await repo.diff(pr.base, pr.head)}\n`),
          };
        }

        return rest(pr);
      },
    },
    {
      method: "POST",
      path: `${pulls}/:n/reviews`,
      handler: async (r) => {
        const pr = need(r.params["n"]!);
        const actor = botOf(r);
        if (!pr || !actor) {
          return pr ? unauthorized : notFound;
        }

        if (!REVIEW_STATE[r.json.event]) {
          return { status: 422, body: { message: "Unprocessable: bad event" } };
        }

        const id = await submitReview(pr, actor, r.json.event, r.json.body ?? "", r.json.comments);
        return { id, state: REVIEW_STATE[r.json.event] };
      },
    },
    {
      method: "GET",
      path: `${pulls}/:n/reviews/:id/comments`,
      handler: (r) => {
        const review = reviews.get(Number(r.params["id"]));
        if (!review || review.prNumber !== Number(r.params["n"])) {
          return notFound;
        }

        return review.comments.map((c): RestReviewComment => ({
          id: c.databaseId,
          path: c.path,
          line: c.line,
          body: c.body,
          html_url: `https://github.example/${full}/pull/${review.prNumber}#discussion_r${c.databaseId}`,
        }));
      },
    },
    {
      method: "POST",
      path: `${API}/repos/${full}/issues/:n/comments`,
      handler: (r) => {
        const pr = need(r.params["n"]!);
        const actor = botOf(r);
        if (!pr || !actor) {
          return pr ? unauthorized : notFound;
        }

        const id = ++commentId;
        pr.conversation.push({ id, seq: ++seq, author: actor, body: r.json.body, at: now() });
        pr.updatedAt = now();
        emit("IssueCommentEvent", actor, {
          action: "created",
          issue: { number: pr.number, pull_request: {} },
          comment: { id, body: r.json.body },
        });

        return { id };
      },
    },
    {
      method: "GET",
      path: `${API}/repos/${full}/issues/:n/comments`,
      handler: (r) => {
        const pr = need(r.params["n"]!);
        return pr
          ? pr.conversation.map((c): RestIssueComment => ({
              id: c.id,
              user: { login: c.author },
              body: c.body,
              created_at: c.at,
              updated_at: c.at,
              html_url: `https://github.example/${full}/pull/${pr.number}#issuecomment-${c.id}`,
            }))
          : notFound;
      },
    },
    {
      method: "GET",
      path: `${pulls}/:n/reviews`,
      handler: (r) => {
        const pr = need(r.params["n"]!);
        return pr
          ? [...reviews]
              .filter(([, v]) => v.prNumber === pr.number)
              .map(([id, v]): RestReview => ({
                id,
                user: { login: v.author },
                body: v.body,
                state: v.state,
                submitted_at: v.at,
                commit_id: v.commitId,
                html_url: `https://github.example/${full}/pull/${pr.number}#pullrequestreview-${id}`,
              }))
          : notFound;
      },
    },
    ...(["issues", "pulls"] as const).map((segment): Route => ({
      method: "POST",
      path: `${API}/repos/${full}/${segment}/comments/:id/reactions`,
      handler: (r) => {
        const actor = botOf(r);
        if (!actor) {
          return unauthorized;
        }

        const id = Number(r.params["id"]);
        const kind = segment === "issues" ? "conversation_comment" : "inline_comment";
        const known =
          kind === "conversation_comment"
            ? [...prs.values()].some((p) => p.conversation.some((c) => c.id === id))
            : [...threads.values()].some((t) => t.comments.some((c) => c.databaseId === id));

        if (!known) {
          return notFound;
        }

        const found = reactions.find(
          (x) =>
            x.kind === kind &&
            x.commentId === id &&
            x.user === actor &&
            x.content === r.json.content,
        );

        if (found) {
          return { status: 200, body: { id, content: found.content } };
        }

        reactions.push({ kind, commentId: id, user: actor, content: r.json.content, seq: ++seq });
        return { status: 201, body: { id, content: r.json.content } };
      },
    })),
    {
      method: "GET",
      path: `${API}/repos/${full}/commits/:sha/check-runs`,
      handler: (r) => ({ check_runs: checkRuns.get(r.params["sha"]!) ?? [] }),
    },
    {
      method: "GET",
      path: `${API}/repos/${full}/commits/:sha/status`,
      handler: () => ({ statuses: [] }),
    },
    {
      method: "GET",
      path: `${API}/repos/${full}/collaborators/:login/permission`,
      handler: (r) => ({ permission: opts.permissions[r.params["login"]!] ?? "none" }),
    },
    {
      method: "GET",
      path: `${API}/repos/${full}/events`,
      handler: (r) =>
        r.headers["if-none-match"] === etag()
          ? { status: 304 }
          : { headers: { etag: etag(), "content-type": "application/json" }, body: events },
    },
    // The further repositories have no pull requests and no events; the office still polls them.
    ...(opts.more ?? []).flatMap((r): Route[] => {
      const base = `${API}/repos/${r.owner}/${r.name}`;
      return [
        { method: "GET", path: base, handler: () => ({ default_branch: "main" }) },
        { method: "GET", path: `${base}/pulls`, handler: () => [] },
        {
          method: "GET",
          path: `${base}/events`,
          handler: () => ({
            headers: { etag: '"none"', "content-type": "application/json" },
            body: [],
          }),
        },
        {
          method: "GET",
          path: `${base}/collaborators/:login/permission`,
          handler: (q) => ({ permission: opts.permissions[q.params["login"]!] ?? "none" }),
        },
      ];
    }),
    { method: "POST", path: "/api/graphql", handler: graphql },
  ];

  /** Git over HTTP for `/<owner>/<name>.git/...`: a token from the App flow is the password. */
  async function serveGit(
    req: Req,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const basic = /^Basic (.+)$/.exec(String(req.headers["authorization"] ?? ""))?.[1];
    const token = basic
      ? Buffer.from(basic, "base64").toString("utf8").split(":").slice(1).join(":")
      : "";

    const who = tokens.get(token);
    const pushing =
      req.path.endsWith("/git-receive-pack") || req.query.get("service") === "git-receive-pack";

    if (!who || (pushing && !who.write)) {
      return {
        status: who ? 403 : 401,
        headers: { "www-authenticate": 'Basic realm="github"', "content-type": "text/plain" },
        body: Buffer.from(who ? "write access required\n" : "authentication required\n"),
      };
    }

    const served = [repo, ...(opts.more ?? [])].find((r) =>
      req.path.startsWith(`/${r.owner}/${r.name}.git/`),
    );

    const out = await (served ?? repo).backend({
      method: req.method,
      path: req.path,
      query: req.query.toString(),
      contentType: req.headers["content-type"],
      encoding: req.headers["content-encoding"] as string | undefined,
      body: req.raw,
      user: who.slug,
    });

    if (req.path.endsWith("/git-receive-pack") && out.status === 200) {
      await syncHeads(`${who.slug}[bot]`);
    }

    return out;
  }

  return {
    routes,
    serveGit,
    isGitPath: (path: string) =>
      [repo, ...(opts.more ?? [])].some((r) => path.startsWith(`/${r.owner}/${r.name}.git/`)),

    // The test driver acts as humans through these.
    async review(n: number, actor: string, event: string, body: string, comments?: Json[]) {
      const pr = need(n);
      if (!pr) {
        throw new Error(`No pull request ${n}.`);
      }

      await submitReview(pr, actor, event, body, comments);
    },

    /** A human comments on the pull request conversation. */
    async comment(n: number, actor: string, body: string) {
      const pr = need(n);
      if (!pr) {
        throw new Error(`No pull request ${n}.`);
      }

      const id = ++commentId;
      pr.conversation.push({ id, seq: ++seq, author: actor, body, at: now() });
      pr.updatedAt = now();
      emit("IssueCommentEvent", actor, {
        action: "created",
        issue: { number: pr.number, pull_request: {} },
        comment: {
          id,
          body,
          html_url: `https://github.example/${full}/pull/${pr.number}#issuecomment-${id}`,
        },
      });
    },

    /** A completed check run on the pull request's head commit, as a CI service would report it. */
    async setCheck(n: number, name: string, conclusion: string) {
      const pr = need(n);
      const sha = pr && ((await repo.sha(pr.head)) ?? pr.lastSha);
      if (!sha) {
        throw new Error(`Pull request ${n} has no head commit.`);
      }

      const run = {
        name,
        status: "completed",
        conclusion,
        html_url: `https://github.acme.example/${full}/runs/${name}`,
        output: { title: `${name} ${conclusion}`, summary: `${name} ${conclusion}` },
      };

      checkRuns.set(sha, [...(checkRuns.get(sha) ?? []).filter((c) => c.name !== name), run]);
    },

    async merge(n: number, actor: string) {
      const pr = need(n);
      if (!pr || pr.state !== "open") {
        throw new Error(`Pull request ${n} is not open.`);
      }

      await repo.merge(pr.base, pr.head, `Merge pull request #${n}`);
      Object.assign(pr, { state: "closed", merged: true, updatedAt: now() });
      emit("PullRequestEvent", actor, await prPayload(pr, "closed"));
    },

    async state() {
      return {
        main: await repo.sha("main"),
        branches: await repo.branches(),
        reactions,
        pulls: await Promise.all(
          [...prs.values()].map(async (p) => {
            const r = await rest(p);
            return {
              number: p.number,
              title: p.title,
              body: p.body,
              author: p.login,
              head: r.head,
              state: p.merged ? "merged" : p.state,
              queued: p.queued === true,
              mergeable: r.mergeable,
              forcePushes: p.forcePushes,
              commits: await repo.ahead(p.base, p.head),
              containsMain: await repo.isAncestor(p.base, p.head),
              conversation: p.conversation,
              threads: [...threads.values()]
                .filter((t) => t.prNumber === p.number)
                .map((t) => ({ id: t.id, resolved: t.resolved, comments: t.comments })),
            };
          }),
        ),
      };
    },
  };
}
