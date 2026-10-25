import { expect } from "vitest";

export interface StubRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  params: Record<string, string>;
  json: any; // oxlint-disable-line no-explicit-any
}

export interface StubReply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;

  /** A non-JSON body, served as plain text. */
  text?: string;
}

export type Handler = (req: StubRequest) => StubReply | unknown;

export interface Route {
  method: string;

  /** `:name` segments capture a decoded path segment; `*` matches the rest. */
  path: string;
  handler: Handler;
}

const compile = (pattern: string): ((path: string) => Record<string, string> | undefined) => {
  const parts = pattern.split("/");
  return (path) => {
    const segs = path.split("/");
    const params: Record<string, string> = {};
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p === "*") {
        return params;
      }

      const s = segs[i];
      if (s === undefined) {
        return undefined;
      }

      if (p.startsWith(":")) {
        params[p.slice(1)] = decodeURIComponent(s);
      } else if (p !== s) {
        return undefined;
      }
    }

    return segs.length === parts.length ? params : undefined;
  };
};

const isReply = (v: unknown): v is StubReply =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => k === "status" || k === "headers" || k === "body" || k === "text");

/** A fetch that serves JSON by method and path and records every call. Unmatched requests fail the test. */
export function createStubFetch(routes: Route[], origin = "https://api.github.test") {
  const compiled = routes.map((r) => ({ r, match: compile(r.path) }));
  const calls: StubRequest[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );

    const headers = new Headers(init?.headers);
    // A route whose path is a full URL serves another host (a log download); it must never get the token.
    const external = url.origin !== origin;
    if (external) {
      expect(
        compiled.some(({ r }) => r.path.startsWith(url.origin)),
        `requests must stay on the API host, not ${url.origin}`,
      ).toBe(true);

      expect(headers.get("authorization"), `${url.origin} must not receive the token`).toBeNull();
    } else {
      // Every call identifies itself the way GitHub requires.
      expect(
        headers.get("authorization"),
        `${init?.method} ${url.pathname} is unauthenticated`,
      ).toMatch(/^Bearer \S+/);

      expect(["application/vnd.github+json", "application/vnd.github.diff"]).toContain(
        headers.get("accept"),
      );

      expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    }

    expect(headers.get("user-agent")).toBeTruthy();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = external ? `${url.origin}${url.pathname}` : url.pathname;
    for (const { r, match } of compiled) {
      if (r.method !== method) {
        continue;
      }

      const params = match(path);
      if (!params) {
        continue;
      }

      const req: StubRequest = {
        method,
        path: decodeURIComponent(path),
        query: url.searchParams,
        headers,
        params,
        json: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };

      calls.push(req);
      const out = await r.handler(req);
      const reply: StubReply = isReply(out) ? out : { body: out };
      const status = reply.status ?? 200;
      const body =
        status === 304 || status === 204 ? null : (reply.text ?? JSON.stringify(reply.body ?? {}));

      return new Response(body, {
        status,
        headers: {
          "content-type": reply.text === undefined ? "application/json" : "text/plain",
          ...reply.headers,
        },
      });
    }

    throw new Error(`stub: no route for ${method} ${path}${url.search}`);
  }) as typeof fetch;

  return {
    fetch: stub,
    calls,
    called: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}
