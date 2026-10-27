import { createRouter, incomingFromFetch, toResponse } from "@outstaff/testing.http";
import { expect } from "vitest";
import type { Route, StubRequest } from "./types.js";

export const API_ORIGIN = "https://api.tracker.acme.example";
export const API_KEY = "key-sam";

/** A fetch that serves JSON by method and path and records every call. Unmatched requests fail the test. */
export function createStubFetch(routes: Route[], origin = API_ORIGIN, apiKey = API_KEY) {
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
    expect(url.origin, "requests must stay on the API host").toBe(origin);
    expect(
      incoming.headers.get("x-api-key"),
      `${init?.method} ${url.pathname} is unauthenticated`,
    ).toBe(apiKey);

    expect(incoming.headers.get("origin")).toBeTruthy();
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
