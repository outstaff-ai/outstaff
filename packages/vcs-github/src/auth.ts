import { PortError, type RepoRef } from "@outstaff/core";
import type { GithubHttp } from "./http.js";
import { signAppJwt } from "./jwt.js";

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
}

/** Refresh this long before the token really expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** One GitHub App: its JWT, the installation for an owner, its slug and cached installation tokens. */
export class AppAuth {
  private readonly installations = new Map<string, string>();
  private readonly tokens = new Map<string, InstallationToken>();
  private slugPromise: Promise<string> | undefined;

  constructor(
    private readonly http: GithubHttp,
    private readonly now: () => Date,
    private readonly creds: AppCredentials,
  ) {}

  jwt(): string {
    return signAppJwt(this.creds.appId, this.creds.privateKey, this.now());
  }

  slug(): Promise<string> {
    if (this.creds.slug) {
      return Promise.resolve(this.creds.slug);
    }

    this.slugPromise ??= this.http
      .request<{ slug: string }>("GET", "/app", { token: this.jwt() })
      .then((r) => r.data.slug);

    this.slugPromise.catch(() => (this.slugPromise = undefined));
    return this.slugPromise;
  }

  async installationId(owner: string): Promise<string> {
    if (this.creds.installationId) {
      return this.creds.installationId;
    }

    const key = owner.toLowerCase();
    const known = this.installations.get(key);
    if (known) {
      return known;
    }

    const all = await this.http.paginate<
      { id: number; account?: { login: string } | null }[],
      { id: number; account?: { login: string } | null }
    >("/app/installations", { token: this.jwt(), query: { per_page: 100 } }, (d) => d);

    const match = all.find((i) => i.account?.login.toLowerCase() === key);
    if (!match) {
      throw new PortError(
        "forbidden",
        `GitHub App ${this.creds.appId} is not installed on "${owner}".`,
      );
    }

    this.installations.set(key, String(match.id));
    return String(match.id);
  }

  /** An installation token for `repo`'s owner, optionally narrowed. Reused until five minutes before it expires. */
  async token(repo: RepoRef, scope: TokenScope = {}): Promise<InstallationToken> {
    const id = await this.installationId(repo.owner);
    const key = JSON.stringify([id, scope.repositories ?? null, scope.permissions ?? null]);
    const cached = this.tokens.get(key);
    if (cached && Date.parse(cached.expiresAt) - this.now().getTime() > REFRESH_MARGIN_MS) {
      return cached;
    }

    const body: Record<string, unknown> = {};
    if (scope.repositories) {
      body["repositories"] = scope.repositories;
    }

    if (scope.permissions) {
      body["permissions"] = scope.permissions;
    }

    const res = await this.http.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${id}/access_tokens`,
      { token: this.jwt(), body },
    );

    const fresh = { token: res.data.token, expiresAt: res.data.expires_at };
    this.tokens.set(key, fresh);
    return fresh;
  }
}
