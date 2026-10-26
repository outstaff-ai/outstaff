import type { z } from "zod";
import type { githubOptions } from "./options.js";

export type GithubOptions = z.output<typeof githubOptions>;

export interface GithubDeps {
  sleep?: (ms: number) => Promise<void>;
  readFile?: (path: string) => string;

  /** The person this container runs as; only they can get write credentials, from the container's own App. Default: secret `OUTSTAFF_PERSON`. */
  self?: string;
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
  installationId?: string;
  slug?: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface TokenScope {
  repositories?: string[];
  permissions?: Record<string, "read" | "write">;

  /**
   * Permissions to add only when the installation has been granted them. Asking GitHub for a permission the
   * installation lacks makes it refuse the token, so these are checked against the installation first.
   */
  optionalPermissions?: Record<string, "read" | "write">;
}

export interface HttpConfig {
  fetch: typeof fetch;
  apiUrl: string;
  graphqlUrl: string;
  now: () => Date;
}

export interface RequestOptions {
  /** Bearer credential: an App JWT or an installation token. */
  token: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResult<T> {
  status: number;
  data: T;

  /** The raw body, for media types that are not JSON (a diff). */
  text: string;
  headers: Headers;
}
