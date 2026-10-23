import { readFileSync } from "node:fs";
import {
  PortError,
  parseRepoUrl,
  repoGrant,
  type AdapterContext,
  type Check,
  type PullRequest,
  type RepoRef,
  type ReviewThread,
  type Vcs,
  type VcsEvent,
} from "@outstaff/core";
import { AppAuth, type AppCredentials } from "./auth.js";
import { GithubHttp, nextLink } from "./http.js";
import {
  checkRunStatus,
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

  /** Decides whether a bot login's app slug belongs to a person of the team. Default: the slug is a team handle or listed in `appSlugs`. */
  isAgentSlug?: (slug: string) => boolean;

  /** The person this container runs as; only they can get write credentials, from the container's own App. Default: secret `OUTSTAFF_PERSON`. */
  self?: string;
}

const MERGEABLE_BACKOFF_MS = [500, 1_000, 2_000, 3_000, 5_000];
const EVENT_PAGES = 3;

const PERMISSIONS = {
  read: { contents: "read" },
  write: { contents: "write", pull_requests: "write", issues: "write" },
} as const;

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved path line originalLine comments(first:100){nodes{id body author{login}}}}}}}}`;
const LAST_COMMENT_QUERY = `query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved comments(last:1){nodes{author{login}}}}}}`;
const RESOLVE_MUTATION = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;

interface Cursor {
  [repo: string]: { etag?: string; lastEventId?: string };
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
  comments: { nodes: { id: string; body: string; author: { login: string } | null }[] };
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

  const agentSlugs = new Set([
    ...ctx.team.people.map((p) => p.handle),
    ...Object.values(options.appSlugs),
  ]);

  const isAgentSlug = deps.isAgentSlug ?? ((slug: string) => agentSlugs.has(slug));

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
    return toPullRequest(repo, res.data, links.pr(repo, number), isAgentSlug);
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
        .map((p) => toPullRequest(repo, p, links.pr(repo, p.number), isAgentSlug));
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

    async resolveThread(repo, threadId, asLogin) {
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

      const app = own();
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
      const found: { event: VcsEvent; id: bigint }[] = [];
      for (const repo of repos) {
        const key = `${repo.owner}/${repo.name}`;
        const prev = state[key];
        const last = prev?.lastEventId ? BigInt(prev.lastEventId) : undefined;
        const token = await apiToken(repo);
        // A 304 answers without touching the rate limit.
        let res = await http.request<RestEvent[]>("GET", `${repoPath(repo)}/events`, {
          token,
          query: { per_page: 100 },
          ...(prev?.etag ? { headers: { "if-none-match": prev.etag } } : {}),
        });

        if (res.status === 304) {
          continue;
        }

        const etag = res.headers.get("etag") ?? prev?.etag;
        const raw: RestEvent[] = [...res.data];
        // Events come newest first; keep paging while the whole page is newer than what we have seen.
        const pageLimit = last === undefined ? 1 : EVENT_PAGES;
        for (let page = 1; page < pageLimit; page++) {
          const link = nextLink(res.headers.get("link"), apiUrl);
          const oldest = res.data.at(-1);
          if (!link || !oldest || last === undefined || BigInt(oldest.id) <= last) {
            break;
          }

          res = await http.request<RestEvent[]>("GET", link, { token });
          raw.push(...res.data);
        }

        let max = last ?? 0n;
        for (const e of raw) {
          const id = BigInt(e.id);
          if (id > max) {
            max = id;
          }

          if (last !== undefined && id <= last) {
            continue;
          }

          const event = toVcsEvent(repo, e);
          if (event) {
            found.push({ event, id });
          }
        }

        next[key] = { ...(etag ? { etag } : {}), lastEventId: max.toString() };
      }

      found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { events: found.map((f) => f.event), cursor: JSON.stringify(next) };
    },
  };
}
