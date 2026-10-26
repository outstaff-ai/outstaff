import { readFileSync } from "node:fs";
import {
  PortError,
  maskSecrets,
  parseRepoUrl,
  repoGrant,
  vcsAgentLogins,
  type AdapterContext,
  type Check,
  type ConversationEntry,
  type PullRequest,
  type RepoRef,
  type ReviewInlineComment,
  type ReviewThread,
  type UnmappedEvent,
  type Vcs,
  type VcsEvent,
} from "@outstaff/core";
import { AppAuth, type AppCredentials } from "./auth.js";
import { failedStepNames, failedSteps } from "./check-log.js";
import { GithubHttp, nextLink } from "./http.js";
import {
  actionsJobId,
  checkRunStatus,
  checkSummary,
  commitStatusState,
  permissionLevel,
  stripBot,
  toPullRequest,
  toVcsEvent,
  type RestCheckRun,
  type RestEvent,
  type RestPull,
} from "./mapping.js";
import type { GithubOptions } from "./options.js";

export interface GithubDeps {
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;

  /** The person this container runs as; only they can get write credentials, from the container's own App. Default: secret `OUTSTAFF_PERSON`. */
  self?: string;
}

const MERGEABLE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000];
const EVENT_PAGES = 3;
// Re-read this much before the newest time seen; intake de-duplicates by external id.
const OVERLAP_MS = 5 * 60_000;

const PERMISSIONS = {
  read: { contents: "read" },
  write: { contents: "write", pull_requests: "write", issues: "write" },
} as const;

/** Added to a person's write token when their installation has it, so a push under `.github/workflows/` is accepted. */
const OPTIONAL_WRITE = { workflows: "write" } as const;

/** Reading job logs needs Actions: read; requested when the installation has it, like Workflows. */
const LOG_PERMISSIONS = { contents: "read" } as const;
const OPTIONAL_LOGS = { actions: "read" } as const;
const DEFAULT_TAIL = 200;

const REPLY_MUTATION = `mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}`;
const READY_MUTATION = `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`;
const DRAFT_MUTATION = `mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{id isDraft}}}`;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line originalLine comments(first:100){nodes{id databaseId body author{login}}}}}}}}`;
const LAST_COMMENT_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved comments(last:1){nodes{author{login}}}}}}`;
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;

interface Cursor {
  [repo: string]: { etag?: string; since?: string; seen?: string[] };
}

function parseCursor(cursor: string | undefined): Cursor {
  if (!cursor) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(cursor);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Cursor;
    }
  } catch {
    // fall through
  }

  throw new PortError("invalid", "Unrecognised GitHub event cursor.");
}

type ThreadNode = {
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
type ThreadsData = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ThreadNode[];
      };
    } | null;
  } | null;
};

interface RestReviewComment {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
  html_url?: string;
}

interface RestIssueComment {
  id: number;
  user: { login: string } | null;
  body?: string | null;
  created_at: string;
  html_url: string;
}

interface RestReview {
  id: number;
  user: { login: string } | null;
  body?: string | null;
  state: string;
  submitted_at?: string | null;
  html_url: string;
}

// A long conversation has more than the default ten pages; the newest entries are on the last ones.
const CONVERSATION_PAGES = 50;

/** Reviews need only pull request access, so a read-granted person can review. */
const REVIEW_PERMISSIONS = { pull_requests: "write" } as const;
const REVIEW_EVENTS = {
  approve: "APPROVE",
  request_changes: "REQUEST_CHANGES",
  comment: "COMMENT",
} as const;

const repoPath = (r: RepoRef) => `/repos/${r.owner}/${r.name}`;

export function createGithubVcs(ctx: AdapterContext<GithubOptions>, deps: GithubDeps = {}): Vcs {
  const { options, secrets } = ctx;
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const web = options.webUrl.replace(/\/+$/, "");
  const graphqlUrl =
    options.graphqlUrl ??
    (apiUrl.endsWith("/api/v3")
      ? `${apiUrl.slice(0, -"/api/v3".length)}/api/graphql`
      : `${apiUrl}/graphql`);

  const http = new GithubHttp({ fetch: ctx.fetch, apiUrl, graphqlUrl, now: ctx.now });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const self = deps.self ?? secrets.get("OUTSTAFF_PERSON");

  /** The person's grant on a repo of the team, or undefined when the person or the repo is not in the team. */
  const grantOf = (person: string, repo: RepoRef) => {
    const known = ctx.team.people.find((p) => p.handle === person);
    const entry = ctx.team.repos.find((r) => {
      try {
        const parsed = parseRepoUrl(r.url);
        return (
          parsed.owner.toLowerCase() === repo.owner.toLowerCase() &&
          parsed.name.toLowerCase() === repo.name.toLowerCase()
        );
      } catch {
        return false;
      }
    });

    return known && entry ? repoGrant(known, entry) : undefined;
  };

  // Exact match on the people's `identities.vcs`; a login is never guessed from a handle.
  const agentLogins = vcsAgentLogins(ctx.team);
  const isAgentLogin = (login: string) => agentLogins.has(login.toLowerCase());

  const links = {
    pr: (r: RepoRef, n: number) => `${web}/${r.owner}/${r.name}/pull/${n}`,
    commit: (r: RepoRef, sha: string) => `${web}/${r.owner}/${r.name}/commit/${sha}`,
    // A thread id is a GraphQL node id, which GitHub has no anchor for; the link lands on the pull request.
    thread: (r: RepoRef, n: number, id: string) =>
      `${web}/${r.owner}/${r.name}/pull/${n}#discussion_${id}`,
  };

  const loadCredentials = (prefix: "GH_APP_" | "GH_OFFICE_APP_"): AppCredentials | undefined => {
    const get = (key: string) => secrets.get(`${prefix}${key}`);
    const appId = get("ID");
    if (!appId) {
      return undefined;
    }

    const inline = get("PRIVATE_KEY");
    const file = get("PRIVATE_KEY_FILE");
    const privateKey = inline ? inline.replace(/\\n/g, "\n") : file ? readFile(file) : undefined;
    if (!privateKey) {
      throw new PortError(
        "invalid",
        `${prefix}ID is set but neither ${prefix}PRIVATE_KEY nor ${prefix}PRIVATE_KEY_FILE is.`,
      );
    }

    const installationId = get("INSTALLATION_ID");
    const slug = get("SLUG");
    return {
      appId,
      privateKey,
      ...(installationId ? { installationId } : {}),
      ...(slug ? { slug } : {}),
    };
  };

  // The read-only office App: present in the office and in every agent container. All reads use it.
  let officeApp: AppAuth | undefined;
  const office = (): AppAuth => {
    if (officeApp) {
      return officeApp;
    }

    const creds = loadCredentials("GH_OFFICE_APP_");
    if (!creds) {
      throw new PortError("invalid", "Missing secret GH_OFFICE_APP_ID (the read-only office App).");
    }

    return (officeApp = new AppAuth(http, ctx.now, creds));
  };

  const apiToken = async (repo: RepoRef): Promise<string> => (await office().token(repo)).token;

  // This container's own App; only an agent container has one.
  let ownApp: AppAuth | undefined | null;
  const own = (): AppAuth | undefined => {
    if (ownApp === undefined) {
      const creds = loadCredentials("GH_APP_");
      ownApp = creds ? new AppAuth(http, ctx.now, creds) : null;
    }

    return ownApp ?? undefined;
  };

  const botIds = new Map<string, number>();
  const botAuthor = async (slug: string, token: string) => {
    const login = `${slug}[bot]`;
    let id = botIds.get(login);
    if (id === undefined) {
      id = (
        await http.request<{ id: number }>("GET", `/users/${encodeURIComponent(login)}`, { token })
      ).data.id;

      botIds.set(login, id);
    }

    const host = new URL(web).hostname;
    return { name: login, email: `${id}+${login}@users.noreply.${host}` };
  };

  async function fetchPull(repo: RepoRef, number: number, token: string): Promise<PullRequest> {
    const res = await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token });
    return toPullRequest(repo, res.data, links.pr(repo, number), isAgentLogin);
  }

  /**
   * A token for the person this container runs as, for a write. Refuses without a grant on the repo (a write
   * grant unless `level` is "read"), and for a person other than this container's own.
   */
  async function actingToken(
    repo: RepoRef,
    level: "read" | "write",
    permissions: Record<string, "read" | "write">,
    optionalPermissions?: Record<string, "read" | "write">,
  ): Promise<{ token: string; app: AppAuth }> {
    const where = `${repo.owner}/${repo.name}`;
    const grant = self ? grantOf(self, repo) : undefined;
    if (!self || !grant || (level === "write" && grant !== "write")) {
      throw new PortError(
        "forbidden",
        `"${self ?? "this container"}" has no ${level} grant on ${where}.`,
      );
    }

    const app = own();
    if (!app) {
      throw new PortError("forbidden", "Writing to GitHub needs this container's own GitHub App.");
    }

    try {
      const issued = await app.token(repo, {
        repositories: [repo.name],
        permissions,
        ...(optionalPermissions ? { optionalPermissions } : {}),
      });

      return { token: issued.token, app };
    } catch (e) {
      if (e instanceof PortError && (e.code === "invalid" || e.code === "not_found")) {
        throw new PortError(
          "forbidden",
          `${self} has no ${level} access to ${where}: ${e.message}`,
          {
            cause: e,
          },
        );
      }

      throw e;
    }
  }

  async function threadNodes(repo: RepoRef, number: number, token: string): Promise<ThreadNode[]> {
    const nodes: ThreadNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const data: ThreadsData = await http.graphql<ThreadsData>(token, THREADS_QUERY, {
        owner: repo.owner,
        name: repo.name,
        number,
        after,
      });

      const threads = data.repository?.pullRequest?.reviewThreads;
      if (!threads) {
        throw new PortError(
          "not_found",
          `Pull request ${repo.owner}/${repo.name}#${number} not found.`,
        );
      }

      nodes.push(...threads.nodes);
      if (!threads.pageInfo.hasNextPage) {
        break;
      }

      after = threads.pageInfo.endCursor;
    }

    return nodes;
  }

  return {
    links,

    async credentials(person, repo, access) {
      if (access === "read") {
        // Cloning uses the read-only office App, for people with a read or write grant on the repo.
        if (!grantOf(person, repo)) {
          throw new PortError(
            "forbidden",
            `"${person}" has no grant on ${repo.owner}/${repo.name}.`,
          );
        }

        const issued = await office().token(repo, {
          repositories: [repo.name],
          permissions: PERMISSIONS.read,
        });

        return { token: issued.token, expiresAt: issued.expiresAt };
      }

      if (grantOf(person, repo) !== "write") {
        throw new PortError(
          "forbidden",
          `"${person}" has no write grant on ${repo.owner}/${repo.name}.`,
        );
      }

      const app = own();
      if (!app || person !== self) {
        throw new PortError(
          "forbidden",
          `Write credentials are only issued to ${self ?? "an agent"} from its own container, not for "${person}" here.`,
        );
      }

      let issued;
      try {
        issued = await app.token(repo, {
          repositories: [repo.name],
          permissions: PERMISSIONS.write,
          optionalPermissions: OPTIONAL_WRITE,
        });
      } catch (e) {
        // The App lacks the permission, is not installed on the repo, or the repo is not visible to it.
        if (e instanceof PortError && (e.code === "invalid" || e.code === "not_found")) {
          throw new PortError(
            "forbidden",
            `${person} has no write access to ${repo.owner}/${repo.name}: ${e.message}`,
            { cause: e },
          );
        }

        throw e;
      }

      const author = await botAuthor(await app.slug(), issued.token);
      return { token: issued.token, expiresAt: issued.expiresAt, author };
    },

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

    async checks(repo, sha) {
      const token = await apiToken(repo);
      const runs = await http.paginate<{ check_runs: RestCheckRun[] }, RestCheckRun>(
        `${repoPath(repo)}/commits/${sha}/check-runs`,
        { token, query: { per_page: 100 } },
        (d) => d.check_runs,
      );

      const status = await http.request<{
        statuses: { context: string; state: string; target_url: string | null }[];
      }>("GET", `${repoPath(repo)}/commits/${sha}/status`, { token, query: { per_page: 100 } });

      const fallback = links.commit(repo, sha);
      const out: Check[] = runs.map((r) => ({
        name: r.name,
        status: checkRunStatus(r),
        url: r.html_url ?? r.details_url ?? fallback,
        ...(checkSummary(r) ? { summary: checkSummary(r)! } : {}),
        ...(actionsJobId(r) ? { logId: actionsJobId(r)! } : {}),
      }));

      for (const s of status.data.statuses) {
        out.push({
          name: s.context,
          status: commitStatusState(s.state),
          url: s.target_url ?? fallback,
        });
      }

      return out;
    },

    async checkLog(repo, logId, opts = {}) {
      if (!/^\d+$/.test(logId)) {
        throw new PortError("not_found", `"${logId}" is not a GitHub Actions job id.`);
      }

      const { token } = await actingToken(repo, "read", LOG_PERMISSIONS, OPTIONAL_LOGS);
      const jobPath = `${repoPath(repo)}/actions/jobs/${logId}`;
      let text: string;
      let steps: { name: string; conclusion: string | null }[];
      try {
        steps =
          (
            await http.request<{ steps?: { name: string; conclusion: string | null }[] }>(
              "GET",
              jobPath,
              { token },
            )
          ).data.steps ?? [];

        text = await http.getRedirected(`${jobPath}/logs`, token);
      } catch (e) {
        if (e instanceof PortError && e.code === "forbidden") {
          throw new PortError(
            "forbidden",
            `GitHub refused the logs of job ${logId}: ${self ?? "this person"}'s GitHub App needs the Actions: read permission on the installation (run \`ost doctor\`). ${e.message}`,
            { cause: e },
          );
        }

        throw e;
      }

      const known = [
        token,
        ...["GH_APP_", "GH_OFFICE_APP_"].map((p) => secrets.get(`${p}PRIVATE_KEY`) ?? ""),
      ];

      const masked = (line: string) => maskSecrets(line, known);

      return {
        failedSteps: failedSteps(text, failedStepNames(steps), opts.tail ?? DEFAULT_TAIL).map(
          (s) => ({
            ...s,
            lines: s.lines.map(masked),
          }),
        ),
      };
    },

    async reviewThreads(repo, number) {
      const nodes = await threadNodes(repo, number, await apiToken(repo));
      return nodes.map((n): ReviewThread => {
        const line = n.line ?? n.originalLine;
        return {
          id: n.id,
          resolved: n.isResolved,
          ...(n.path ? { path: n.path } : {}),
          ...(line !== null ? { line } : {}),
          comments: n.comments.nodes.map((c) => ({
            id: c.id,
            author: c.author?.login ?? "ghost",
            body: c.body,
          })),
        };
      });
    },

    async conversation(repo, number, opts = {}) {
      const token = await apiToken(repo);
      const [comments, reviews] = await Promise.all([
        http.paginate<RestIssueComment[], RestIssueComment>(
          `${repoPath(repo)}/issues/${number}/comments`,
          {
            token,
            // The host filters by last update, which is never before creation; the exact cut by creation time is below.
            query: { per_page: 100, ...(opts.since ? { since: opts.since } : {}) },
          },
          (d) => d,
          CONVERSATION_PAGES,
        ),
        http.paginate<RestReview[], RestReview>(
          `${repoPath(repo)}/pulls/${number}/reviews`,
          { token, query: { per_page: 100 } },
          (d) => d,
          CONVERSATION_PAGES,
        ),
      ]);

      const since = opts.since === undefined ? undefined : Date.parse(opts.since);
      const entries: ConversationEntry[] = [
        ...comments.map((c): ConversationEntry => ({
          id: `comment-${c.id}`,
          kind: "comment",
          author: c.user?.login ?? "ghost",
          at: c.created_at,
          url: c.html_url,
          body: c.body ?? "",
        })),
        ...reviews.flatMap((r): ConversationEntry[] => {
          const state = r.state.toLowerCase();
          // Pending reviews are invisible to others; one with neither text nor verdict only wraps inline comments.
          if (
            !r.submitted_at ||
            state === "pending" ||
            (state === "commented" && !r.body?.trim())
          ) {
            return [];
          }

          return [
            {
              id: `review-${r.id}`,
              kind: "review",
              author: r.user?.login ?? "ghost",
              at: r.submitted_at,
              url: r.html_url,
              body: r.body ?? "",
              state,
            },
          ];
        }),
      ]
        .filter((e) => since === undefined || Date.parse(e.at) >= since)
        .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

      return opts.limit === undefined
        ? entries
        : entries.slice(Math.max(0, entries.length - opts.limit));
    },

    async reviewComments(repo, number, reviewId) {
      const token = await apiToken(repo);
      const found = await http.paginate<RestReviewComment[], RestReviewComment>(
        `${repoPath(repo)}/pulls/${number}/reviews/${encodeURIComponent(reviewId)}/comments`,
        { token, query: { per_page: 100 } },
        (d) => d,
      );

      if (found.length === 0) {
        return [];
      }

      const threadOf = new Map<number, string>();
      for (const node of await threadNodes(repo, number, token)) {
        for (const c of node.comments.nodes) {
          if (c.databaseId !== null) {
            threadOf.set(c.databaseId, node.id);
          }
        }
      }

      return found.map((c): ReviewInlineComment => {
        const line = c.line ?? c.original_line;
        const threadId = threadOf.get(c.id);
        return {
          id: String(c.id),
          path: c.path,
          ...(typeof line === "number" ? { line } : {}),
          body: c.body,
          ...(c.html_url ? { url: c.html_url } : {}),
          ...(threadId ? { threadId } : {}),
        };
      });
    },

    async resolveThread(repo, threadId, login) {
      const app = own();
      const asLogin = login ?? (app ? `${await app.slug()}[bot]` : undefined);
      if (asLogin === undefined) {
        throw new PortError(
          "forbidden",
          "Resolving review threads needs this container's own GitHub App.",
        );
      }

      const token = await apiToken(repo);
      const read = await http.graphql<{
        node: {
          id: string;
          isResolved: boolean;
          comments: { nodes: { author: { login: string } | null }[] };
        } | null;
      }>(token, LAST_COMMENT_QUERY, { id: threadId });

      if (!read.node?.id) {
        throw new PortError("not_found", `Review thread ${threadId} not found.`);
      }

      if (read.node.isResolved) {
        return { resolved: true };
      }

      const last = read.node.comments.nodes[0]?.author?.login;
      // GraphQL reports Apps without the "[bot]" suffix that REST uses.
      if (!last || stripBot(last).toLowerCase() !== stripBot(asLogin).toLowerCase()) {
        return {
          resolved: false,
          reason: `The last comment is by ${last ?? "an unknown author"}, not ${asLogin}; reply or let the reviewer resolve it.`,
        };
      }

      if (!app) {
        throw new PortError(
          "forbidden",
          "Resolving review threads needs this container's own GitHub App.",
        );
      }

      if (stripBot(asLogin).toLowerCase() !== (await app.slug()).toLowerCase()) {
        throw new PortError(
          "forbidden",
          `Only ${await app.slug()}[bot] can resolve threads from this container, not ${asLogin}.`,
        );
      }

      await http.graphql(
        (await app.token(repo, { repositories: [repo.name], permissions: PERMISSIONS.write }))
          .token,
        RESOLVE_MUTATION,
        { id: threadId },
      );

      return { resolved: true };
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

    async submitReview(repo, number, review) {
      const { token, app } = await actingToken(repo, "read", REVIEW_PERMISSIONS);
      const pull = (
        await http.request<RestPull>("GET", `${repoPath(repo)}/pulls/${number}`, { token })
      ).data;

      const me = (await app.slug()).toLowerCase();
      if (stripBot(pull.user?.login ?? "").toLowerCase() === me) {
        throw new PortError(
          "forbidden",
          `${self} cannot review their own pull request ${repo.owner}/${repo.name}#${number}.`,
        );
      }

      await http.request("POST", `${repoPath(repo)}/pulls/${number}/reviews`, {
        token,
        body: {
          event: REVIEW_EVENTS[review.verdict],
          body: review.body,
          ...(review.comments?.length
            ? {
                comments: review.comments.map((c) => ({
                  path: c.path,
                  line: c.line,
                  side: "RIGHT",
                  body: c.body,
                })),
              }
            : {}),
        },
      });
    },

    async replyToThread(repo, number, threadId, body) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const nodes = await threadNodes(repo, number, token);
      if (!nodes.some((n) => n.id === threadId)) {
        throw new PortError(
          "not_found",
          `Review thread ${threadId} is not on ${repo.owner}/${repo.name}#${number}.`,
        );
      }

      await http.graphql(token, REPLY_MUTATION, { id: threadId, body });
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

    async react(repo, target, reaction) {
      const { token } = await actingToken(repo, "write", PERMISSIONS.write);
      const path = target.kind === "conversation_comment" ? "issues" : "pulls";
      await http.request(
        "POST",
        `${repoPath(repo)}/${path}/comments/${encodeURIComponent(target.id)}/reactions`,
        { token, body: { content: reaction } },
      );
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

    async permission(repo, login) {
      const token = await apiToken(repo);
      try {
        const res = await http.request<{ permission: string }>(
          "GET",
          `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`,
          { token },
        );

        return permissionLevel(res.data.permission);
      } catch (e) {
        if (e instanceof PortError && e.code === "not_found") {
          return "none";
        }

        throw e;
      }
    },

    async events(repos, cursor) {
      const state = parseCursor(cursor);
      const next: Cursor = { ...state };
      const found: { event: VcsEvent; at: number; id: bigint }[] = [];
      const unmapped: UnmappedEvent[] = [];
      for (const repo of repos) {
        const key = `${repo.owner}/${repo.name}`;
        const prev = state[key];
        // An entry without a valid `since` (new repo, or a cursor from before times were tracked) is no entry.
        const since = prev && typeof prev.since === "string" ? Date.parse(prev.since) : Number.NaN;
        const unknown = Number.isNaN(since);
        // No cursor at all is the first poll: intake decides whether that history is a baseline.
        // A cursor that lacks this repository only baselines this repository (#229).
        const baseline = unknown && cursor !== undefined;
        const token = await apiToken(repo);
        // A 304 answers without touching the rate limit.
        let res = await http.request<RestEvent[]>("GET", `${repoPath(repo)}/events`, {
          token,
          query: { per_page: 100 },
          ...(!unknown && prev?.etag ? { headers: { "if-none-match": prev.etag } } : {}),
        });

        if (res.status === 304) {
          continue;
        }

        const etag = res.headers.get("etag") ?? (unknown ? undefined : prev?.etag);
        const raw: RestEvent[] = [...res.data];
        // GitHub event ids are not one sequence and the feed is only roughly time-ordered, so page by time.
        let floor = since - OVERLAP_MS;
        if (unknown) {
          floor = Math.max(...res.data.map((e) => Date.parse(e.created_at))) - OVERLAP_MS;
        }

        for (let page = 1; page < EVENT_PAGES; page++) {
          const link = nextLink(res.headers.get("link"), apiUrl);
          const oldest = res.data.at(-1);
          if (!link || !oldest || Date.parse(oldest.created_at) < floor) {
            break;
          }

          res = await http.request<RestEvent[]>("GET", link, { token });
          raw.push(...res.data);
        }

        // Ids already read at baseline time: the overlap would otherwise hand that history back as news.
        const skip = new Set(unknown ? [] : prev?.seen);
        let newest = unknown ? Number.NEGATIVE_INFINITY : since;
        for (const e of raw) {
          const at = Date.parse(e.created_at);
          if (!Number.isNaN(at) && at > newest) {
            newest = at;
          }

          if (baseline || Number.isNaN(at) || at < floor || skip.has(e.id)) {
            continue;
          }

          const event = toVcsEvent(repo, e);
          if (event) {
            found.push({ event, at, id: BigInt(e.id) });
          } else {
            const action = e.payload["action"];
            unmapped.push({
              externalId: e.id,
              type: typeof action === "string" ? `${e.type} (${action})` : e.type,
              repo,
            });
          }
        }

        // An empty feed baselines at the current time so the first event after it is not lost.
        const stamp = Number.isFinite(newest) ? newest : Date.now();
        const keep = unknown ? undefined : skip;
        const seen = raw
          .filter(
            (e) => (keep ? keep.has(e.id) : true) && Date.parse(e.created_at) >= stamp - OVERLAP_MS,
          )
          .map((e) => e.id);

        next[key] = {
          ...(etag ? { etag } : {}),
          since: new Date(stamp).toISOString(),
          ...(seen.length > 0 ? { seen } : {}),
        };
      }

      found.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { events: found.map((f) => f.event), cursor: JSON.stringify(next), unmapped };
    },
  };
}
