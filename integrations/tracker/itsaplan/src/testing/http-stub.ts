import { expect } from "vitest";
import type { Route, StubReply, StubRequest } from "./types.js";

export const API_ORIGIN = "https://api.tracker.acme.example";
export const API_KEY = "key-sam";

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
  Object.keys(v).every((k) => k === "status" || k === "headers" || k === "body" || k === "buffer");

const hrefOf = (input: string | URL | Request) => {
  if (typeof input === "string") {
    return input;
  }

  return input instanceof URL ? input.href : input.url;
};

/** The URL, headers and upper-case method of a fetch call. */
function parseCall(input: string | URL | Request, init: RequestInit | undefined) {
  return {
    url: new URL(hrefOf(input)),
    headers: new Headers(init?.headers),
    method: (init?.method ?? "GET").toUpperCase(),
  };
}

function expectAuthenticated(
  url: URL,
  headers: Headers,
  method: string | undefined,
  origin: string,
  apiKey: string,
): void {
  expect(url.origin, "requests must stay on the API host").toBe(origin);
  expect(headers.get("x-api-key"), `${method} ${url.pathname} is unauthenticated`).toBe(apiKey);
  expect(headers.get("origin")).toBeTruthy();
}

/** A JSON body parsed, and a multipart one as it is. */
function requestBody(body: RequestInit["body"]): Pick<StubRequest, "json" | "form"> {
  return {
    json: typeof body === "string" ? JSON.parse(body) : undefined,
    ...(body instanceof FormData ? { form: body } : {}),
  };
}

/** A handler's result as a response: a reply as it says, anything else as a JSON body. */
function toResponse(out: unknown): Response {
  const reply: StubReply = isReply(out) ? out : { body: out };
  const status = reply.status ?? 200;
  if (reply.buffer) {
    return new Response(reply.buffer.slice(), { status, headers: reply.headers ?? {} });
  }

  const body = status === 304 || status === 204 ? null : JSON.stringify(reply.body ?? {});
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...reply.headers },
  });
}

/** A fetch that serves JSON by method and path and records every call. Unmatched requests fail the test. */
export function createStubFetch(routes: Route[], origin = API_ORIGIN, apiKey = API_KEY) {
  const compiled = routes.map((r) => ({ r, match: compile(r.path) }));
  const calls: StubRequest[] = [];
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { url, headers, method } = parseCall(input, init);
    expectAuthenticated(url, headers, init?.method, origin, apiKey);
    const path = url.pathname;
    for (const { r, match } of compiled) {
      const params = r.method === method ? match(path) : undefined;
      if (!params) {
        continue;
      }

      const req: StubRequest = {
        method,
        path: decodeURIComponent(path),
        query: url.searchParams,
        headers,
        params,
        ...requestBody(init?.body),
      };

      calls.push(req);
      return toResponse(await r.handler(req));
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
