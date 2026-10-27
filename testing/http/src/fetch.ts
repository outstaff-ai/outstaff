import type { Incoming } from "./types.js";

const urlOf = (input: string | URL | Request) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const rawOf = (body: unknown): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array();

/** A fetch call as a stand-in request. `path` is `<origin><path>` when the call leaves `origin`. */
export function incomingFromFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  origin: string,
): { url: URL; incoming: Incoming } {
  const url = urlOf(input);
  const body = init?.body;
  const path = url.origin === origin ? url.pathname : `${url.origin}${url.pathname}`;
  return {
    url,
    incoming: {
      method: (init?.method ?? "GET").toUpperCase(),
      path: decodeURIComponent(path),
      query: url.searchParams,
      headers: new Headers(init?.headers),
      json: typeof body === "string" ? JSON.parse(body) : undefined,
      raw: rawOf(body),
      ...(body instanceof FormData ? { form: body } : {}),
    },
  };
}
