import { readFileSync } from "node:fs";
import {
  PortError,
  parseRepoUrl,
  repoGrant,
  vcsAgentLogins,
  type AdapterContext,
  type RepoRef,
} from "@outstaff/core";
import { AppAuth } from "#/auth.js";
import { GithubHttp } from "#/http.js";
import type {
  AppCredentials,
  GithubDeps,
  GithubOptions,
  InstallationToken,
  TokenScope,
} from "#/types.js";
import type { AppPrefix, GithubContext } from "./types.js";

const APP_PREFIXES: AppPrefix[] = ["GH_APP_", "GH_OFFICE_APP_"];

export const PERMISSIONS = {
  read: { contents: "read" },
  write: { contents: "write", pull_requests: "write", issues: "write" },
} as const;

/** Added to a person's write token when their installation has it, so a push under `.github/workflows/` is accepted. */
export const OPTIONAL_WRITE = { workflows: "write" } as const;

export const repoPath = (r: RepoRef) => `/repos/${r.owner}/${r.name}`;

/** Whether a grant allows acting at `level`: any grant reads, only a write grant writes. */
function grantCovers(grant: ReturnType<typeof repoGrant>, level: "read" | "write"): boolean {
  return Boolean(grant) && (level === "read" || grant === "write");
}

/** A token from a container's own App; an App without access to the repo is a forbidden PortError. */
export async function ownAppToken(
  app: AppAuth,
  who: string,
  level: "read" | "write",
  repo: RepoRef,
  scope: TokenScope,
): Promise<InstallationToken> {
  try {
    return await app.token(repo, scope);
  } catch (e) {
    // The App lacks the permission, is not installed on the repo, or the repo is not visible to it.
    if (e instanceof PortError && (e.code === "invalid" || e.code === "not_found")) {
      throw new PortError(
        "forbidden",
        `${who} has no ${level} access to ${repo.owner}/${repo.name}: ${e.message}`,
        { cause: e },
      );
    }

    throw e;
  }
}

/** The clients, credentials and lookups the adapter's operations share. */
export function createGithubContext(
  ctx: AdapterContext<GithubOptions>,
  deps: GithubDeps = {},
): GithubContext {
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

  /** An App's private key, inline (with escaped newlines) or read from a file; undefined when neither is set. */
  const keyOf = (prefix: AppPrefix): string | undefined => {
    const inline = secrets.get(`${prefix}PRIVATE_KEY`);
    const file = secrets.get(`${prefix}PRIVATE_KEY_FILE`);
    return inline ? inline.replace(/\\n/g, "\n") : file ? readFile(file) : undefined;
  };

  const appKeys = () => APP_PREFIXES.flatMap((p) => keyOf(p) ?? []);

  const loadCredentials = (prefix: AppPrefix): AppCredentials | undefined => {
    const get = (key: string) => secrets.get(`${prefix}${key}`);
    const appId = get("ID");
    if (!appId) {
      return undefined;
    }

    const privateKey = keyOf(prefix);
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
    if (!self || !grantCovers(grantOf(self, repo), level)) {
      throw new PortError(
        "forbidden",
        `"${self ?? "this container"}" has no ${level} grant on ${repo.owner}/${repo.name}.`,
      );
    }

    const app = own();
    if (!app) {
      throw new PortError("forbidden", "Writing to GitHub needs this container's own GitHub App.");
    }

    const issued = await ownAppToken(app, self, level, repo, {
      repositories: [repo.name],
      permissions,
      ...(optionalPermissions ? { optionalPermissions } : {}),
    });

    return { token: issued.token, app };
  }

  return {
    http,
    apiUrl,
    secrets,
    self,
    sleep,
    now: ctx.now,
    links,
    grantOf,
    isAgentLogin,
    office,
    apiToken,
    appKeys,
    own,
    botAuthor,
    actingToken,
  };
}
