import { expect } from "vitest";
import type { Route, StubReply, StubRequest } from "./types.js";

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

type Compiled = { r: Route; match: ReturnType<typeof compile> }[];

const urlOf = (input: string | URL | Request): URL =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** A route whose path is a full URL serves another host (a log download); it must never get the token. */
function expectExternalCall(compiled: Compiled, url: URL, headers: Headers): void {
  expect(
    compiled.some(({ r }) => r.path.startsWith(url.origin)),
    `requests must stay on the API host, not ${url.origin}`,
  ).toBe(true);

  expect(headers.get("authorization"), `${url.origin} must not receive the token`).toBeNull();
}

/** Every call to the API identifies itself the way GitHub requires. */
function expectApiCall(url: URL, headers: Headers, method: string | undefined): void {
  expect(headers.get("authorization"), `${method} ${url.pathname} is unauthenticated`).toMatch(
    /^Bearer \S+/,
  );

  expect(["application/vnd.github+json", "application/vnd.github.diff"]).toContain(
    headers.get("accept"),
  );

  expect(headers.get("x-github-api-version")).toBe("2022-11-28");
}

/** Checks the headers of a call to another host or to the API; every call names a user agent. */
function expectCall(
  compiled: Compiled,
  url: URL,
  headers: Headers,
  external: boolean,
  method: string | undefined,
): void {
  if (external) {
    expectExternalCall(compiled, url, headers);
  } else {
    expectApiCall(url, headers, method);
  }

  expect(headers.get("user-agent")).toBeTruthy();
}

const jsonOf = (body: RequestInit["body"]): unknown =>
  typeof body === "string" ? JSON.parse(body) : undefined;

function findRoute(compiled: Compiled, method: string, path: string) {
  for (const { r, match } of compiled) {
    const params = r.method === method ? match(path) : undefined;
    if (params) {
      return { r, params };
    }
  }

  return undefined;
}

function toResponse(out: unknown): Response {
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

/** A fetch that serves JSON by method and path and records every call. Unmatched requests fail the test. */
export function createStubFetch(routes: Route[], origin = "https://api.github.test") {
  const compiled: Compiled = routes.map((r) => ({ r, match: compile(r.path) }));
  const calls: StubRequest[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const headers = new Headers(init?.headers);
    const external = url.origin !== origin;
    expectCall(compiled, url, headers, external, init?.method);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = external ? `${url.origin}${url.pathname}` : url.pathname;
    const found = findRoute(compiled, method, path);
    if (!found) {
      throw new Error(`stub: no route for ${method} ${path}${url.search}`);
    }

    const req: StubRequest = {
      method,
      path: decodeURIComponent(path),
      query: url.searchParams,
      headers,
      params: found.params,
      json: jsonOf(init?.body),
    };

    calls.push(req);
    return toResponse(await found.r.handler(req));
  }) as typeof fetch;

  return {
    fetch: stub,
    calls,
    called: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}
