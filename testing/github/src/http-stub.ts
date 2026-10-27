import { createRouter, incomingFromFetch, toResponse } from "@outstaff/testing.http";
import { expect } from "vitest";
import type { Route, StubRequest } from "./types.js";

/** A route whose path is a full URL serves another host (a log download); it must never get the token. */
function expectExternal(url: URL, headers: Headers, routes: Route[]) {
  expect(
    routes.some((r) => r.path.startsWith(url.origin)),
    `requests must stay on the API host, not ${url.origin}`,
  ).toBe(true);

  expect(headers.get("authorization"), `${url.origin} must not receive the token`).toBeNull();
}

/** Every call to the API identifies itself the way GitHub requires. */
function expectApi(url: URL, method: string | undefined, headers: Headers) {
  expect(headers.get("authorization"), `${method} ${url.pathname} is unauthenticated`).toMatch(
    /^Bearer \S+/,
  );

  expect(["application/vnd.github+json", "application/vnd.github.diff"]).toContain(
    headers.get("accept"),
  );

  expect(headers.get("x-github-api-version")).toBe("2022-11-28");
}

/** A fetch that serves JSON by method and path and records every call. Unmatched requests fail the test. */
export function createStubFetch(routes: Route[], origin = "https://api.github.test") {
  const calls: StubRequest[] = [];
  const dispatch = createRouter(
    routes.map((r) => ({
      ...r,
      handler: (req: StubRequest) => {
        calls.push(req);
        return r.handler(req);
      },
    })),
  );

  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { url, incoming } = incomingFromFetch(input, init, origin);
    if (url.origin === origin) {
      expectApi(url, init?.method, incoming.headers);
    } else {
      expectExternal(url, incoming.headers, routes);
    }

    expect(incoming.headers.get("user-agent")).toBeTruthy();
    const served = await dispatch(incoming);
    if (!served) {
      throw new Error(`stub: no route for ${incoming.method} ${incoming.path}${url.search}`);
    }

    return toResponse(served.reply);
  }) as typeof fetch;

  return {
    fetch: stub,
    calls,
    called: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}
