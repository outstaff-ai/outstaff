import { describe, expect, it } from "vitest";
import { ItsaplanHttp } from "../http.js";
import { Pacer, type Clock } from "../pacing.js";

const clock: Clock = { now: () => 1_000_000, sleep: async () => {} };

const httpFor = (reply: () => Response) =>
  new ItsaplanHttp({
    fetch: (async () => reply()) as unknown as typeof fetch,
    apiUrl: "https://api.tracker.acme.example",
    webUrl: "https://tracker.acme.example",
    apiKey: "key-http",
    pacer: new Pacer(clock),
    clock,
  });

const failure = async (reply: () => Response) => {
  const error = await httpFor(reply)
    .request("POST", "/issues", { body: {} })
    .then(
      () => undefined,
      (e: unknown) => e as Error & { code: string; retryAfterMs?: number },
    );

  expect(error).toBeDefined();
  return error!;
};

describe("error mapping", () => {
  it("honours Retry-After on a 429, in seconds", async () => {
    const error = await failure(
      () => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }),
    );

    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 3_000 });
  });

  it("falls back to 30 seconds when Retry-After is missing, zero or not a number", async () => {
    for (const headers of [{}, { "retry-after": "0" }, { "retry-after": "soon" }]) {
      const error = await failure(() => new Response("", { status: 429, headers }));
      expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
    }
  });

  it("quotes the API's error text and code", async () => {
    const error = await failure(
      () =>
        new Response(JSON.stringify({ error: "Title is required", code: "E_TITLE" }), {
          status: 422,
        }),
    );

    expect(error.code).toBe("invalid");
    expect(error.message).toBe("Its a Plan POST /issues -> 422 E_TITLE: Title is required");
    expect(error.retryAfterMs).toBeUndefined();
  });

  it("quotes the start of a body that is not JSON, and the status text when there is no body", async () => {
    const text = await failure(() => new Response("x".repeat(300), { status: 502 }));
    expect(text.code).toBe("unavailable");
    expect(text.message).toBe(`Its a Plan POST /issues -> 502: ${"x".repeat(200)}`);

    const empty = await failure(() => new Response("", { status: 409, statusText: "Conflict" }));

    expect(empty).toMatchObject({ code: "conflict" });
    expect(empty.message).toBe("Its a Plan POST /issues -> 409: Conflict");
  });
});

describe("successful answers", () => {
  it("returns undefined for an empty body and for one that is not JSON", async () => {
    expect(await httpFor(() => new Response(null, { status: 204 })).request("DELETE", "/x")).toBe(
      undefined,
    );

    expect(await httpFor(() => new Response("<html>")).request("GET", "/x")).toBe(undefined);
  });
});
