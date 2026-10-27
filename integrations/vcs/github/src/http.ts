import { PortError } from "@outstaff/core";
import { graphqlError, parseJson, reach, redirectTarget, toHttpError } from "./http-errors.js";
import type { HttpConfig, HttpResult, RequestOptions } from "./types.js";

/** A small typed REST + GraphQL client. Every failure leaves here as a PortError. */
export class GithubHttp {
  constructor(private readonly cfg: HttpConfig) {}

  /** `path` is relative to the API root, or an absolute URL under it (pagination links). A 304 resolves with `data: undefined`. */
  async request<T>(method: string, path: string, opts: RequestOptions): Promise<HttpResult<T>> {
    const url = this.url(path, opts.query);
    return this.send<T>(method, url, opts.token, opts.body, opts.headers);
  }

  /**
   * GET a path that answers with a redirect to a short-lived, pre-authorised URL (job logs) and returns that URL's
   * body. The redirect is followed here, without the token, so the credential never travels to the other host.
   */
  async getRedirected(path: string, token: string): Promise<string> {
    const url = this.url(path);
    const res = await reach(
      this.cfg.fetch,
      url,
      {
        method: "GET",
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "outstaff-vcs-github",
          authorization: `Bearer ${token}`,
        },
      },
      "GitHub",
    );

    if (res.status >= 300 && res.status < 400) {
      return this.followRedirect(url, res.headers.get("location"));
    }

    const text = await res.text();
    if (res.ok) {
      return text;
    }

    throw toHttpError({ method: "GET", url, now: this.cfg.now }, res, parseJson(text), text);
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
      throw graphqlError(errors[0]!);
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

    const res = await reach(
      this.cfg.fetch,
      url,
      { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
      "GitHub",
    );

    if (res.status === 304) {
      return { status: 304, data: undefined as T, text: "", headers: res.headers };
    }

    const text = await res.text();
    const data = parseJson(text);
    if (res.ok) {
      return { status: res.status, data: data as T, text, headers: res.headers };
    }

    throw toHttpError({ method, url, now: this.cfg.now }, res, data, text);
  }

  /** Reads a redirect's target without the token, so the credential never travels to the other host. */
  private async followRedirect(url: string, location: string | null): Promise<string> {
    const res = await reach(
      this.cfg.fetch,
      redirectTarget(url, location),
      { method: "GET", headers: { "user-agent": "outstaff-vcs-github" } },
      "The log host",
    );

    if (!res.ok) {
      throw new PortError("unavailable", `The log host answered ${res.status}.`);
    }

    return res.text();
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
