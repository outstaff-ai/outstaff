import { PortError, type RepoRef } from "@outstaff/core";
import type { GithubHttp } from "./http.js";
import type { AppCredentials, InstallationToken, TokenScope } from "./types.js";
import { signAppJwt } from "./jwt.js";

/** How long a read of an installation's granted permissions is reused. */
const PERMISSIONS_TTL_MS = 10 * 60_000;

/** Refresh this long before the token really expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** One GitHub App: its JWT, the installation for an owner, its slug and cached installation tokens. */
export class AppAuth {
  private readonly installations = new Map<string, string>();
  private readonly tokens = new Map<string, InstallationToken>();
  private readonly granted = new Map<string, { at: number; permissions: Record<string, string> }>();
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

  /** What the installation was granted (`GET /app/installations/{id}`), reused for a while. Empty when it cannot be read. */
  private async grantedPermissions(id: string): Promise<Record<string, string>> {
    const known = this.granted.get(id);
    if (known && this.now().getTime() - known.at < PERMISSIONS_TTL_MS) {
      return known.permissions;
    }

    try {
      const res = await this.http.request<{ permissions?: Record<string, string> }>(
        "GET",
        `/app/installations/${id}`,
        { token: this.jwt() },
      );

      const permissions = res.data.permissions ?? {};
      this.granted.set(id, { at: this.now().getTime(), permissions });
      return permissions;
    } catch {
      // Without the answer the token is requested without the optional permissions, as before.
      return {};
    }
  }

  /** The requested permissions plus the optional ones the installation has been granted. */
  private async withGranted(id: string, scope: TokenScope): Promise<TokenScope["permissions"]> {
    if (!scope.optionalPermissions) {
      return scope.permissions;
    }

    const granted = await this.grantedPermissions(id);
    const extra = Object.entries(scope.optionalPermissions).filter(([name, level]) =>
      level === "read" ? granted[name] !== undefined : granted[name] === "write",
    );

    return extra.length > 0
      ? { ...scope.permissions, ...Object.fromEntries(extra) }
      : scope.permissions;
  }

  /** An installation token for `repo`'s owner, optionally narrowed. Reused until five minutes before it expires. */
  async token(repo: RepoRef, scope: TokenScope = {}): Promise<InstallationToken> {
    const id = await this.installationId(repo.owner);
    const permissions = await this.withGranted(id, scope);
    const key = JSON.stringify([id, scope.repositories ?? null, permissions ?? null]);
    const cached = this.tokens.get(key);
    if (cached && Date.parse(cached.expiresAt) - this.now().getTime() > REFRESH_MARGIN_MS) {
      return cached;
    }

    const res = await this.http.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${id}/access_tokens`,
      {
        token: this.jwt(),
        body: {
          ...(scope.repositories ? { repositories: scope.repositories } : {}),
          ...(permissions ? { permissions } : {}),
        },
      },
    );

    const fresh = { token: res.data.token, expiresAt: res.data.expires_at };
    this.tokens.set(key, fresh);
    return fresh;
  }
}
