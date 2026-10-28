import type { BareRepo } from "./bare-repo.js";
import type { GithubAuth } from "./types.js";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** One request of git's smart HTTP protocol, as `git http-backend` takes it. */
export interface GitHttpRequest {
  method: string;
  path: string;
  query: string;
  contentType: string | undefined;
  encoding: string | undefined;
  body: Uint8Array;
  user: string;
}

export interface GitHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Who holds an installation token, and whether it was issued to write. */
export interface TokenHolder {
  slug: string;
  write: boolean;
}

export interface AppAuthOptions {
  /** App id to slug. The slug is what `GET /app` answers and the login of its pull requests, plus `[bot]`. */
  apps: Record<string, string>;

  /** PEM public half of the key the Apps sign their JWTs with. */
  publicKey: string;
}

/** GitHub's App scheme, plus the token lookup git over HTTP authenticates with. */
export interface AppAuth extends GithubAuth {
  holderOf(token: string): TokenHolder | undefined;
}

export interface GithubE2eOptions extends AppAuthOptions {
  repo: BareRepo;

  /** Further repositories of the same owner, served over git only (clone, fetch, push). */
  more?: BareRepo[];

  /** Login to permission level, for `collaborators/:login/permission`. */
  permissions: Record<string, string>;
}

/** An inline comment of a review the test driver submits as a person. */
export interface DriverComment {
  path: string;
  line: number;
  body: string;
}
