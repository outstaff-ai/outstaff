import type {
  Logger,
  RepoRef,
  SecretSource,
  UnmappedEvent,
  Vcs,
  VcsEvent,
  repoGrant,
} from "@outstaff/core";
import type { Cursor } from "#/api.types.js";
import type { AppAuth } from "#/auth.js";
import type { GithubHttp } from "#/http.js";
import type { HttpResult, RequestOptions } from "#/types.js";

/** The secret prefix of a GitHub App: this container's own, or the read-only office App. */
export type AppPrefix = "GH_APP_" | "GH_OFFICE_APP_";

/** What `createGithubContext` builds once per adapter and every group of operations shares. */
export interface GithubContext {
  http: GithubHttp;
  log: Logger;

  /** REST API root without a trailing slash. */
  apiUrl: string;

  /** Web root, where links point, without a trailing slash. */
  web: string;

  /** The branch that holds the images of pull requests. */
  assetsBranch: string;
  secrets: SecretSource;

  /** The person this container runs as. */
  self: string | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  links: Vcs["links"];

  /** The person's grant on a repo of the team, or undefined when the person or the repo is not in the team. */
  grantOf: (person: string, repo: RepoRef) => ReturnType<typeof repoGrant>;
  isAgentLogin: (login: string) => boolean;

  /** The read-only office App. */
  office: () => AppAuth;
  apiToken: (repo: RepoRef) => Promise<string>;

  /** The private keys of the Apps whose keys this container holds, inline or from a file, for masking. */
  appKeys: () => string[];

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

/** Where the last poll of one repository's event feed left off. */
export interface FeedPosition {
  /** Time of the newest event read before; NaN when the cursor has no valid entry for the repository. */
  since: number;
  unknown: boolean;

  /** A cursor that lacks this repository: this poll only baselines it (#229). */
  baseline: boolean;

  /**
   * An entry from before the direct lists, whose comments and reviews were recorded under feed event ids: this
   * poll reads the whole feed and reports only what is newer than `since`.
   */
  upgrade: boolean;
  etag: string | undefined;

  /** Ids already read at baseline time, which the overlap would otherwise hand back as news. */
  skip: Set<string>;
}

/** A mapped event with the time and id it is ordered by. */
export interface FoundEvent {
  event: VcsEvent;
  at: number;
  id: bigint;
}

/** What one poll of a repository's event feed read, and the cursor entry to store for it. */
export interface RepoPoll {
  entry: Cursor[string];
  found: FoundEvent[];
  unmapped: UnmappedEvent[];
}

/** A GET made by one poll, counted towards the requests the poll logs. */
export type PollGet = <T>(path: string, opts: RequestOptions) => Promise<HttpResult<T>>;

/** Where one repository's direct comment and review lists start reading this poll. */
export interface DirectPosition {
  /** The newest time read from them before. */
  since: number;

  /** What is at or before it is not news; NaN once the overlap has moved past it. */
  after: number;

  /** The oldest time that is still news: `since` less the overlap, but never at or before `after`. */
  floor: number;
  etags: Record<string, string>;
  reviewed: Record<string, string>;
}
