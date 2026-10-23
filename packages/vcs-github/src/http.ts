import { PortError } from "@outstaff/core";

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
  headers: Headers;
}

const DEFAULT_SECONDARY_LIMIT_MS = 60_000;

/** A small typed REST + GraphQL client. Every failure leaves here as a PortError. */
export class GithubHttp {
  constructor(private readonly cfg: HttpConfig) {}

  /** `path` is relative to the API root, or an absolute URL under it (pagination links). A 304 resolves with `data: undefined`. */
  async request<T>(method: string, path: string, opts: RequestOptions): Promise<HttpResult<T>> {
    const url = this.url(path, opts.query);
    return this.send<T>(method, url, opts.token, opts.body, opts.headers);
  }

  /** Follows `Link: rel="next"` and concatenates the pages (at most `maxPages`). */
  async paginate<T, Item>(
    path: string,
    opts: RequestOptions,
    pick: (data: T) => Item[],
    maxPages = 10,
  ): Promise<Item[]> {
    const items: Item[] = [];
    let next: string | undefined = path;
    const { query: _query, ...followUp } = opts;
    for (let page = 0; next && page < maxPages; page++) {
      const res: HttpResult<T> = await this.request<T>("GET", next, page === 0 ? opts : followUp);
      items.push(...pick(res.data));
      next = nextLink(res.headers.get("link"), this.cfg.apiUrl);
    }

    return items;
  }

  async graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.send<{ data?: T; errors?: { type?: string; message: string }[] }>(
      "POST",
      this.cfg.graphqlUrl,
      token,
      { query, variables },
    );

    const { data, errors } = res.data;
    if (errors?.length) {
      const first = errors[0]!;
      const code =
        first.type === "NOT_FOUND"
          ? "not_found"
          : first.type === "FORBIDDEN" || first.type === "INSUFFICIENT_SCOPES"
            ? "forbidden"
            : first.type === "RATE_LIMITED"
              ? "rate_limited"
              : "invalid";

      throw new PortError(
        code,
        `GitHub GraphQL: ${first.message}`,
        code === "rate_limited" ? { retryAfterMs: DEFAULT_SECONDARY_LIMIT_MS } : {},
      );
    }

    if (data === undefined) {
      throw new PortError("unavailable", "GitHub GraphQL returned no data.");
    }

    return data;
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(/^https?:\/\//.test(path) ? path : `${this.cfg.apiUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }

    return url.toString();
  }

  private async send<T>(
    method: string,
    url: string,
    token: string,
    body?: unknown,
    extra?: Record<string, string>,
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "outstaff-vcs-github",
      authorization: `Bearer ${token}`,
      ...extra,
    };

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let res: Response;
    try {
      res = await this.cfg.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new PortError("unavailable", `GitHub is unreachable: ${(cause as Error).message}`, {
        cause,
      });
    }

    if (res.status === 304) {
      return { status: 304, data: undefined as T, headers: res.headers };
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }

    if (res.ok) {
      return { status: res.status, data: data as T, headers: res.headers };
    }

    throw this.toError(method, url, res, data, text);
  }

  private toError(
    method: string,
    url: string,
    res: Response,
    data: unknown,
    text: string,
  ): PortError {
    const message =
      (data as { message?: string } | undefined)?.message ?? (text.slice(0, 200) || res.statusText);

    const what = `${method} ${new URL(url).pathname}: ${res.status} ${message}`;
    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (retryAfter !== null || remaining === "0" || /rate limit/i.test(message)));

    if (limited) {
      return new PortError("rate_limited", `GitHub rate limit: ${what}`, {
        retryAfterMs: this.retryAfterMs(res.headers),
      });
    }

    if (res.status === 401 || res.status === 403) {
      return new PortError("forbidden", `GitHub refused: ${what}`);
    }

    if (res.status === 404) {
      return new PortError("not_found", `GitHub: ${what}`);
    }

    if (res.status === 409) {
      return new PortError("conflict", `GitHub: ${what}`);
    }

    if (res.status === 422 || res.status === 400) {
      return new PortError("invalid", `GitHub: ${what}`);
    }

    if (res.status >= 500) {
      return new PortError("unavailable", `GitHub: ${what}`);
    }

    return new PortError("invalid", `GitHub: ${what}`);
  }

  private retryAfterMs(headers: Headers): number {
    const retryAfter = Number(headers.get("retry-after"));
    if (headers.get("retry-after") !== null && Number.isFinite(retryAfter)) {
      return Math.max(0, retryAfter * 1000);
    }

    const reset = Number(headers.get("x-ratelimit-reset"));
    if (headers.get("x-ratelimit-reset") !== null && Number.isFinite(reset)) {
      return Math.max(0, reset * 1000 - this.cfg.now().getTime());
    }

    return DEFAULT_SECONDARY_LIMIT_MS;
  }
}

/** Only follows links that stay under the API root, so a token never travels to another host. */
export function nextLink(header: string | null, apiUrl: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m && m[1]!.startsWith(apiUrl)) {
      return m[1];
    }
  }

  return undefined;
}
