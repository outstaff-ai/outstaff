import type { RepoRef, SecretSource, Vcs, repoGrant } from "@outstaff/core";
import type { AppAuth } from "../auth.js";
import type { GithubHttp } from "../http.js";

/** What `createGithubContext` builds once per adapter and every group of operations shares. */
export interface GithubContext {
  http: GithubHttp;

  /** REST API root without a trailing slash. */
  apiUrl: string;
  secrets: SecretSource;

  /** The person this container runs as. */
  self: string | undefined;
  sleep: (ms: number) => Promise<void>;
  links: Vcs["links"];

  /** The person's grant on a repo of the team, or undefined when the person or the repo is not in the team. */
  grantOf: (person: string, repo: RepoRef) => ReturnType<typeof repoGrant>;
  isAgentLogin: (login: string) => boolean;

  /** The read-only office App. */
  office: () => AppAuth;
  apiToken: (repo: RepoRef) => Promise<string>;

  /** This container's own App, when it has one. */
  own: () => AppAuth | undefined;
  botAuthor: (slug: string, token: string) => Promise<{ name: string; email: string }>;
  actingToken: (
    repo: RepoRef,
    level: "read" | "write",
    permissions: Record<string, "read" | "write">,
    optionalPermissions?: Record<string, "read" | "write">,
  ) => Promise<{ token: string; app: AppAuth }>;
}
